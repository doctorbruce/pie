import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAgentFactory } from "@pie/local";
import { createRuntime, RuntimeError, type RuntimeOptions, type TurnCheckpoint } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

async function crash(context: TestContext, boundary: string) {
	const directory = await mkdtemp(join(tmpdir(), "pie-turn-recovery-"));
	const resources: { close(): Promise<void> }[] = [];
	context.after(async () => {
		for (const resource of resources.reverse()) await resource.close();
		await rm(directory, { recursive: true, force: true });
	});
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--conditions=source", fileURLToPath(new URL("./fixtures/turn-crash.ts", import.meta.url)), directory, boundary],
		{ timeout: 30000, encoding: "utf8" },
	);
	const identity = JSON.parse(stdout.trim()) as {
		sessionId: string;
		turnId: string;
		requestId: string;
		checkpoint: TurnCheckpoint;
	};
	assert.equal(identity.checkpoint.version, 1);
	assert.equal(identity.checkpoint.turnId, identity.turnId);
	return {
		...identity,
		directory,
		resources,
		environment: { PI_DATA_DIR: directory, PI_TOOLS_DIR: directory, PI_TURN_RECOVERY: "manual" },
	};
}

async function start(saved: Awaited<ReturnType<typeof crash>>) {
	const core = createCoreServer(saved.environment);
	saved.resources.push(core);
	await core.ready;
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return {
		...core,
		post: (path: string, body: unknown) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
	};
}

test("HTTP explicitly resumes a committed input once with the same Turn and no duplicate user message", async (context) => {
	const saved = await crash(context, "user");
	const core = await start(saved);
	const runtime = await core.ready;
	const restored = await runtime.getSession(saved.sessionId);
	assert.equal(restored.turn?.status, "interrupted");
	assert.equal(restored.messages.length, 1);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: "wrong" })).status, 409);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/turns`, { text: "do not replace" })).status, 409);
	const responses = await Promise.all([
		core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId }),
		core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId }),
	]);
	assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
	const completed = await runtime.waitForTurn(saved.sessionId);
	assert.equal(completed.turn?.id, saved.turnId);
	assert.equal(completed.turn.requestId, saved.requestId);
	assert.equal(completed.turn.status, "completed");
	assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
	assert.equal((await runtime.listSessionMetadata())[0].turnCheckpoint, undefined);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/turns`, { text: "next turn" })).status, 202);
	assert.equal((await runtime.waitForTurn(saved.sessionId)).turn?.status, "completed");
});

test("recovery continues after committed tool output without executing the file mutation again", async (context) => {
	const saved = await crash(context, "tool-result");
	const effect = join(saved.directory, "effect.txt");
	assert.equal(await readFile(effect, "utf8"), "original effect");
	await writeFile(effect, "changed after crash");
	const core = await start(saved);
	const runtime = await core.ready;
	const before = await runtime.readHistory(saved.sessionId, { limit: 50 });
	assert.equal(before.entries.length, 3);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 202);
	const completed = await runtime.waitForTurn(saved.sessionId);
	assert.equal(completed.turn?.status, "completed");
	assert.equal(await readFile(effect, "utf8"), "changed after crash");
	assert.equal(completed.messages.filter((message) => message.role === "toolResult").length, 1);
	const after = await runtime.readHistory(saved.sessionId, { limit: 50 });
	assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
});

test("a committed final assistant response only settles the Turn after restart", async (context) => {
	const saved = await crash(context, "assistant");
	const core = await start(saved);
	const runtime = await core.ready;
	const snapshot = await runtime.getSession(saved.sessionId);
	assert.equal(snapshot.turn?.id, saved.turnId);
	assert.equal(snapshot.turn.status, "completed");
	assert.equal(snapshot.messages.length, 4);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
	assert.deepEqual((await runtime.getSession(saved.sessionId)).messages, snapshot.messages);
});

test("an early-call checkpoint survives a crash without fabricating canonical history or replaying effects", async (context) => {
	const saved = await crash(context, "early-tool-call");
	const call = saved.checkpoint.pendingAssistant?.content.find((part) => part.type === "toolCall");
	assert(call?.type === "toolCall");
	const core = await start(saved);
	const runtime = await core.ready;
	const snapshot = await runtime.getSession(saved.sessionId);
	assert.equal(snapshot.turn?.status, "failed");
	assert.match(snapshot.turn.error ?? "", /模型响应尚未完成/);
	assert.equal(snapshot.messages.length, 1);
	assert.equal(snapshot.messages[0].role, "user");
	const journal = await runtime.readToolExecutions(saved.sessionId, { turnId: saved.turnId, limit: 200 });
	assert(journal.entries.some((record) => record.toolCallId === call.id && record.phase === "started"));
	assert.equal(
		journal.entries.some((record) => record.phase === "completed"),
		false,
	);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
	await assert.rejects(access(join(saved.directory, "effect.txt")));
});

test("a missing tool result is repaired as unknown, not dispatched on resume", async (context) => {
	const saved = await crash(context, "tool-call");
	const core = await start(saved);
	const snapshot = await (await core.ready).getSession(saved.sessionId);
	assert.equal(snapshot.turn?.status, "failed");
	assert.match(snapshot.turn.error ?? "", /结果未知/);
	const result = snapshot.messages.at(-1);
	assert.equal(result?.role, "toolResult");
	assert(result?.role === "toolResult" && result.isError);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
	await assert.rejects(access(join(saved.directory, "effect.txt")));
});

for (const checkpoint of ["missing", "off-branch"] as const) {
	test(`startup rejects a ${checkpoint} input checkpoint without blocking service or replaying tools`, async (context) => {
		const saved = await crash(context, "tool-call");
		const database = new DatabaseSync(join(saved.directory, "agent.sqlite"));
		try {
			if (checkpoint === "off-branch")
				database
					.prepare("INSERT INTO session_entries VALUES (?, ?, NULL, ?, ?)")
					.run(
						saved.sessionId,
						checkpoint,
						3,
						JSON.stringify({ role: "user", content: "another branch", timestamp: 1 }),
					);
			database
				.prepare("UPDATE sessions SET payload = json_set(payload, '$.turnCheckpoint.inputEntryId', ?) WHERE id = ?")
				.run(checkpoint, saved.sessionId);
		} finally {
			database.close();
		}
		const core = await start(saved);
		const runtime = await core.ready;
		const snapshot = await runtime.getSession(saved.sessionId);
		assert.equal(snapshot.turn?.id, saved.turnId);
		assert.equal(snapshot.turn.status, "failed");
		assert.match(snapshot.turn.error ?? "", /路径/);
		assert.equal(snapshot.messages.filter((message) => message.role === "toolResult").length, 1);
		const result = snapshot.messages.at(-1);
		assert(result?.role === "toolResult" && result.isError);
		assert.equal((await runtime.listSessionMetadata())[0].turnCheckpoint, undefined);
		assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
		await assert.rejects(access(join(saved.directory, "effect.txt")));
		await core.close();
		const restarted = await start(saved);
		const restored = await restarted.ready;
		assert.deepEqual((await restored.getSession(saved.sessionId)).messages, snapshot.messages);
		assert.equal((await restored.getSession(saved.sessionId)).revision, snapshot.revision);
		assert.equal(
			(await restarted.post(`/sessions/${saved.sessionId}/turns`, { text: "continue normally" })).status,
			202,
		);
		assert.equal((await restored.waitForTurn(saved.sessionId)).turn?.status, "completed");
		await assert.rejects(access(join(saved.directory, "effect.txt")));
	});
}

test("resume refuses an invalid Turn path before creating an Agent or changing durable state", async (context) => {
	const saved = await crash(context, "user");
	const store = createSqliteRuntimeStore(openStore(saved.environment));
	const factory = createAgentFactory(saved.environment);
	const create = context.mock.method(factory, "create");
	const runtime = await createRuntime({ store, agents: factory });
	saved.resources.push(runtime);
	const before = await store.readSession(saved.sessionId);
	assert.equal(before?.turn?.status, "interrupted");
	store.readTurnPath = async () => ({ leafId: before!.leafId, nodes: [] });
	await assert.rejects(
		runtime.resumeTurn(saved.sessionId, { turnId: saved.turnId }),
		(error: unknown) => error instanceof RuntimeError && error.status === 409 && /路径/.test(error.message),
	);
	assert.equal(create.mock.callCount(), 0);
	assert.deepEqual(await store.readSession(saved.sessionId), before);
	const failure = new Error("history read unavailable");
	store.readTurnPath = async () => {
		throw failure;
	};
	await assert.rejects(runtime.resumeTurn(saved.sessionId, { turnId: saved.turnId }), failure);
	assert.equal(create.mock.callCount(), 0);
	assert.deepEqual(await store.readSession(saved.sessionId), before);
});

test("an interrupted Turn can be durably cancelled without constructing or running an Agent", async (context) => {
	const saved = await crash(context, "user");
	const core = await start(saved);
	assert.equal((await core.post(`/sessions/${saved.sessionId}/cancel`, { turnId: saved.turnId })).status, 202);
	const snapshot = await (await core.ready).getSession(saved.sessionId);
	assert.equal(snapshot.turn?.status, "cancelled");
	assert.equal(snapshot.messages.length, 1);
	await core.close();
	const restarted = await start(saved);
	assert.equal((await (await restarted.ready).getSession(saved.sessionId)).turn?.status, "cancelled");
	assert.equal((await restarted.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
});

test("a cancellation persisted before process exit cannot be resumed after restart", async (context) => {
	const saved = await crash(context, "cancel");
	assert.equal(saved.checkpoint.cancelRequested, true);
	const core = await start(saved);
	assert.equal((await (await core.ready).getSession(saved.sessionId)).turn?.status, "cancelled");
	assert.equal((await core.post(`/sessions/${saved.sessionId}/resume`, { turnId: saved.turnId })).status, 409);
});

test("local recovery remains opt-in so existing hosts can start a new Turn after interruption", async (context) => {
	const saved = await crash(context, "user");
	saved.environment.PI_TURN_RECOVERY = "";
	const core = await start(saved);
	const runtime = await core.ready;
	assert.equal((await runtime.getSession(saved.sessionId)).turn?.status, "failed");
	assert.equal((await core.post(`/sessions/${saved.sessionId}/turns`, { text: "continue normally" })).status, 202);
	assert.equal((await runtime.waitForTurn(saved.sessionId)).turn?.status, "completed");
});

for (const retention of ["retain", "release-after-turn"] as const) {
	test(`recovery keeps original prompt and configuration with ${retention}`, async (context) => {
		const saved = await crash(context, "user");
		const local = openStore(saved.environment);
		const factory = createAgentFactory(saved.environment);
		const created: ReturnType<typeof factory.create>[] = [];
		const runtime = await createRuntime({
			store: createSqliteRuntimeStore(local),
			sessionRetention: retention,
			hostRuntimes: local.hostRuntimes,
			agents: {
				...factory,
				create(...args: Parameters<typeof factory.create>) {
					const agent = factory.create(...args);
					created.push(agent);
					return agent;
				},
			},
		});
		saved.resources.push(runtime);
		await runtime.registerHostRuntimes([
			{
				assistantId: "assistant",
				assistantRevision: "next",
				runtime: { systemPrompt: "next prompt", toolIds: [], skills: [], subagents: [] },
			},
		]);
		await runtime.resumeTurn(saved.sessionId, { turnId: saved.turnId });
		assert.equal(created.length, 1);
		assert.equal(created[0].state.systemPrompt, saved.checkpoint.systemPrompt);
		assert.match(created[0].state.systemPrompt, /original dynamic prompt/);
		assert.doesNotMatch(created[0].state.systemPrompt, /next prompt/);
		const completed = await runtime.waitForTurn(saved.sessionId);
		assert.equal(completed.assistantRevision, "original");
		assert.deepEqual(completed.runtime?.toolIds, ["write"]);
		await runtime.submitTurn(saved.sessionId, { text: "next turn" });
		assert.equal((await runtime.waitForTurn(saved.sessionId)).assistantRevision, "next");
	});
}

test("a failed recovery admission never calls the model and retains the interrupted durable state", async (context) => {
	const saved = await crash(context, "user");
	const store = createSqliteRuntimeStore(openStore(saved.environment));
	const factory = createAgentFactory(saved.environment);
	let events = 0;
	const options: RuntimeOptions = { store, agents: factory };
	const runtime = await createRuntime(options);
	saved.resources.push(runtime);
	await runtime.subscribe(saved.sessionId, () => {
		events++;
	});
	store.saveSession = async () => {
		throw new Error("admission rejected");
	};
	await assert.rejects(runtime.resumeTurn(saved.sessionId, { turnId: saved.turnId }), /admission rejected/);
	assert.equal(events, 0);
	assert.equal((await runtime.getSession(saved.sessionId)).turn?.status, "interrupted");
	assert.equal((await store.readSession(saved.sessionId))?.turn?.status, "interrupted");
	await assert.rejects(runtime.resumeTurn(saved.sessionId, { turnId: saved.turnId }), /存储不可用/);
});
