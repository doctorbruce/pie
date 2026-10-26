import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SavedSession } from "@pie/runtime";
import { syncMessageTree } from "@pie/runtime/session-tree";
import { createToolExecutionRecord } from "@pie/runtime/tool-execution";
import { openStore } from "../../local/src/store.ts";

async function workspace() {
	const directory = await mkdtemp(join(tmpdir(), "pie-tool-execution-"));
	return { PI_DATA_DIR: directory };
}

function session(id = "session", turnId = "turn"): SavedSession {
	return {
		id,
		kind: "root",
		assistantId: "assistant",
		runtimeSource: "host",
		title: "Journal",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		messages: [{ role: "user", content: "input", timestamp: 1 }],
		turn: { id: turnId, status: "running" },
	};
}

test("SQLite journal is append-only, scoped, cursor-paged and retained after checkpoint removal and restart", async (context) => {
	const env = await workspace();
	let store = openStore(env);
	context.after(async () => {
		store.close();
		await rm(env.PI_DATA_DIR, { recursive: true, force: true });
	});
	const saved = session();
	saved.tree = syncMessageTree(undefined, saved.messages);
	const started = createToolExecutionRecord({
		sessionId: saved.id,
		turnId: "turn",
		toolCallId: "call",
		toolName: "echo",
		mode: "inline",
		phase: "started",
	});
	const completed = createToolExecutionRecord({ ...started, phase: "completed" });
	store.saveSession(saved, false, [started, completed]);
	store.saveSession(saved, false, [started, completed]);
	assert.equal(store.readToolExecutions(saved.id, { turnId: "turn", limit: 200 }).entries.length, 2);
	assert.throws(() => store.saveSession(saved, false, [{ ...started, toolName: "another" }]), /冲突/);
	assert.throws(() => store.saveSession(saved, false, [{ ...started, sessionId: "another" }]), /身份/);
	const page = store.readToolExecutions(saved.id, { turnId: "turn", limit: 1 });
	assert.equal(page.entries[0].phase, "started");
	assert.equal(page.nextAfterSeq, page.entries[0].seq);
	const next = store.readToolExecutions(saved.id, { turnId: "turn", limit: 1, afterSeq: page.nextAfterSeq! });
	assert.equal(next.entries[0].phase, "completed");
	assert.equal(next.nextAfterSeq, null);
	assert.deepEqual(store.readToolExecutions("other", { turnId: "turn", limit: 1 }).entries, []);
	assert.deepEqual(store.readToolExecutions(saved.id, { turnId: "other", limit: 1 }).entries, []);
	for (const limit of [0, 201, NaN, 1.5])
		assert.throws(() => store.readToolExecutions(saved.id, { turnId: "turn", limit }));
	for (const afterSeq of [-1, NaN, 1.5])
		assert.throws(() => store.readToolExecutions(saved.id, { turnId: "turn", limit: 1, afterSeq }));
	saved.turn = { id: "turn", status: "completed" };
	store.saveSession(saved);
	saved.turn = { id: "next-turn", status: "completed" };
	store.saveSession(saved);
	store.close();
	store = openStore(env);
	assert.equal(store.readSession(saved.id)?.turn?.id, "next-turn");
	assert.equal(store.readToolExecutions(saved.id, { turnId: "turn", limit: 200 }).entries.length, 2);
	assert.equal("toolExecutions" in store.readSession(saved.id)!, false);
	store.deleteSession(saved.id);
	assert.deepEqual(store.readToolExecutions(saved.id, { turnId: "turn", limit: 200 }).entries, []);
});

test("a rejected journal append rolls back history and Turn metadata in the same SQLite transaction", async (context) => {
	const env = await workspace();
	let store = openStore(env);
	context.after(async () => {
		store.close();
		await rm(env.PI_DATA_DIR, { recursive: true, force: true });
	});
	const saved = session();
	saved.turn = { id: "turn", status: "completed" };
	saved.tree = syncMessageTree(undefined, saved.messages);
	store.saveSession(saved);
	const before = store.readSession(saved.id);
	const history = store.readPath(saved.id);
	store.close();
	const db = new DatabaseSync(join(env.PI_DATA_DIR, "agent.sqlite"));
	db.exec(
		"CREATE TRIGGER reject_journal BEFORE INSERT ON tool_execution_journal BEGIN SELECT RAISE(ABORT, 'journal disk failure'); END;",
	);
	db.close();
	store = openStore(env);
	saved.messages.push({
		role: "toolResult",
		toolCallId: "call",
		toolName: "echo",
		content: [],
		isError: false,
		timestamp: 2,
	});
	saved.tree = syncMessageTree(saved.tree, saved.messages);
	saved.title = "must roll back";
	const record = createToolExecutionRecord({
		sessionId: saved.id,
		turnId: "turn",
		toolCallId: "call",
		toolName: "echo",
		mode: "inline",
		phase: "completed",
	});
	assert.throws(() => store.saveSession(saved, false, [record]), /journal disk failure/);
	assert.deepEqual(store.readSession(saved.id), before);
	assert.deepEqual(store.readPath(saved.id), history);
	assert.deepEqual(store.readToolExecutions(saved.id, { turnId: "turn", limit: 200 }).entries, []);
	assert.equal(saved.tree.nodes.at(-1)?.seq, undefined);
});
