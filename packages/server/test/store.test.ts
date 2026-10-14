import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionSnapshot, SessionTransfer } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";
import { exportSession, transferToAgentMessages } from "../src/session-transfer.ts";
import { type MessageTree, syncMessageTree } from "../src/session-tree.ts";
import { openStore, type SavedSession, type SessionMetadata } from "../src/store.ts";

function user(content: string, timestamp = 1): AgentMessage {
	return { role: "user", content, timestamp };
}

function session(id: string, messages: AgentMessage[]): SavedSession {
	return {
		id,
		kind: "root",
		assistantId: "assistant",
		runtimeSource: "local",
		title: id,
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		messages,
	};
}

async function directory(context: TestContext) {
	const path = await mkdtemp(join(tmpdir(), "pie-store-"));
	context.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function database(path: string, action: (db: DatabaseSync) => void) {
	const db = new DatabaseSync(join(path, "agent.sqlite"));
	try {
		action(db);
	} finally {
		db.close();
	}
}

function legacy(path: string, saved: SavedSession[]) {
	database(path, (db) => {
		db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, payload TEXT NOT NULL)");
		for (const value of saved)
			db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(value.id, value.assistantId, JSON.stringify(value));
	});
}

async function settled(base: string, id: string): Promise<SessionSnapshot> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const snapshot = (await (await fetch(`${base}/sessions/${id}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") return snapshot;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("turn did not settle");
}

test("legacy migration preserves node IDs, alternate branches, imported originals and checkpoints", async (context) => {
	const path = await directory(context);
	const transfer: SessionTransfer = {
		schemaVersion: 1,
		source: { astronSessionId: "astron", coreId: "source", sessionId: "source" },
		transcript: [
			{
				id: "original-user",
				role: "user",
				content: [{ type: "file", mimeType: "image/png", uri: "data:image/png;base64,aGVsbG8=" }],
				metadata: { clientMessageId: "client", unknown: { retained: true } },
				createdAt: 1,
			},
			{
				id: "original-assistant",
				role: "assistant",
				content: [
					{
						type: "tool",
						tool: "read",
						callID: "call",
						state: { input: {}, output: "saved", status: "completed" },
					},
				],
				createdAt: 2,
			},
		],
	};
	const messages = transferToAgentMessages(transfer);
	const tree = syncMessageTree(undefined, messages);
	const ids = tree.nodes.map((node) => node.id);
	const alternate = syncMessageTree(tree, [messages[0], user("alternate", 3)]);
	const saved = session("imported", messages);
	saved.tree = { ...alternate, leafId: ids.at(-1)! };
	saved.transferBase = transfer.transcript;
	saved.transferBaseMessageCount = messages.length;
	saved.compaction = {
		summary: "checkpoint",
		firstKeptMessage: 1,
		tokensBefore: 20,
		estimatedTokensAfter: 10,
		compactedAt: 4,
		generation: 1,
	};
	legacy(path, [saved, session("without-tree", [user("old")])]);
	let store = openStore({ PI_DATA_DIR: path });
	try {
		assert(store.sessions.every((item) => !("messages" in item) && !("tree" in item) && !("transferBase" in item)));
		assert.deepEqual(
			store.readTree(saved.id).nodes.map((node) => node.id),
			alternate.nodes.map((node) => node.id),
		);
		assert.deepEqual(
			store.readPath(saved.id).nodes.map((node) => node.id),
			ids,
		);
		assert.equal(
			JSON.stringify(store.readPath(saved.id).nodes.map((node) => node.message)),
			JSON.stringify(messages),
		);
		assert.deepEqual(store.sessions.find((item) => item.id === saved.id)?.compaction, saved.compaction);
		assert.deepEqual(
			store.readPath("without-tree").nodes.map((node) => node.message),
			[user("old")],
		);
	} finally {
		store.close();
	}
	store = openStore({ PI_DATA_DIR: path });
	try {
		const metadata = store.sessions.find((item) => item.id === saved.id)!;
		const restored = store.readPath(saved.id);
		assert.deepEqual(
			exportSession({ ...metadata, messages: restored.nodes.map((node) => node.message) }).transcript,
			transfer.transcript,
		);
		assert.deepEqual(
			restored.nodes.map((node) => node.id),
			ids,
		);
	} finally {
		store.close();
	}
	database(path, (db) => {
		const metadata = JSON.parse(
			String(db.prepare("SELECT payload FROM sessions WHERE id = ?").get(saved.id)!.payload),
		) as SessionMetadata;
		assert.equal(metadata.leafId, ids.at(-1));
		assert(!("messages" in metadata));
		assert(!("transferBase" in metadata));
		assert.equal(
			db.prepare("SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?").get(saved.id)!.count,
			alternate.nodes.length,
		);
	});
});

test("a failed legacy migration rolls back its entries and leaves the original payload intact", async (context) => {
	const path = await directory(context);
	const broken = session("broken", [user("first"), user("second", 2)]);
	broken.tree = syncMessageTree(undefined, broken.messages);
	broken.tree.nodes[1].parentId = "missing";
	broken.tree.leafId = broken.tree.nodes[0].id;
	broken.messages = broken.messages.slice(0, 1);
	legacy(path, [broken]);
	assert.throws(() => openStore({ PI_DATA_DIR: path }), /父节点不存在/);
	database(path, (db) => {
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_entries").get()!.count, 0);
		assert.deepEqual(JSON.parse(String(db.prepare("SELECT payload FROM sessions").get()!.payload)), broken);
	});
});

test("legacy imported prefixes are attached to existing nodes without replacing their IDs", async (context) => {
	const path = await directory(context);
	const saved = session("prefix", [user("original")]);
	saved.tree = syncMessageTree(undefined, saved.messages);
	const nodeId = saved.tree.leafId;
	saved.transferBaseMessageCount = 1;
	saved.transferBase = [
		{
			id: "source-id",
			role: "user",
			content: [{ type: "text", text: "original", unknown: true }],
			metadata: { retained: true },
		},
	];
	legacy(path, [saved]);
	const store = openStore({ PI_DATA_DIR: path });
	try {
		const restored = store.readPath(saved.id);
		assert.equal(restored.leafId, nodeId);
		assert.equal(restored.nodes.length, 1);
		assert.deepEqual(Reflect.get(restored.nodes[0].message, "transferMessage"), saved.transferBase[0]);
	} finally {
		store.close();
	}
});

test("saving appends only new entries and metadata changes never rewrite historical bodies", async (context) => {
	const path = await directory(context);
	const saved = session("incremental", [user("first")]);
	saved.tree = syncMessageTree(undefined, saved.messages);
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	store.close();
	database(path, (db) => {
		db.exec(
			"CREATE TABLE writes (id TEXT); CREATE TRIGGER no_entry_updates BEFORE UPDATE ON session_entries BEGIN SELECT RAISE(ABORT, 'immutable'); END; CREATE TRIGGER track_entries AFTER INSERT ON session_entries BEGIN INSERT INTO writes VALUES (NEW.id); END;",
		);
	});
	store = openStore({ PI_DATA_DIR: path });
	try {
		saved.tree = store.readPath(saved.id);
		saved.messages = saved.tree.nodes.map((node) => node.message);
		Object.defineProperty(saved.tree.nodes[0].message, "toJSON", {
			value: () => {
				throw new Error("old body serialized");
			},
		});
		saved.title = "renamed";
		store.saveSession(saved);
		const next = { id: "new-entry", parentId: saved.tree.leafId, message: user("second", 2) };
		saved.tree.nodes.push(next);
		saved.tree.leafId = next.id;
		store.saveSession(saved);
		assert.equal(saved.tree.nodes[1].seq, 2);
		assert.equal(store.readTree(saved.id).nodes.length, 2);
	} finally {
		store.close();
	}
	database(path, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS count FROM writes").get()!.count, 1));
});

test("entry insertion and leaf/revision updates roll back together and can be retried", async (context) => {
	const path = await directory(context);
	const saved = session("atomic", [user("first")]);
	saved.tree = syncMessageTree(undefined, saved.messages);
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	store.close();
	database(path, (db) =>
		db.exec(
			"CREATE TRIGGER fail_metadata BEFORE UPDATE ON sessions WHEN json_extract(NEW.payload, '$.revision') = 2 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		),
	);
	store = openStore({ PI_DATA_DIR: path });
	try {
		const originalLeaf = saved.tree.leafId;
		const next: MessageTree["nodes"][number] = { id: "next", parentId: originalLeaf, message: user("second", 2) };
		saved.tree.nodes.push(next);
		saved.tree.leafId = next.id;
		saved.revision = 2;
		assert.throws(() => store.saveSession(saved), /disk failure/);
		assert.equal(next.seq, undefined);
		assert.equal(store.readTree(saved.id).nodes.length, 1);
		assert.equal(store.readPath(saved.id).leafId, originalLeaf);
		saved.revision = 3;
		store.saveSession(saved);
		assert.equal(next.seq, 2);
	} finally {
		store.close();
	}
	database(path, (db) =>
		assert.equal(
			(JSON.parse(String(db.prepare("SELECT payload FROM sessions").get()!.payload)) as SessionMetadata).revision,
			3,
		),
	);
});

test("history cursors follow parent links rather than including alternate branches", async (context) => {
	const path = await directory(context);
	const store = openStore({ PI_DATA_DIR: path });
	try {
		const saved = session("paged", [user("root"), user("old", 2)]);
		saved.tree = syncMessageTree(undefined, saved.messages);
		store.saveSession(saved);
		const oldLeaf = saved.tree.leafId;
		saved.messages = [saved.messages[0], user("new", 3), user("latest", 4)];
		saved.tree = syncMessageTree(saved.tree, saved.messages);
		store.saveSession(saved);
		const latest = store.readHistory(saved.id, { limit: 2 });
		assert.deepEqual(
			latest.entries.map((node) => node.seq),
			[3, 4],
		);
		assert.equal(latest.nextBeforeSeq, 3);
		const oldest = store.readHistory(saved.id, { limit: 2, beforeSeq: latest.nextBeforeSeq! });
		assert.deepEqual(
			oldest.entries.map((node) => node.seq),
			[1],
		);
		assert.equal(oldest.nextBeforeSeq, null);
		assert.deepEqual(
			store.readHistory(saved.id, { limit: 2, leafId: oldLeaf }).entries.map((node) => node.seq),
			[1, 2],
		);
		assert.throws(() => store.readHistory(saved.id, { limit: 0 }));
		assert.throws(() => store.readHistory(saved.id, { limit: 1, beforeSeq: 1.5 }));
	} finally {
		store.close();
	}
});

test("export retains imported originals and continuation IDs after restart without storing a duplicate prefix", async (context) => {
	const path = await directory(context);
	const transfer: SessionTransfer = {
		schemaVersion: 1,
		source: { astronSessionId: "astron", coreId: "source", sessionId: "source" },
		transcript: [
			{ id: "imported", role: "user", content: [{ type: "text", text: "original", extra: true }] },
			{
				id: "hidden-original",
				role: "user",
				content: [
					{ type: "text", text: '\n\n<turn_context scope="current_user_turn">original context</turn_context>' },
				],
			},
		],
	};
	const imported = transferToAgentMessages(transfer);
	const saved = session("continued", [...imported, user("continuation", 2)]);
	saved.transferBase = transfer.transcript;
	saved.transferBaseMessageCount = imported.length;
	saved.tree = syncMessageTree(undefined, saved.messages);
	const before = exportSession(saved).transcript;
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	store.close();
	store = openStore({ PI_DATA_DIR: path });
	try {
		const metadata = store.sessions[0];
		assert(!("transferBase" in metadata));
		assert.equal(metadata.transferBaseMessageCount, imported.length);
		assert.deepEqual(
			exportSession({ ...metadata, messages: store.readPath(saved.id).nodes.map((node) => node.message) })
				.transcript,
			before,
		);
	} finally {
		store.close();
	}
});

test("startup, a selected path and a limited page do not decode cold or off-page bodies", async (context) => {
	const path = await directory(context);
	let store = openStore({ PI_DATA_DIR: path });
	for (const id of ["hot", "cold"]) {
		const saved = session(id, [user("first"), user("second", 2)]);
		saved.tree = syncMessageTree(undefined, saved.messages);
		store.saveSession(saved);
	}
	store.close();
	database(path, (db) => {
		db.prepare("UPDATE session_entries SET payload = 'invalid JSON' WHERE session_id = ? OR seq = 1").run("cold");
	});
	store = openStore({ PI_DATA_DIR: path });
	try {
		assert.equal(store.sessions.length, 2);
		assert.deepEqual(
			store.readHistory("hot", { limit: 1 }).entries.map((node) => node.message),
			[user("second", 2)],
		);
		assert.throws(() => store.readPath("cold"), SyntaxError);
		store.deleteSession("cold");
	} finally {
		store.close();
	}
	database(path, (db) =>
		assert.equal(
			db.prepare("SELECT COUNT(*) AS count FROM session_entries WHERE session_id = 'cold'").get()!.count,
			0,
		),
	);
});

test("restart closes only active unmatched calls once, preserves background notices and never replays tools", async (context) => {
	const path = await directory(context);
	const messages = transferToAgentMessages({
		schemaVersion: 1,
		source: { astronSessionId: "astron", coreId: "source", sessionId: "source" },
		transcript: [
			{
				role: "assistant",
				content: [{ type: "tool", tool: "write", callID: "pending", state: { input: { path: "must-not-exist" } } }],
				createdAt: 1,
			},
		],
	}).slice(0, 1);
	const background = [{ type: "text" as const, text: "background done", synthetic: true }];
	messages.unshift({ role: "user", content: background, timestamp: 0 });
	const saved = session("interrupted", messages);
	saved.turn = { id: "turn", status: "running" };
	saved.tree = syncMessageTree(undefined, messages);
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	store.close();
	store = openStore({ PI_DATA_DIR: path });
	try {
		assert.equal(store.sessions[0].turn?.status, "failed");
		assert.equal(store.sessions[0].revision, 2);
		const recovered = store.readPath(saved.id).nodes.map((node) => node.message);
		assert.equal(JSON.stringify(recovered.slice(0, 2)), JSON.stringify(messages));
		const result = recovered[2];
		assert.equal(result.role, "toolResult");
		if (result.role === "toolResult") {
			assert.equal(result.isError, true);
			assert.equal(result.toolCallId, "pending");
			assert.match(JSON.stringify(result.content), /结果未知.*未自动重试/);
		}
	} finally {
		store.close();
	}
	store = openStore({ PI_DATA_DIR: path });
	try {
		assert.equal(store.readTree(saved.id).nodes.length, 3);
		assert.equal(store.sessions[0].revision, 2);
	} finally {
		store.close();
	}
});

test("session list and another session's read/turn do not hydrate cold history", async (context) => {
	const path = await directory(context);
	const store = openStore({ PI_DATA_DIR: path });
	try {
		for (const id of ["hot", "cold"]) {
			const saved = session(id, [user(id)]);
			saved.assistantId = store.assistants[0].id;
			store.saveSession(saved);
		}
	} finally {
		store.close();
	}
	database(path, (db) =>
		db.exec(
			"UPDATE session_entries SET payload = 'invalid JSON' WHERE session_id = 'cold'; CREATE TRIGGER immutable_entries BEFORE UPDATE ON session_entries BEGIN SELECT RAISE(ABORT, 'immutable'); END;",
		),
	);
	const core = createCoreServer({ PI_DATA_DIR: path });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	try {
		const address = core.server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const list = await fetch(`${base}/sessions`);
		assert.equal(list.status, 200);
		assert.equal(((await list.json()) as { sessions: unknown[] }).sessions.length, 2);
		const snapshot = (await (await fetch(`${base}/sessions/hot`)).json()) as SessionSnapshot;
		assert.deepEqual(snapshot.messages, [user("hot")]);
		assert.equal(
			(
				await fetch(`${base}/sessions/hot`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "renamed" }),
				})
			).status,
			200,
		);
		assert.equal(
			(
				await fetch(`${base}/sessions/hot/turns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: "continue" }),
				})
			).status,
			202,
		);
		const current = await settled(base, "hot");
		assert.equal(current.turn?.status, "completed");
		assert.equal(current.messages.length, 3);
		assert.equal((await fetch(`${base}/sessions/cold`, { method: "DELETE" })).status, 200);
	} finally {
		await core.close();
	}
});

test("replacing history rolls back on failure and removes the old branches only after commit", async (context) => {
	const path = await directory(context);
	const saved = session("replace", [user("old")]);
	saved.tree = syncMessageTree(undefined, saved.messages);
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	const oldId = saved.tree.leafId;
	store.close();
	database(path, (db) =>
		db.exec(
			"CREATE TRIGGER fail_replace BEFORE UPDATE ON sessions WHEN json_extract(NEW.payload, '$.revision') = 2 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		),
	);
	store = openStore({ PI_DATA_DIR: path });
	try {
		saved.messages = [user("new", 2)];
		saved.tree = syncMessageTree(undefined, saved.messages);
		saved.revision = 2;
		assert.throws(() => store.saveSession(saved, true), /disk failure/);
		assert.equal(store.readPath(saved.id).leafId, oldId);
		assert.equal(saved.tree.nodes[0].seq, undefined);
		saved.revision = 3;
		store.saveSession(saved, true);
		assert.equal(store.readTree(saved.id).nodes.length, 1);
		assert.equal(store.readPath(saved.id).nodes[0].seq, 2);
	} finally {
		store.close();
	}
});

test("failed turn persistence restores the live messages and leaves the durable tree and revision unchanged", async (context) => {
	const path = await directory(context);
	const store = openStore({ PI_DATA_DIR: path });
	try {
		const saved = session("rollback", [user("original")]);
		saved.assistantId = store.assistants[0].id;
		store.saveSession(saved);
	} finally {
		store.close();
	}
	database(path, (db) =>
		db.exec(
			"CREATE TRIGGER fail_turn BEFORE UPDATE ON sessions WHEN json_extract(NEW.payload, '$.turn.requestId') = 'reject' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		),
	);
	const core = createCoreServer({ PI_DATA_DIR: path });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	try {
		const address = core.server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		assert.equal(
			(
				await fetch(`${base}/sessions/rollback/turns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: "accepted" }),
				})
			).status,
			202,
		);
		const before = await settled(base, "rollback");
		assert.equal(before.turn?.status, "completed");
		const tree = await (await fetch(`${base}/sessions/rollback/tree`)).json();
		assert.equal(
			(
				await fetch(`${base}/sessions/rollback/turns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: "not saved", requestId: "reject" }),
				})
			).status,
			500,
		);
		const after = (await (await fetch(`${base}/sessions/rollback`)).json()) as SessionSnapshot;
		assert.deepEqual(after.messages, before.messages);
		assert.deepEqual(after.turn, before.turn);
		assert.equal(after.revision, before.revision);
		assert.deepEqual(await (await fetch(`${base}/sessions/rollback/tree`)).json(), tree);
	} finally {
		await core.close();
	}
});

test("recovering a running activity on an idle session does not load its message bodies", async (context) => {
	const path = await directory(context);
	const saved = session("activity", [user("cold")]);
	saved.activities = [
		{
			id: "activity",
			sessionId: saved.id,
			turnId: "old-turn",
			toolCallId: "call",
			kind: "skill_load",
			binding: { id: "skill", name: "skill", description: "skill", directory: path },
			status: "running",
			startedAt: 1,
		},
	];
	let store = openStore({ PI_DATA_DIR: path });
	store.saveSession(saved);
	store.close();
	database(path, (db) => db.exec("UPDATE session_entries SET payload = 'invalid JSON'"));
	store = openStore({ PI_DATA_DIR: path });
	try {
		const activity = store.sessions[0].activities?.[0];
		assert.equal(activity?.status, "unknown");
		assert.match(activity?.error ?? "", /未自动重试/);
		assert(activity?.finishedAt);
		assert.throws(() => store.readPath(saved.id), SyntaxError);
	} finally {
		store.close();
	}
});
