import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAgentFactory, createSqliteRuntimeStore, openStore } from "@pie/local";
import { createRuntime } from "@pie/runtime";
import type { BackgroundJobs } from "@pie/runtime/jobs";

async function until(read: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (await read()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for background work");
}

function call(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

async function fixture(context: TestContext, workerCompletes = false) {
	const directory = await mkdtemp(join(tmpdir(), "pie-background-cancel-"));
	const script = join(directory, "work.cjs");
	await writeFile(
		script,
		'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);',
	);
	const command = (pidPath: string) =>
		`${process.platform === "win32" ? "& " : ""}'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${pidPath.replaceAll("'", "'\\''")}'`;
	const plans = new Map<string, AssistantMessage[]>();
	const waiting = new Set<string>();
	const requests = new Map<string, number>();
	const workerPid = join(directory, "worker.pid");
	let jobs: BackgroundJobs | undefined;
	const factory = createAgentFactory({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = await createRuntime({
		store,
		agents: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				const id = args[1];
				jobs = args[9]?.jobs;
				if (args[2].systemPrompt === "worker") {
					plans.set(id, [
						call("bash", { command: command(workerPid), yieldMs: 0 }),
						...(workerCompletes ? [fauxAssistantMessage("done")] : []),
					]);
				}
				agent.streamFunction = (_model, _context, options) => {
					requests.set(id, (requests.get(id) ?? 0) + 1);
					const stream = createAssistantMessageEventStream();
					const message = plans.get(id)?.shift();
					if (message) {
						assert(message.stopReason === "toolUse" || message.stopReason === "stop");
						stream.push({ type: "done", reason: message.stopReason, message });
					} else {
						waiting.add(id);
						const abort = () =>
							stream.push({
								type: "error",
								reason: "aborted",
								error: fauxAssistantMessage("", { stopReason: "aborted" }),
							});
						if (options?.signal?.aborted) abort();
						else options?.signal?.addEventListener("abort", abort, { once: true });
					}
					return stream;
				};
				return agent;
			},
		},
		hostRuntimes: [
			{
				assistantId: "worker",
				assistantRevision: "1",
				runtime: {
					systemPrompt: "worker",
					toolIds: ["bash"],
					skills: [],
					subagents: [],
					permissions: { "*": "allow" },
				},
			},
			{
				assistantId: "parent",
				assistantRevision: "1",
				runtime: {
					systemPrompt: "parent",
					toolIds: ["bash"],
					skills: [],
					subagents: [{ id: "worker", name: "Worker", description: "Run work", assistantId: "worker" }],
					permissions: { "*": "allow" },
				},
			},
		],
	});
	context.after(async () => {
		await runtime.close();
		await Promise.all(jobs?.list().map((job) => jobs!.wait(job.id)) ?? []);
		await rm(directory, { recursive: true, force: true });
	});
	async function pid(path: string) {
		await until(async () =>
			readFile(path, "utf8").then(
				() => true,
				() => false,
			),
		);
		return Number(await readFile(path, "utf8"));
	}
	return { runtime, store, directory, command, plans, waiting, requests, workerPid, pid };
}

test(
	"cancelling an active Turn stops its detached shell before settlement without waking the model",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const pidPath = join(host.directory, "shell.pid");
		host.plans.set(session.id, [call("bash", { command: host.command(pidPath), yieldMs: 1 })]);
		const turn = await host.runtime.submitTurn(session.id, { text: "start shell" });
		await until(async () => host.waiting.has(session.id));
		const processId = await host.pid(pidPath);
		await host.runtime.cancelTurn(session.id, { turnId: turn.turnId });
		const settled = await host.runtime.waitForTurn(session.id);
		assert.equal(settled.turn?.status, "cancelled");
		assert.equal((await host.runtime.listBackgroundJobs(session.id)).jobs[0].status, "cancelled");
		assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
		assert.equal((await host.runtime.getSession(session.id)).turn?.id, turn.turnId);
		assert.equal(host.requests.get(session.id), 2);
		assert.equal((await host.runtime.cancelTurn(session.id, { turnId: turn.turnId })).accepted, false);
	},
);

test(
	"normal completion preserves jobs and cancelling a later Turn leaves earlier and other-session jobs alive",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const oldPidPath = join(host.directory, "old.pid");
		host.plans.set(session.id, [
			call("bash", { command: host.command(oldPidPath), yieldMs: 0 }),
			fauxAssistantMessage("done"),
		]);
		const oldTurn = await host.runtime.submitTurn(session.id, { text: "old shell" });
		assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "completed");
		const oldPid = await host.pid(oldPidPath);
		assert.equal((await host.runtime.listBackgroundJobs(session.id)).jobs[0].status, "running");
		const other = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const otherPidPath = join(host.directory, "other.pid");
		host.plans.set(other.id, [
			call("bash", { command: host.command(otherPidPath), yieldMs: 0 }),
			fauxAssistantMessage("done"),
		]);
		await host.runtime.submitTurn(other.id, { text: "other shell" });
		await host.runtime.waitForTurn(other.id);
		const otherPid = await host.pid(otherPidPath);
		const newPidPath = join(host.directory, "new.pid");
		host.plans.set(session.id, [call("bash", { command: host.command(newPidPath), yieldMs: 0 })]);
		const current = await host.runtime.submitTurn(session.id, { text: "new shell" });
		await until(async () => host.waiting.has(session.id));
		const newPid = await host.pid(newPidPath);
		await assert.rejects(host.runtime.cancelTurn(session.id, { turnId: oldTurn.turnId }), { status: 409 });
		assert.doesNotThrow(() => process.kill(newPid, 0));
		await host.runtime.cancelTurn(session.id, { turnId: current.turnId });
		await host.runtime.waitForTurn(session.id);
		const jobs = (await host.runtime.listBackgroundJobs(session.id)).jobs;
		assert.deepEqual(
			jobs.map((job) => job.status),
			["running", "cancelled"],
		);
		assert.throws(() => process.kill(newPid, 0), { code: "ESRCH" });
		assert.doesNotThrow(() => process.kill(oldPid, 0));
		assert.doesNotThrow(() => process.kill(otherPid, 0));
	},
);

for (const workerCompletes of [false, true]) {
	test(
		`parent cancellation stops child background work after its Task ${workerCompletes ? "completes" : "detaches"}`,
		{ timeout: 15000 },
		async (context) => {
			const host = await fixture(context, workerCompletes);
			const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
			host.plans.set(session.id, [
				call("task", {
					description: "Child work",
					prompt: "start",
					subagent_type: "worker",
					background: !workerCompletes,
				}),
			]);
			const turn = await host.runtime.submitTurn(session.id, { text: "delegate" });
			await until(async () => host.waiting.has(session.id));
			const child = (await host.runtime.listSessions({ includeSubagents: true })).sessions.find(
				(entry) => entry.kind === "subagent",
			);
			assert(child);
			if (workerCompletes) assert.equal((await host.runtime.waitForTurn(child.id)).turn?.status, "completed");
			else await until(async () => host.waiting.has(child.id));
			const processId = await host.pid(host.workerPid);
			assert.equal((await host.runtime.listBackgroundJobs(child.id)).jobs[0].status, "running");
			await host.runtime.cancelTurn(session.id, { turnId: turn.turnId });
			assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "cancelled");
			assert.equal((await host.runtime.listBackgroundJobs(child.id)).jobs[0].status, "cancelled");
			assert.equal(
				(await host.runtime.getSession(child.id)).turn?.status,
				workerCompletes ? "completed" : "cancelled",
			);
			assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
			assert.equal((await host.runtime.getSession(session.id)).turn?.id, turn.turnId);
			assert.equal(host.requests.get(session.id), 2);
		},
	);
}

test(
	"host stop cleans up a completed Turn's shell without cancelling another session or waking the model",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const other = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const pidPath = join(host.directory, "stopped.pid");
		const otherPidPath = join(host.directory, "preserved.pid");
		for (const [owner, path] of [
			[session, pidPath],
			[other, otherPidPath],
		] as const) {
			host.plans.set(owner.id, [
				call("bash", { command: host.command(path), yieldMs: 0 }),
				fauxAssistantMessage("done"),
			]);
			await host.runtime.submitTurn(owner.id, { text: "start shell" });
			assert.equal((await host.runtime.waitForTurn(owner.id)).turn?.status, "completed");
		}
		const processId = await host.pid(pidPath);
		const otherPid = await host.pid(otherPidPath);
		const observed = await host.runtime.listBackgroundJobs(session.id);
		const receipt = await host.runtime.cancelBackgroundJob(session.id, {
			instanceId: observed.instanceId,
			jobId: observed.jobs[0].id,
			executionId: observed.jobs[0].executionId,
		});
		assert.equal(receipt.job.status, "cancelled");
		assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
		assert.doesNotThrow(() => process.kill(otherPid, 0));
		assert.equal((await host.runtime.getSession(session.id)).turn?.status, "completed");
		assert.equal(host.requests.get(session.id), 2);
	},
);

test("host stop of a detached Task waits for its child Turn and shell cleanup", { timeout: 15000 }, async (context) => {
	const host = await fixture(context);
	const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
	host.plans.set(session.id, [
		call("task", { description: "Detached child", prompt: "start", subagent_type: "worker", background: true }),
		fauxAssistantMessage("done"),
	]);
	await host.runtime.submitTurn(session.id, { text: "delegate" });
	assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "completed");
	const child = (await host.runtime.listSessions({ includeSubagents: true })).sessions.find(
		(entry) => entry.kind === "subagent",
	);
	assert(child);
	await until(async () => host.waiting.has(child.id));
	const processId = await host.pid(host.workerPid);
	const observed = await host.runtime.listBackgroundJobs(session.id);
	const receipt = await host.runtime.cancelBackgroundJob(session.id, {
		instanceId: observed.instanceId,
		jobId: child.id,
		executionId: observed.jobs.find((job) => job.id === child.id)!.executionId,
	});
	assert.equal(receipt.job.status, "cancelled");
	assert.equal((await host.runtime.getSession(child.id)).turn?.status, "cancelled");
	assert.equal((await host.runtime.listBackgroundJobs(child.id)).jobs[0].status, "cancelled");
	assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
	assert.equal((await host.runtime.getSession(session.id)).turn?.status, "completed");
	assert.equal(host.requests.get(session.id), 2);
});

test("cancellation racing with child admission never starts the child's work", { timeout: 15000 }, async (context) => {
	const host = await fixture(context);
	let entered = () => {};
	let release = () => {};
	const saving = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	context.after(release);
	const save = host.store.saveSession;
	let pending = true;
	context.mock.method(host.store, "saveSession", async (...args: Parameters<typeof save>) => {
		if (pending && args[0].kind === "subagent") {
			pending = false;
			entered();
			await blocked;
		}
		return save(...args);
	});
	const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
	host.plans.set(session.id, [
		call("task", { description: "Late child", prompt: "start", subagent_type: "worker", background: true }),
	]);
	const turn = await host.runtime.submitTurn(session.id, { text: "delegate" });
	try {
		await saving;
		await host.runtime.cancelTurn(session.id, { turnId: turn.turnId });
		assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "cancelled");
	} finally {
		release();
	}
	await until(async () =>
		(await host.runtime.listSessions({ includeSubagents: true })).sessions.some(
			(entry) => entry.kind === "subagent" && entry.turn?.status === "cancelled",
		),
	);
	const child = (await host.runtime.listSessions({ includeSubagents: true })).sessions.find(
		(entry) => entry.kind === "subagent",
	);
	assert(child);
	assert.equal(host.requests.get(child.id) ?? 0, 0);
	assert.deepEqual((await host.runtime.listBackgroundJobs(child.id)).jobs, []);
	await assert.rejects(readFile(host.workerPid), { code: "ENOENT" });
	assert.equal((await host.runtime.getSession(session.id)).turn?.id, turn.turnId);
});
