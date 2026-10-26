import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRuntime, type DurableJobReference, type RuntimeOptions, type SessionSnapshot } from "@pie/runtime";
import { completeToolHistory } from "@pie/runtime/session-tree";
import { createToolExecutionRecord } from "@pie/runtime/tool-execution";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { jobAgents, jobDefinition, persistentJobs } from "./fixtures/durable-job-host.ts";

const cleanups = new WeakMap<TestContext, (() => Promise<void>)[]>();

async function workspace(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-durable-jobs-"));
	const resources: (() => Promise<void>)[] = [];
	cleanups.set(context, resources);
	context.after(async () => {
		for (const close of resources.reverse()) await close();
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

async function crash(context: TestContext, boundary = "submitted") {
	const directory = await workspace(context);
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--conditions=source",
			fileURLToPath(new URL("./fixtures/durable-job-crash.ts", import.meta.url)),
			directory,
			boundary,
		],
		{ timeout: 30000, encoding: "utf8" },
	);
	return { directory, reference: JSON.parse(stdout.trim()) as DurableJobReference };
}

async function start(context: TestContext, directory: string, overrides: Partial<RuntimeOptions> = {}) {
	const local = openStore({ PI_DATA_DIR: directory, PI_TURN_RECOVERY: "manual" });
	const jobs = persistentJobs(directory);
	let created = 0;
	const store = createSqliteRuntimeStore(local);
	const runtime = await createRuntime({
		store,
		agents: jobAgents(() => {
			created++;
		}),
		jobs: jobs.executor,
		hostRuntimes: [jobDefinition],
		...overrides,
	});
	cleanups.get(context)!.push(async () => {
		await runtime.close();
		jobs.close();
	});
	return {
		runtime,
		local,
		jobs,
		store,
		get created() {
			return created;
		},
	};
}

async function until<Result>(read: () => Promise<Result | undefined>): Promise<Result> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(5);
	}
	throw new Error("Timed out waiting for durable job state");
}

test("a new instance queries a running job and consumes its persisted result once without notifications or resubmission", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory);
	const before = host.local.readSession(reference.sessionId)!;
	assert.equal(before.turn?.status, "interrupted");
	assert.equal(before.turnCheckpoint?.jobs?.[0].id, reference.id);
	const initialJournal = host.local.readToolExecutions(reference.sessionId, { turnId: reference.turnId, limit: 200 });
	assert.deepEqual(
		initialJournal.entries.map((entry) => entry.phase),
		["started", "submission_intent"],
	);
	assert(initialJournal.entries.every((entry) => entry.toolCallId === reference.toolCallId));
	assert.equal(initialJournal.entries.at(-1)?.externalId, reference.id);
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }), /仍在运行/);
	assert.equal(host.created, 0);
	assert.deepEqual(host.local.readSession(reference.sessionId), before);
	host.jobs.update(reference, {
		status: "completed",
		result: { content: [{ type: "text", text: "durable result" }], details: { artifact: "kept" } },
	});
	const attempts = await Promise.allSettled([
		host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }),
		host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }),
	]);
	assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
	const completed = await host.runtime.waitForTurn(reference.sessionId);
	assert.equal(completed.turn?.status, "completed");
	assert.equal(completed.turn.id, reference.turnId);
	assert.equal(completed.turn.requestId, "request");
	const results = completed.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 1);
	assert.equal(results[0].toolCallId, reference.toolCallId);
	assert.equal(results[0].isError, false);
	assert.equal(host.jobs.submissions, 1);
	assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
	assert.equal(host.local.readSession(reference.sessionId)?.turnCheckpoint, undefined);
	const journal = await host.runtime.readToolExecutions(reference.sessionId, { turnId: reference.turnId, limit: 200 });
	assert.deepEqual(
		journal.entries.map((entry) => entry.phase),
		["started", "submission_intent", "completed"],
	);
	assert.equal(new Set(journal.entries.map((entry) => entry.executionId)).size, 1);
	assert(journal.entries.every((entry) => entry.mode === "durable"));
	assert.equal("toolExecutions" in completed, false);
});

for (const status of ["failed", "cancelled"] as const) {
	test(`recovery consumes a known ${status} job result as a tool error instead of restarting the task`, async (context) => {
		const { directory, reference } = await crash(context);
		const host = await start(context, directory);
		host.jobs.update(reference, { status, error: `external ${status}` });
		await host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId });
		const snapshot = await host.runtime.waitForTurn(reference.sessionId);
		assert.equal(snapshot.turn?.status, "completed");
		const journal = host.local.readToolExecutions(reference.sessionId, { turnId: reference.turnId, limit: 200 });
		assert.equal(journal.entries.at(-1)?.phase, "failed");
		const result = snapshot.messages.find((message) => message.role === "toolResult");
		assert.equal(result?.isError, true);
		assert.equal(host.jobs.submissions, 1);
	});
}

test("missing, unknown, mismatched and unreadable job results never mutate the Turn or construct an Agent", async (context) => {
	const { directory, reference } = await crash(context, "before-submit");
	const host = await start(context, directory);
	const before = host.local.readSession(reference.sessionId);
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }), /不存在/);
	await host.jobs.executor.submit({ ...reference, arguments: { value: "effect" } });
	for (const fields of [
		{ status: "unknown" as const },
		{ status: "completed" as const },
		{ status: "completed" as const, sessionId: "another", result: { content: [], details: {} } },
	]) {
		host.jobs.update(reference, fields);
		await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }));
		assert.deepEqual(host.local.readSession(reference.sessionId), before);
	}
	host.jobs.executor.get = async () => {
		throw new Error("executor unavailable");
	};
	await assert.rejects(
		host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }),
		/executor unavailable/,
	);
	assert.equal(host.created, 0);
	assert.equal(host.jobs.submissions, 1);
});

test("a failed recovery commit does not append a result or launch the model and can recover after restart", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory);
	host.jobs.update(reference, {
		status: "completed",
		result: { content: [{ type: "text", text: "done" }], details: {} },
	});
	const before = host.local.readSession(reference.sessionId);
	const save = host.store.saveSession;
	host.store.saveSession = async () => {
		throw new Error("commit failed");
	};
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }), /commit failed/);
	assert.deepEqual(host.local.readSession(reference.sessionId), before);
	assert.equal(
		host.local.readPath(reference.sessionId).nodes.filter((node) => node.message.role === "toolResult").length,
		0,
	);
	host.store.saveSession = save;
	await host.runtime.close();
	const next = await start(context, directory);
	await next.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId });
	assert.equal((await next.runtime.waitForTurn(reference.sessionId)).turn?.status, "completed");
	assert.equal(next.jobs.submissions, 1);
});

for (const sessionRetention of ["retain", "release-after-turn"] as const) {
	test(`closing detaches external work without cancelling it with ${sessionRetention}`, async (context) => {
		const directory = await workspace(context);
		const first = await start(context, directory, { sessionRetention });
		const session = await first.runtime.createSession({ assistantId: "assistant" });
		const accepted = await first.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
		const reference = await until(async () =>
			first.jobs.submissions ? first.local.readSession(session.id)?.turnCheckpoint?.jobs?.[0] : undefined,
		);
		await first.runtime.close();
		assert.equal((await first.jobs.executor.get(reference))?.status, "running");
		const next = await start(context, directory, { sessionRetention });
		assert.equal(next.local.readSession(session.id)?.turn?.status, "interrupted");
		assert.equal(
			next.local.readPath(session.id).nodes.filter((node) => node.message.role === "toolResult").length,
			0,
		);
		next.jobs.update(reference, {
			status: "completed",
			result: { content: [{ type: "text", text: "finished elsewhere" }], details: {} },
		});
		await next.runtime.resumeTurn(session.id, { turnId: accepted.turnId });
		assert.equal((await next.runtime.waitForTurn(session.id)).turn?.status, "completed");
		assert.equal(next.jobs.submissions, 1);
	});
}

test("normal completion and explicit cancellation preserve tool result semantics", async (context) => {
	const directory = await workspace(context);
	const host = await start(context, directory);
	for (const cancel of [false, true]) {
		const session = await host.runtime.createSession({ assistantId: "assistant" });
		const accepted = await host.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
		const reference = await until(async () => {
			const reference = host.local.readSession(session.id)?.turnCheckpoint?.jobs?.[0];
			return reference && (await host.jobs.executor.get(reference)) ? reference : undefined;
		});
		if (cancel) await host.runtime.cancelTurn(session.id, { turnId: accepted.turnId });
		else
			host.jobs.update(reference, {
				status: "completed",
				result: { content: [{ type: "text", text: "normal result" }], details: {} },
			});
		const snapshot: SessionSnapshot = await host.runtime.waitForTurn(session.id);
		assert.equal(snapshot.turn?.status, cancel ? "cancelled" : "completed");
		assert.equal(completeToolHistory(host.local.readPath(session.id).nodes.map((node) => node.message)), true);
		assert.equal(snapshot.messages.filter((message) => message.role === "toolResult").length, 1);
	}
});

test("shutdown detaches job waiting even when the host tool omits its optional abort signal", async (context) => {
	const directory = await workspace(context);
	const host = await start(context, directory, { agents: jobAgents(undefined, false) });
	const session = await host.runtime.createSession({ assistantId: "assistant" });
	await host.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
	const reference = await until(async () =>
		host.jobs.submissions ? host.local.readSession(session.id)?.turnCheckpoint?.jobs?.[0] : undefined,
	);
	const closing = host.runtime.close();
	try {
		await Promise.race([
			closing,
			delay(3000).then(() => {
				throw new Error("shutdown did not detach job waiting");
			}),
		]);
		assert.equal((await host.jobs.executor.get(reference))?.status, "running");
	} finally {
		host.jobs.update(reference, { status: "cancelled" });
		await closing;
	}
});

test("a slow external cancellation cannot advance the model while its acknowledgement is pending", async (context) => {
	const directory = await workspace(context);
	const host = await start(context, directory);
	const session = await host.runtime.createSession({ assistantId: "assistant" });
	const accepted = await host.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
	const reference = await until(async () =>
		host.jobs.submissions ? host.local.readSession(session.id)?.turnCheckpoint?.jobs?.[0] : undefined,
	);
	let entered = false;
	let acknowledge!: () => void;
	const acknowledgement = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	host.jobs.executor.cancel = async () => {
		entered = true;
		await acknowledgement;
	};
	const cancellation = host.runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	try {
		await until(async () => (entered ? true : undefined));
		host.jobs.update(reference, {
			status: "completed",
			result: { content: [{ type: "text", text: "completed during cancellation" }], details: {} },
		});
		await until(async () => (host.local.readSession(session.id)?.turn?.status === "cancelled" ? true : undefined));
		const messages = host.local.readPath(session.id).nodes.map((node) => node.message);
		assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
		assert.equal(completeToolHistory(messages), true);
		assert.equal(host.jobs.submissions, 1);
	} finally {
		acknowledge();
		await cancellation;
	}
});

test("submission acknowledgement and query failures retain the original job without fake tool results", async (context) => {
	const directory = await workspace(context);
	const host = await start(context, directory);
	const submit = host.jobs.executor.submit;
	host.jobs.executor.submit = async (...args) => {
		await submit(...args);
		throw new Error("acknowledgement lost");
	};
	const session = await host.runtime.createSession({ assistantId: "assistant" });
	const accepted = await host.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
	const snapshot = await host.runtime.waitForTurn(session.id);
	assert.equal(snapshot.turn?.status, "interrupted");
	assert.equal(snapshot.messages.filter((message) => message.role === "toolResult").length, 0);
	const reference = host.local.readSession(session.id)!.turnCheckpoint!.jobs![0];
	const uncertain = host.local.readToolExecutions(session.id, { turnId: accepted.turnId, limit: 200 });
	assert.deepEqual(
		uncertain.entries.map((entry) => entry.phase),
		["started", "submission_intent", "recovery_required"],
	);
	assert.equal((await host.jobs.executor.get(reference))?.status, "running");
	host.jobs.executor.submit = submit;
	host.jobs.update(reference, {
		status: "completed",
		result: { content: [{ type: "text", text: "result after lost acknowledgement" }], details: {} },
	});
	await host.runtime.resumeTurn(session.id, { turnId: accepted.turnId });
	assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(host.jobs.submissions, 1);
	const next = await host.runtime.createSession({ assistantId: "assistant" });
	const get = host.jobs.executor.get;
	host.jobs.executor.get = async () => {
		throw new Error("query unavailable");
	};
	await host.runtime.submitTurn(next.id, { text: '调用工具 remote {"value":"effect"}' });
	assert.equal((await host.runtime.waitForTurn(next.id)).turn?.status, "interrupted");
	assert.equal(host.local.readPath(next.id).nodes.filter((node) => node.message.role === "toolResult").length, 0);
	host.jobs.executor.get = get;
});

test("job references must commit before submission and a rejected write never calls the executor", async (context) => {
	const directory = await workspace(context);
	const host = await start(context, directory);
	const session = await host.runtime.createSession({ assistantId: "assistant" });
	const save = host.store.saveSession;
	host.store.saveSession = async (...args) => {
		if (args[0].turnCheckpoint?.jobs?.length) throw new Error("job reference commit rejected");
		return save(...args);
	};
	await host.runtime.submitTurn(session.id, { text: '调用工具 remote {"value":"effect"}' });
	await host.runtime.waitForTurn(session.id);
	assert.equal(host.jobs.submissions, 0);
	assert.equal(host.local.readSession(session.id)?.turnCheckpoint?.jobs, undefined);
	assert.equal(host.local.readPath(session.id).nodes.filter((node) => node.message.role === "toolResult").length, 0);
});

test("cancelling a cold job persists intent before requesting cancellation and closes its tool history without an Agent", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory);
	const cancel = host.jobs.executor.cancel;
	host.jobs.executor.cancel = async (job) => {
		assert.equal(host.local.readSession(reference.sessionId)?.turnCheckpoint?.cancelRequested, true);
		await cancel(job);
	};
	await host.runtime.cancelTurn(reference.sessionId, { turnId: reference.turnId });
	const snapshot = await host.runtime.getSession(reference.sessionId);
	assert.equal(snapshot.turn?.status, "cancelled");
	assert.equal(completeToolHistory(host.local.readPath(reference.sessionId).nodes.map((node) => node.message)), true);
	assert.equal(host.created, 0);
	assert.equal(host.jobs.submissions, 1);
});

test("recovery refuses a terminal journal fact without its atomic history result before querying the executor", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory);
	const before = host.local.readSession(reference.sessionId);
	const read = host.store.readToolExecutions;
	let queried = 0;
	host.jobs.executor.get = async () => {
		queried++;
		return undefined;
	};
	host.store.readToolExecutions = async (...args) => {
		const page = await read(...args);
		page.entries.push({
			...createToolExecutionRecord({ ...reference, mode: "durable", phase: "completed", externalId: reference.id }),
			seq: 100,
		});
		return page;
	};
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }), /账本与历史/);
	assert.equal(host.created, 0);
	assert.equal(queried, 0);
	assert.deepEqual(host.local.readSession(reference.sessionId), before);
});

test("a missing job executor blocks recovery without changing history", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory, { jobs: undefined });
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }), /未配置/);
	assert.equal(host.created, 0);
	assert.equal(host.local.readSession(reference.sessionId)?.turn?.status, "interrupted");
});

test("a cancellation request failure preserves durable intent and can be retried without constructing an Agent", async (context) => {
	const { directory, reference } = await crash(context);
	const host = await start(context, directory);
	const cancel = host.jobs.executor.cancel;
	host.jobs.executor.cancel = async () => {
		throw new Error("cancel unavailable");
	};
	await assert.rejects(
		host.runtime.cancelTurn(reference.sessionId, { turnId: reference.turnId }),
		/cancel unavailable/,
	);
	assert.equal(host.local.readSession(reference.sessionId)?.turnCheckpoint?.cancelRequested, true);
	await assert.rejects(host.runtime.resumeTurn(reference.sessionId, { turnId: reference.turnId }));
	host.jobs.executor.cancel = cancel;
	await host.runtime.cancelTurn(reference.sessionId, { turnId: reference.turnId });
	assert.equal(host.created, 0);
	assert.equal(host.local.readSession(reference.sessionId)?.turn?.status, "cancelled");
});

test("a crash after cancel intent preserves the external task identity without claiming its side effects stopped", async (context) => {
	const { directory, reference } = await crash(context);
	const local = openStore({ PI_DATA_DIR: directory, PI_TURN_RECOVERY: "manual" });
	const saved = local.readSession(reference.sessionId)!;
	saved.turn = { ...saved.turn!, status: "running" };
	saved.turnCheckpoint!.cancelRequested = true;
	local.saveSession({ ...saved, messages: [], tree: { nodes: [], leafId: saved.leafId } });
	local.close();
	const host = await start(context, directory);
	assert.equal(host.local.readSession(reference.sessionId)?.turn?.status, "cancelled");
	const snapshot = await host.runtime.getSession(reference.sessionId);
	assert.equal(completeToolHistory(host.local.readPath(reference.sessionId).nodes.map((node) => node.message)), true);
	const result = snapshot.messages.find((message) => message.role === "toolResult");
	assert(result?.details && typeof result.details === "object");
	const task: unknown = Reflect.get(result.details, "durableJob");
	assert(task && typeof task === "object");
	assert.equal(Reflect.get(task, "id"), reference.id);
	assert.equal(Reflect.get(task, "status"), "unknown");
	assert.equal((await host.jobs.executor.get(reference))?.status, "running");
	assert.equal(host.created, 0);
});
