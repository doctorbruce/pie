import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createAgentFactory, createSqliteRuntimeStore, openStore } from "@pie/local";
import { createRuntime } from "@pie/runtime";
import { type BackgroundJobCancellationReceipt, type BackgroundJobList, BackgroundJobs } from "@pie/runtime/jobs";
import type { HostRuntimeDefinition } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

const definition: HostRuntimeDefinition = {
	assistantId: "background-fixture",
	assistantRevision: "1",
	runtime: { systemPrompt: "", toolIds: ["start_job"], skills: [], subagents: [] },
};

test("job summaries bound display text without truncating the original result", async () => {
	const jobs = new BackgroundJobs();
	const title = "long title ".repeat(2000);
	const error = "long failure ".repeat(4000);
	const job = jobs.start({
		ownerSessionId: "owner",
		type: "shell",
		title,
		async run(_signal, append) {
			append("PRIVATE_OUTPUT");
			throw new Error(error);
		},
	});
	await jobs.wait(job.id);
	const summary = jobs.listSummaries("owner")[0];
	assert.equal(summary.status, "failed");
	assert.equal(summary.title, title.slice(0, 512));
	assert.equal(summary.error, error.slice(0, 2048));
	assert(!("output" in summary));
	assert(!("details" in summary));
	assert.equal(jobs.get(job.id)?.title, title);
	assert.equal(jobs.get(job.id)?.error, error);
	assert.equal(jobs.get(job.id)?.output, "PRIVATE_OUTPUT");
});

async function fixture(context: TestContext, cleanup?: Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "pie-background-observation-"));
	const controls = new Map<string, { finish: () => void; cancel: () => void; aborted: () => boolean }>();
	const agents = createAgentFactory(
		{ PI_DATA_DIR: directory },
		{
			tools: {
				catalog: [{ id: "start_job", label: "Start controlled work" }],
				create: (toolContext) => [
					{
						name: "start_job",
						label: "Start controlled work",
						description: "Start work that outlives its Turn.",
						parameters: toolContext.Type.Object({ id: toolContext.Type.Optional(toolContext.Type.String()) }),
						async execute(_callId, params) {
							const { id } = params as { id?: string };
							let finish = () => {};
							let jobSignal: AbortSignal | undefined;
							const job = toolContext.jobs.start({
								id,
								ownerSessionId: toolContext.sessionId,
								type: "shell",
								title: "Controlled background work",
								details: { command: "PRIVATE_COMMAND", output: "PRIVATE_DETAILS" },
								async run(signal, append) {
									jobSignal = signal;
									append("PRIVATE_OUTPUT");
									let abort = () => {};
									try {
										await new Promise<void>((resolve, reject) => {
											finish = resolve;
											abort = () => reject(new Error("Fixture stopped"));
											signal.addEventListener("abort", abort, { once: true });
											if (signal.aborted) abort();
										});
										return { details: { exit: 0 } };
									} finally {
										signal.removeEventListener("abort", abort);
										await cleanup;
									}
								},
							});
							controls.set(job.id, {
								finish,
								cancel: () => toolContext.jobs.cancel(job.id),
								aborted: () => jobSignal?.aborted === true,
							});
							return { content: [{ type: "text", text: job.id }], details: { background: true, jobId: job.id } };
						},
					},
				],
			},
		},
	);
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = await createRuntime({
		agents,
		store,
		hostRuntimes: [definition],
		sessionRetention: "release-after-turn",
	});
	context.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { runtime, store, controls };
}

test("SDK separates Turn settlement from directly owned background work without reading history", async (context) => {
	const { runtime, store, controls } = await fixture(context);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const other = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.submitTurn(session.id, { text: "调用工具 start_job {}" });
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(settled.turn?.status, "completed");
	const paths = context.mock.method(store, "readPath");
	const working = context.mock.method(store, "readWorkingPath");
	const history = context.mock.method(store, "readHistory");
	const tree = context.mock.method(store, "readTree");
	const observed = await runtime.listBackgroundJobs(session.id);
	assert.equal(observed.instanceId, session.instanceId);
	assert.equal(observed.sessionId, session.id);
	assert.equal(observed.jobs.length, 1);
	const job = observed.jobs[0];
	assert.equal(job.ownerSessionId, session.id);
	assert.equal(job.status, "running");
	assert.equal(job.type, "shell");
	assert.equal(JSON.stringify(observed).includes("PRIVATE"), false);
	assert(!("output" in job));
	assert(!("details" in job));
	assert.deepEqual((await runtime.listBackgroundJobs(other.id)).jobs, []);
	const cancelled = await runtime.cancelTurn(session.id, { turnId: settled.turn!.id });
	assert.equal(cancelled.accepted, false);
	assert.equal((await runtime.listBackgroundJobs(session.id)).jobs[0].status, "running");
	await assert.rejects(runtime.deleteSession(session.id), /后台任务/);
	assert.equal(paths.mock.callCount(), 0);
	assert.equal(working.mock.callCount(), 0);
	assert.equal(history.mock.callCount(), 0);
	assert.equal(tree.mock.callCount(), 0);
	job.title = "mutated by observer";
	assert.equal((await runtime.listBackgroundJobs(session.id)).jobs[0].title, "Controlled background work");
	controls.get(job.id)!.finish();
	for (let attempt = 0; attempt < 20; attempt++) {
		const current = (await runtime.listBackgroundJobs(session.id)).jobs[0];
		if (current.status !== "running") break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	const terminal = (await runtime.listBackgroundJobs(session.id)).jobs[0];
	assert.equal(terminal.status, "completed");
	assert(terminal.finishedAt !== undefined);
	assert.equal(observed.jobs[0].status, "running", "returned metadata is a detached observation");
	assert.deepEqual(await runtime.deleteSession(session.id), { deleted: true });
	await assert.rejects(runtime.listBackgroundJobs(session.id), /会话不存在/);
});

test("a child background job prevents deleting its otherwise settled parent", async (context) => {
	const { runtime, controls } = await fixture(context);
	await runtime.registerHostRuntimes([
		definition,
		{
			assistantId: "parent-fixture",
			assistantRevision: "1",
			runtime: {
				systemPrompt: "",
				toolIds: [],
				skills: [],
				permissions: { task: "allow" },
				subagents: [{ id: "worker", name: "Worker", description: "Run work", assistantId: definition.assistantId }],
			},
		},
	]);
	const parent = await runtime.createSession({ assistantId: "parent-fixture" });
	await runtime.submitTurn(parent.id, {
		text: `调用工具 task ${JSON.stringify({ description: "Spawn child work", prompt: "调用工具 start_job {}", subagent_type: "worker" })}`,
	});
	assert.equal((await runtime.waitForTurn(parent.id)).turn?.status, "completed");
	const child = (await runtime.listSessions({ includeSubagents: true })).sessions.find(
		(session) => session.kind === "subagent",
	);
	assert(child);
	assert.equal(child.turn?.status, "completed");
	await assert.rejects(runtime.deleteSession(parent.id), /子会话/);
	const rootJobs = await runtime.listBackgroundJobs(parent.id);
	assert(rootJobs.jobs.every((job) => job.ownerSessionId === parent.id));
	assert(rootJobs.jobs.every((job) => job.status === "completed"));
	const childJobs = await runtime.listBackgroundJobs(child.id);
	assert.equal(childJobs.jobs.length, 1);
	assert.equal(childJobs.jobs[0].status, "running");
	controls.get(childJobs.jobs[0].id)!.cancel();
	for (let attempt = 0; attempt < 20; attempt++) {
		if ((await runtime.listBackgroundJobs(child.id)).jobs[0].status !== "running") break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal((await runtime.listBackgroundJobs(child.id)).jobs[0].status, "cancelled");
	assert.deepEqual(await runtime.deleteSession(parent.id), { deleted: true });
});

test("host job stop bypasses blocked history and waits for cleanup without blocking other controls", async (context) => {
	let releaseCleanup = () => {};
	let releaseRead = () => {};
	let entered = () => {};
	const cleanup = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const { runtime, store, controls } = await fixture(context, cleanup);
	try {
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		await runtime.submitTurn(session.id, { text: "调用工具 start_job {}" });
		await runtime.waitForTurn(session.id);
		const observed = await runtime.listBackgroundJobs(session.id);
		const job = observed.jobs[0];
		const readPath = store.readPath;
		context.mock.method(store, "readPath", async (...args: Parameters<typeof readPath>) => {
			entered();
			await blocked;
			return readPath(...args);
		});
		const read = runtime.getSession(session.id);
		await reading;
		let settled = false;
		const stop = runtime
			.cancelBackgroundJob(session.id, {
				instanceId: observed.instanceId,
				jobId: job.id,
				executionId: job.executionId,
			})
			.then((receipt) => {
				settled = true;
				return receipt;
			});
		assert.equal(controls.get(job.id)!.aborted(), true, "abort is delivered without waiting for history or storage");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "receipt cannot claim cleanup before the job exits");
		releaseCleanup();
		const receipt = await stop;
		assert.equal(receipt.accepted, true);
		assert.equal(receipt.durable, false);
		assert.equal(receipt.job.status, "cancelled");
		assert.equal(JSON.stringify(receipt).includes("PRIVATE"), false);
		releaseRead();
		await read;
		assert.equal(
			(
				await runtime.cancelBackgroundJob(session.id, {
					instanceId: observed.instanceId,
					jobId: job.id,
					executionId: job.executionId,
				})
			).accepted,
			false,
		);
	} finally {
		releaseCleanup();
		releaseRead();
	}
});

test("a late host stop cannot cancel a new execution reusing the same job ID", async (context) => {
	const { runtime, controls } = await fixture(context);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.submitTurn(session.id, { text: '调用工具 start_job {"id":"continued-task"}' });
	await runtime.waitForTurn(session.id);
	const first = (await runtime.listBackgroundJobs(session.id)).jobs[0];
	controls.get(first.id)!.finish();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((await runtime.listBackgroundJobs(session.id)).jobs[0].status, "completed");
	await runtime.submitTurn(session.id, { text: '调用工具 start_job {"id":"continued-task"}' });
	await runtime.waitForTurn(session.id);
	const current = await runtime.listBackgroundJobs(session.id);
	const next = current.jobs[0];
	assert.equal(next.id, first.id);
	assert.notEqual(next.executionId, first.executionId);
	await assert.rejects(
		runtime.cancelBackgroundJob(session.id, {
			instanceId: current.instanceId,
			jobId: first.id,
			executionId: first.executionId,
		}),
		{ status: 409 },
	);
	assert.equal(controls.get(next.id)!.aborted(), false);
	const stopped = await runtime.cancelBackgroundJob(session.id, {
		instanceId: current.instanceId,
		jobId: next.id,
		executionId: next.executionId,
	});
	assert.equal(stopped.job.status, "cancelled");
});

test("host job stop remains available after persistence failure and cannot stop another session's work", async (context) => {
	const { runtime, store } = await fixture(context);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const other = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.submitTurn(session.id, { text: "调用工具 start_job {}" });
	await runtime.waitForTurn(session.id);
	const observed = await runtime.listBackgroundJobs(session.id);
	const jobId = observed.jobs[0].id;
	const executionId = observed.jobs[0].executionId;
	await assert.rejects(
		runtime.cancelBackgroundJob(other.id, { instanceId: observed.instanceId, jobId, executionId }),
		{
			status: 404,
		},
	);
	await assert.rejects(runtime.cancelBackgroundJob(session.id, { instanceId: "old-instance", jobId, executionId }), {
		status: 409,
	});
	assert.equal((await runtime.listBackgroundJobs(session.id)).jobs[0].status, "running");
	context.mock.method(store, "saveSession", async () => {
		throw new Error("disk unavailable");
	});
	await assert.rejects(runtime.renameSession(session.id, { title: "failure" }), { status: 503 });
	assert.equal(runtime.storageAvailable, false);
	const receipt = await runtime.cancelBackgroundJob(session.id, {
		instanceId: observed.instanceId,
		jobId,
		executionId,
	});
	assert.equal(receipt.job.status, "cancelled");
	assert.equal(receipt.durable, false);
});

test("HTTP exposes the same lightweight jobs as the SDK and resets observations after restart", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-background-http-"));
	let core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	context.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	async function listen() {
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let base = await listen();
	const runtime = await core.ready;
	const session = await runtime.createSession({});
	const empty = await fetch(`${base}/sessions/${session.id}/jobs`);
	assert.equal(empty.status, 200);
	const original = (await empty.json()) as BackgroundJobList;
	assert.deepEqual(original, await runtime.listBackgroundJobs(session.id));
	assert.deepEqual(original.jobs, []);
	assert.equal((await fetch(`${base}/sessions/missing/jobs`)).status, 404);
	await runtime.registerHostRuntimes([
		{
			assistantId: "shell-fixture",
			assistantRevision: "1",
			runtime: { systemPrompt: "", toolIds: ["bash"], skills: [], subagents: [], permissions: { "*": "allow" } },
		},
	]);
	const shellSession = await runtime.createSession({ assistantId: "shell-fixture", workspacePath: directory });
	const command =
		process.platform === "win32"
			? `& '${process.execPath.replaceAll("'", "''")}' -e "setInterval(() => {}, 1000)"`
			: `'${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'`;
	await runtime.submitTurn(shellSession.id, {
		text: `调用工具 bash ${JSON.stringify({ command, description: "Controlled shell", yieldMs: 0 })}`,
	});
	const settled = await runtime.waitForTurn(shellSession.id);
	assert.equal(settled.turn?.status, "completed");
	const jobsResponse = await fetch(`${base}/sessions/${shellSession.id}/jobs`);
	assert.equal(jobsResponse.status, 200);
	const observed = (await jobsResponse.json()) as BackgroundJobList;
	assert.equal(observed.jobs.length, 1);
	assert.equal(observed.jobs[0].status, "running");
	assert.deepEqual(observed, await runtime.listBackgroundJobs(shellSession.id));
	assert(!("details" in observed.jobs[0]));
	assert(!("output" in observed.jobs[0]));
	assert.equal((await runtime.cancelTurn(shellSession.id, { turnId: settled.turn!.id })).accepted, false);
	assert.equal((await runtime.listBackgroundJobs(shellSession.id)).jobs[0].status, "running");
	const stop = (sessionId: string, instanceId?: string) =>
		fetch(`${base}/sessions/${sessionId}/jobs/${observed.jobs[0].id}/cancel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instanceId, executionId: observed.jobs[0].executionId }),
		});
	assert.equal((await stop(shellSession.id)).status, 400);
	assert.equal((await stop(shellSession.id, "old-instance")).status, 409);
	assert.equal((await stop(session.id, observed.instanceId)).status, 404);
	const unavailable = context.mock.getter(runtime, "storageAvailable", () => false);
	const stopped = await stop(shellSession.id, observed.instanceId);
	unavailable.mock.restore();
	assert.equal(stopped.status, 202);
	const stoppedJob = (await stopped.json()) as BackgroundJobCancellationReceipt;
	assert.equal(stoppedJob.accepted, true);
	assert.equal(stoppedJob.job.status, "cancelled");
	assert.equal(
		(await runtime.getSession(shellSession.id)).turn?.id,
		settled.turn?.id,
		"host stop does not start a Turn",
	);
	assert.equal(
		((await (await stop(shellSession.id, observed.instanceId)).json()) as BackgroundJobCancellationReceipt).accepted,
		false,
	);
	await runtime.submitTurn(shellSession.id, {
		text: `调用工具 bash ${JSON.stringify({ command, description: "Second controlled shell", yieldMs: 0 })}`,
	});
	await runtime.waitForTurn(shellSession.id);
	const secondJob = (await runtime.listBackgroundJobs(shellSession.id)).jobs.find((job) => job.status === "running");
	assert(secondJob);
	await runtime.submitTurn(shellSession.id, {
		text: `调用工具 job_kill ${JSON.stringify({ job_id: secondJob.id })}`,
	});
	await runtime.waitForTurn(shellSession.id);
	assert.equal(
		(await runtime.listBackgroundJobs(shellSession.id)).jobs.find((job) => job.id === secondJob.id)?.status,
		"cancelled",
	);
	await core.close();
	core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	base = await listen();
	const restoredResponse = await fetch(`${base}/sessions/${shellSession.id}/jobs`);
	assert.equal(restoredResponse.status, 200);
	const restored = (await restoredResponse.json()) as BackgroundJobList;
	assert.notEqual(restored.instanceId, observed.instanceId);
	assert.equal(restored.sessionId, shellSession.id);
	assert.deepEqual(restored.jobs, [], "process-local observations are not durable job history");
	assert.equal((await stop(shellSession.id, observed.instanceId)).status, 409);
});
