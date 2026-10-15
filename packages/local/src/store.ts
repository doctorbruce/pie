import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Assistant, ContextCompaction, HostRuntimeDefinition } from "@pie/runtime/protocol";
import type { RuntimeStore, SavedSession, SessionMetadata } from "@pie/runtime/runtime-store";
import { type MessageTree, syncMessageTree, treePath } from "@pie/runtime/session-tree";

export type { SavedSession, SessionMetadata } from "@pie/runtime/runtime-store";

export function openStore(env: NodeJS.ProcessEnv) {
	const directory = resolve(env.PI_DATA_DIR || ".pie");
	mkdirSync(directory, { recursive: true });
	const db = new DatabaseSync(join(directory, "agent.sqlite"));
	try {
		// One service owns this directory; the SQLite lock is released even after a process crash.
		db.exec("PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = DELETE;");
		db.exec("BEGIN EXCLUSIVE; COMMIT;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS host_runtimes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		`);
		if (db.prepare("PRAGMA foreign_key_list(sessions)").all().length > 0) {
			db.exec("PRAGMA foreign_keys = OFF");
			db.exec(`
				BEGIN IMMEDIATE;
				ALTER TABLE sessions RENAME TO sessions_with_assistant_fk;
				CREATE TABLE sessions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, payload TEXT NOT NULL);
				INSERT INTO sessions SELECT id, assistant_id, payload FROM sessions_with_assistant_fk;
				DROP TABLE sessions_with_assistant_fk;
				COMMIT;
			`);
			db.exec("PRAGMA foreign_keys = ON");
		}
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS session_entries (
				session_id TEXT NOT NULL,
				id TEXT NOT NULL,
				parent_id TEXT,
				seq INTEGER NOT NULL CHECK (seq > 0),
				payload TEXT NOT NULL,
				PRIMARY KEY (session_id, id),
				UNIQUE (session_id, seq),
				FOREIGN KEY (session_id, parent_id) REFERENCES session_entries(session_id, id)
					DEFERRABLE INITIALLY DEFERRED
			);
		`);
		const assistants = db
			.prepare("SELECT payload FROM assistants")
			.all()
			.map((row) => ({ pluginIds: [], subagentIds: [], ...JSON.parse(String(row.payload)) }) as Assistant);
		if (!assistants.length) {
			const now = Date.now();
			const assistant: Assistant = {
				id: randomUUID(),
				name: "默认助手",
				systemPrompt: "You are a helpful assistant. Reply in Chinese.",
				toolIds: [],
				pluginIds: [],
				subagentIds: [],
				createdAt: now,
				updatedAt: now,
			};
			db.prepare("INSERT INTO assistants VALUES (?, ?)").run(assistant.id, JSON.stringify(assistant));
			assistants.push(assistant);
		}
		const insertEntry = db.prepare("INSERT INTO session_entries VALUES (?, ?, ?, ?, ?)");
		const findEntry = db.prepare("SELECT seq FROM session_entries WHERE session_id = ? AND id = ?");
		const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_entries WHERE session_id = ?");
		const saveSession = (session: SavedSession, replaceHistory = false): SessionMetadata => {
			const { messages, tree: savedTree, transferBase: _transferBase, ...fields } = session;
			const tree = savedTree ?? syncMessageTree(undefined, messages);
			const metadata: SessionMetadata = { ...fields, leafId: tree.leafId };
			const pending = tree.nodes.filter((node) => node.seq === undefined);
			const committed: { node: MessageTree["nodes"][number]; seq: number }[] = [];
			db.exec("BEGIN IMMEDIATE");
			try {
				let seq = Number(maxSeq.get(session.id)!.seq);
				if (replaceHistory) db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(session.id);
				for (const node of pending) {
					if (node.parentId !== null && !findEntry.get(session.id, node.parentId))
						throw new Error("会话树父节点不存在");
					seq++;
					insertEntry.run(session.id, node.id, node.parentId, seq, JSON.stringify(node.message));
					committed.push({ node, seq });
				}
				if (tree.leafId !== null && !findEntry.get(session.id, tree.leafId)) throw new Error("会话树叶子不存在");
				db.prepare(
					"INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET assistant_id = excluded.assistant_id, payload = excluded.payload",
				).run(session.id, session.assistantId, JSON.stringify(metadata));
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			for (const { node, seq } of committed) node.seq = seq;
			return metadata;
		};
		const pathQuery = `WITH RECURSIVE path(id, parent_id, seq) AS (
			SELECT id, parent_id, seq FROM session_entries WHERE session_id = ? AND id = ?
			UNION ALL
			SELECT entry.id, entry.parent_id, entry.seq FROM session_entries entry
			JOIN path ON entry.id = path.parent_id WHERE entry.session_id = ?
		)`;
		const parseEntry = (row: Record<string, unknown>): MessageTree["nodes"][number] => ({
			id: String(row.id),
			parentId: row.parent_id === null ? null : String(row.parent_id),
			seq: Number(row.seq),
			message: JSON.parse(String(row.payload)) as AgentMessage,
		});
		const sessionLeaf = (id: string) => {
			const row = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id);
			if (!row) throw new Error("会话不存在");
			return (JSON.parse(String(row.payload)) as SessionMetadata).leafId;
		};
		const readPath = (id: string, leafId = sessionLeaf(id)): MessageTree => {
			const rows = db
				.prepare(`${pathQuery}
				SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
				WHERE entry.session_id = ? ORDER BY path.seq
			`)
				.all(id, leafId, id, id);
			if (leafId !== null && rows.length === 0) throw new Error("会话树叶子不存在");
			return { leafId, nodes: rows.map(parseEntry) };
		};
		const sessions: SessionMetadata[] = [];
		for (const row of db.prepare("SELECT payload FROM sessions").iterate()) {
			const saved = JSON.parse(String(row.payload)) as SavedSession & Partial<SessionMetadata>;
			if ("messages" in saved) {
				const path = saved.tree ? treePath(saved.tree) : [];
				let transferIndex = 0;
				for (const [index, message] of saved.messages.slice(0, saved.transferBaseMessageCount ?? 0).entries()) {
					if (message.role === "toolResult") continue;
					const original = saved.transferBase?.[transferIndex++];
					if (!original) continue;
					const node = path[index];
					if (node && JSON.stringify(node.message) === JSON.stringify(message))
						Object.assign(node.message, { id: original.id, transferMessage: structuredClone(original) });
					Object.assign(message, { id: original.id, transferMessage: structuredClone(original) });
				}
				saved.tree = syncMessageTree(saved.tree, saved.messages);
				sessions.push(saveSession(saved));
			} else {
				sessions.push(saved as SessionMetadata);
			}
		}
		const hostRuntimes = db
			.prepare("SELECT payload FROM host_runtimes")
			.all()
			.map((row) => JSON.parse(String(row.payload)) as HostRuntimeDefinition);
		for (const session of sessions) {
			if (session.assistant) {
				session.assistant.pluginIds ??= [];
				session.assistant.subagentIds ??= [];
			}
			session.kind ??= session.parentSessionId ? "subagent" : "root";
			if (session.runtime) session.runtime.subagents ??= [];
			session.runtimeSource ??= "local";
			if (session.runtimeSource === "local" && session.assistant)
				session.assistantRevision ??= String(session.assistant.updatedAt);
			let recoveredActivity = false;
			for (const activity of session.activities ?? []) {
				if (activity.status !== "running") continue;
				activity.status = "unknown";
				activity.finishedAt = Date.now();
				activity.error = "服务中断，技能加载结果未知；未自动重试。";
				recoveredActivity = true;
			}
			if (session.turn?.status !== "running") {
				if (recoveredActivity)
					db.prepare("UPDATE sessions SET payload = ? WHERE id = ?").run(JSON.stringify(session), session.id);
				continue;
			}
			const tree = readPath(session.id, session.leafId);
			const messages = tree.nodes.map((node) => node.message);
			session.turn = {
				...session.turn,
				status: "failed",
				error: "服务中断，本次执行未完成；工具可能已产生效果，请核对后继续。",
			};
			// Never replay tools after a crash. Close unmatched calls with an explicit unknown-outcome result.
			const results = new Set(
				messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			);
			for (const message of [...messages]) {
				if (message.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall" || results.has(part.id)) continue;
					const activity = session.activities?.find(
						(item) => item.turnId === session.turn?.id && item.toolCallId === part.id,
					);
					messages.push({
						role: "toolResult",
						toolCallId: part.id,
						toolName: part.name,
						content: [
							{
								type: "text",
								text:
									activity && activity.status !== "unknown"
										? "服务中断，技能记录已保存，原工具输出未保存；未自动重试。"
										: "服务中断，工具执行结果未知；未自动重试。",
							},
						],
						details: activity ? { activity } : undefined,
						isError: true,
						timestamp: Date.now(),
					});
					results.add(part.id);
				}
			}
			session.revision++;
			session.updatedAt = Date.now();
			Object.assign(session, saveSession({ ...session, messages, tree: syncMessageTree(tree, messages) }));
		}
		return {
			assistants,
			sessions,
			hostRuntimes,
			saveSession,
			readPath,
			readPathIds(id: string, leafId = sessionLeaf(id)): string[] {
				return db
					.prepare(`${pathQuery} SELECT id FROM path ORDER BY seq`)
					.all(id, leafId, id)
					.map((row) => String(row.id));
			},
			readWorkingPath(id: string, compaction?: ContextCompaction): MessageTree {
				if (!compaction?.firstKeptEntryId) return readPath(id);
				const leafId = sessionLeaf(id);
				const rows = db
					.prepare(`${pathQuery}
					SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
					WHERE entry.session_id = ? AND (
						path.seq >= (SELECT seq FROM path WHERE id = ?) OR path.id = ?
					) ORDER BY path.seq
				`)
					.all(id, leafId, id, id, compaction.firstKeptEntryId, compaction.turnStartEntryId ?? null);
				if (!rows.some((row) => row.id === compaction.firstKeptEntryId))
					throw new Error("压缩 checkpoint 不在当前分支");
				if (compaction.turnStartEntryId && !rows.some((row) => row.id === compaction.turnStartEntryId))
					throw new Error("压缩当前输入不在当前分支");
				return { leafId, nodes: rows.map(parseEntry) };
			},
			readTree(id: string): MessageTree {
				const leafId = sessionLeaf(id);
				return {
					leafId,
					nodes: db
						.prepare("SELECT * FROM session_entries WHERE session_id = ? ORDER BY seq")
						.all(id)
						.map(parseEntry),
				};
			},
			readHistory(id: string, options: { limit: number; beforeSeq?: number; leafId?: string | null }) {
				const { limit, beforeSeq = Number.MAX_SAFE_INTEGER, leafId = sessionLeaf(id) } = options;
				if (
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > 200 ||
					!Number.isSafeInteger(beforeSeq) ||
					beforeSeq < 1
				)
					throw new Error("历史分页需要 1–200 条及有效的 seq 游标");
				const rows = db
					.prepare(`${pathQuery}
					SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
					WHERE entry.session_id = ? AND path.seq < ? ORDER BY path.seq DESC LIMIT ?
				`)
					.all(id, leafId, id, id, beforeSeq, limit + 1);
				const entries = rows.slice(0, limit).reverse().map(parseEntry);
				return { entries, nextBeforeSeq: rows.length > limit ? entries[0].seq! : null };
			},
			replaceHostRuntimes(definitions: readonly HostRuntimeDefinition[]) {
				db.exec("BEGIN IMMEDIATE");
				try {
					db.exec("DELETE FROM host_runtimes");
					const insert = db.prepare("INSERT INTO host_runtimes VALUES (?, ?)");
					for (const definition of definitions) insert.run(definition.assistantId, JSON.stringify(definition));
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			saveAssistant(assistant: Assistant) {
				db.prepare(
					"INSERT INTO assistants VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
				).run(assistant.id, JSON.stringify(assistant));
			},
			deleteAssistant(id: string) {
				db.prepare("DELETE FROM assistants WHERE id = ?").run(id);
			},
			deleteSession(id: string) {
				db.exec("BEGIN IMMEDIATE");
				try {
					db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(id);
					db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			close() {
				db.close();
			},
		};
	} catch (error) {
		db.close();
		throw error;
	}
}

export function createSqliteRuntimeStore(store: ReturnType<typeof openStore>): RuntimeStore {
	return {
		persistence: "sqlite",
		loadSessions: async () => store.sessions,
		saveSession: async (...args) => store.saveSession(...args),
		readPath: async (...args) => store.readPath(...args),
		readPathIds: async (...args) => store.readPathIds(...args),
		readWorkingPath: async (...args) => store.readWorkingPath(...args),
		readTree: async (...args) => store.readTree(...args),
		readHistory: async (...args) => store.readHistory(...args),
		deleteSession: async (...args) => store.deleteSession(...args),
		close: async () => store.close(),
	};
}
