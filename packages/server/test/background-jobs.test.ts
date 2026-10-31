import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createAgentFactory, createSqliteRuntimeStore, openStore } from "@pie/local";
import { createRuntime } from "@pie/runtime";
import { type BackgroundJobList, BackgroundJobs } from "@pie/runtime/jobs";
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

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-background-observation-"));
	const controls = new Map<string, { finish: () => void; cancel: () => void }>();
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
						parameters: toolContext.Type.Object({}),
						async execute() {
							let finish = () => {};
							const job = toolContext.jobs.start({
								ownerSessionId: toolContext.sessionId,
								type: "shell",
								title: "Controlled background work",
								details: { command: "PRIVATE_COMMAND", output: "PRIVATE_DETAILS" },
								async run(signal, append) {
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
									}
								},
							});
							controls.set(job.id, { finish, cancel: () => toolContext.jobs.cancel(job.id) });
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
	await runtime.submitTurn(shellSession.id, {
		text: `调用工具 job_kill ${JSON.stringify({ job_id: observed.jobs[0].id })}`,
	});
	await runtime.waitForTurn(shellSession.id);
	assert.equal((await runtime.listBackgroundJobs(shellSession.id)).jobs[0].status, "cancelled");
	await core.close();
	core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	base = await listen();
	const restoredResponse = await fetch(`${base}/sessions/${shellSession.id}/jobs`);
	assert.equal(restoredResponse.status, 200);
	const restored = (await restoredResponse.json()) as BackgroundJobList;
	assert.notEqual(restored.instanceId, observed.instanceId);
	assert.equal(restored.sessionId, shellSession.id);
	assert.deepEqual(restored.jobs, [], "process-local observations are not durable job history");
});
