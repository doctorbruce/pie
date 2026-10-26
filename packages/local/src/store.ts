import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Assistant, ContextCompaction, HostRuntimeDefinition } from "@pie/runtime/protocol";
import type {
	RuntimeStore,
	SavedSession,
	SessionListOptions,
	SessionMetadata,
	SessionPage,
} from "@pie/runtime/runtime-store";
import { completeToolHistory, type MessageTree, syncMessageTree, treePath } from "@pie/runtime/session-tree";
import {
	createToolExecutionRecord,
	type ToolExecutionPage,
	type ToolExecutionReadOptions,
	type ToolExecutionRecord,
	validateToolExecutionRead,
	validateToolExecutionRecord,
} from "@pie/runtime/tool-execution";
import { recoverInterruptedTurn } from "@pie/runtime/turn-recovery";

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
		if (
			!db
				.prepare("PRAGMA table_info(sessions)")
				.all()
				.some((column) => column.name === "needs_recovery")
		) {
			db.exec(`BEGIN IMMEDIATE;
				ALTER TABLE sessions ADD COLUMN needs_recovery INTEGER NOT NULL DEFAULT 0;
				UPDATE sessions SET needs_recovery = 1 WHERE json_extract(payload, '$.turn.status') = 'running'
					OR EXISTS (SELECT 1 FROM json_each(payload, '$.activities') WHERE json_extract(value, '$.status') = 'running');
				COMMIT;`);
		}
		db.exec(`
			CREATE INDEX IF NOT EXISTS sessions_recovery ON sessions (needs_recovery) WHERE needs_recovery = 1;
			CREATE INDEX IF NOT EXISTS sessions_legacy ON sessions (id) WHERE json_type(payload, '$.messages') = 'array';
			CREATE TABLE IF NOT EXISTS tool_execution_journal (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				turn_id TEXT NOT NULL,
				record_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				UNIQUE (session_id, record_id)
			);
			CREATE INDEX IF NOT EXISTS tool_execution_turn ON tool_execution_journal (session_id, turn_id, seq);
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
		const saveSession = (
			session: SavedSession,
			replaceHistory = false,
			toolExecutions: readonly ToolExecutionRecord[] = [],
		): SessionMetadata => {
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
					"INSERT INTO sessions (id, assistant_id, payload, needs_recovery) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET assistant_id = excluded.assistant_id, payload = excluded.payload, needs_recovery = excluded.needs_recovery",
				).run(
					session.id,
					session.assistantId,
					JSON.stringify(metadata),
					Number(
						Boolean(
							session.turn?.status === "running" ||
								session.activities?.some((activity) => activity.status === "running"),
						),
					),
				);
				for (const record of toolExecutions) {
					validateToolExecutionRecord(record, session.id, session.turn?.id);
					const existing = db
						.prepare("SELECT payload FROM tool_execution_journal WHERE session_id = ? AND record_id = ?")
						.get(session.id, record.id);
					if (existing) {
						const saved = JSON.parse(String(existing.payload)) as ToolExecutionRecord;
						if (
							saved.toolName !== record.toolName ||
							saved.mode !== record.mode ||
							saved.externalId !== record.externalId
						)
							throw new Error("工具执行账本身份冲突");
						continue;
					}
					db.prepare(
						"INSERT INTO tool_execution_journal (session_id, turn_id, record_id, payload) VALUES (?, ?, ?, ?)",
					).run(session.id, record.turnId, record.id, JSON.stringify(record));
				}
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
		const readTurnPath = (id: string, inputEntryId: string, leafId = sessionLeaf(id)): MessageTree => {
			if (leafId !== null && !findEntry.get(id, leafId)) throw new Error("会话树叶子不存在");
			const input = findEntry.get(id, inputEntryId);
			if (!input || leafId === null) return { leafId, nodes: [] };
			const inputSeq = Number(input.seq);
			const rows = db
				.prepare(`WITH RECURSIVE path(id, parent_id, seq) AS (
					SELECT id, parent_id, seq FROM session_entries WHERE session_id = ? AND id = ? AND seq >= ?
					UNION ALL
					SELECT entry.id, entry.parent_id, entry.seq FROM session_entries entry
					JOIN path ON entry.id = path.parent_id
					WHERE entry.session_id = ? AND path.seq > ? AND entry.seq >= ? AND entry.seq < path.seq
				)
				SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
				WHERE entry.session_id = ? ORDER BY path.seq
			`)
				.all(id, leafId, inputSeq, id, inputSeq, inputSeq, id);
			if (rows[0]?.id !== inputEntryId) return { leafId, nodes: [] };
			const nodes = rows.map(parseEntry);
			nodes[0] = { ...nodes[0], parentId: null };
			return { leafId, nodes };
		};
		for (const row of db
			.prepare("SELECT payload FROM sessions WHERE json_type(payload, '$.messages') = 'array'")
			.iterate()) {
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
				saveSession(saved);
			}
		}
		db.exec(`
			CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (json_extract(payload, '$.updatedAt') DESC, id DESC);
			CREATE INDEX IF NOT EXISTS sessions_assistant ON sessions (assistant_id, json_extract(payload, '$.updatedAt') DESC, id DESC);
			CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (json_extract(payload, '$.parentSessionId'), json_extract(payload, '$.updatedAt') DESC, id DESC);
		`);
		const hostRuntimes = db
			.prepare("SELECT payload FROM host_runtimes")
			.all()
			.map((row) => JSON.parse(String(row.payload)) as HostRuntimeDefinition);
		function parseMetadata(payload: unknown): SessionMetadata {
			const session = JSON.parse(String(payload)) as SessionMetadata;
			if (session.assistant) {
				session.assistant.pluginIds ??= [];
				session.assistant.subagentIds ??= [];
			}
			session.kind ??= session.parentSessionId ? "subagent" : "root";
			if (session.runtime) session.runtime.subagents ??= [];
			session.runtimeSource ??= "local";
			if (session.runtimeSource === "local" && session.assistant)
				session.assistantRevision ??= String(session.assistant.updatedAt);
			return session;
		}
		for (const row of db.prepare("SELECT payload FROM sessions WHERE needs_recovery = 1").iterate()) {
			const session = parseMetadata(row.payload);
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
					db.prepare("UPDATE sessions SET payload = ?, needs_recovery = 0 WHERE id = ?").run(
						JSON.stringify(session),
						session.id,
					);
				continue;
			}
			const bounded = env.PI_TURN_RECOVERY === "manual" && typeof session.turnCheckpoint?.inputEntryId === "string";
			let tree = bounded
				? readTurnPath(session.id, session.turnCheckpoint!.inputEntryId, session.leafId)
				: readPath(session.id, session.leafId);
			let messages = tree.nodes.map((node) => node.message);
			const recovered = bounded ? recoverInterruptedTurn(session, tree) : undefined;
			if (
				recovered &&
				recovered.status !== "failed" &&
				(recovered.status === "interrupted" || completeToolHistory(messages))
			) {
				session.turn = recovered;
				if (recovered.status !== "interrupted") session.turnCheckpoint = undefined;
				session.revision++;
				session.updatedAt = Date.now();
				Object.assign(session, saveSession({ ...session, messages, tree }));
				continue;
			}
			if (bounded) {
				tree = readPath(session.id, session.leafId);
				messages = tree.nodes.map((node) => node.message);
			}
			session.turn = {
				...session.turn,
				status: recovered?.status === "cancelled" ? "cancelled" : "failed",
				error: recovered?.error ?? "服务中断，本次执行未完成；工具可能已产生效果，请核对后继续。",
			};
			const externalJobs = session.turnCheckpoint?.jobs ?? [];
			const cancelRequested = session.turnCheckpoint?.cancelRequested === true;
			session.turnCheckpoint = undefined;
			// Never replay tools after a crash. Close unmatched calls with an explicit unknown-outcome result.
			const records: ToolExecutionRecord[] = [];
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
					const externalJob = externalJobs.find((job) => job.toolCallId === part.id && job.toolName === part.name);
					records.push(
						createToolExecutionRecord({
							sessionId: session.id,
							turnId: session.turn!.id,
							toolCallId: part.id,
							toolName: part.name,
							mode: externalJob ? "durable" : part.name === "task" ? "delegated" : "inline",
							phase: "recovery_required",
							externalId: externalJob?.id,
							error: "服务中断，工具执行结果未知；未自动重试。",
						}),
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
						details: externalJob
							? {
									durableJob: { ...externalJob, status: "unknown", cancelRequested },
									...(activity ? { activity } : {}),
								}
							: activity
								? { activity }
								: undefined,
						isError: true,
						timestamp: Date.now(),
					});
					results.add(part.id);
				}
			}
			session.revision++;
			session.updatedAt = Date.now();
			Object.assign(
				session,
				saveSession({ ...session, messages, tree: syncMessageTree(tree, messages) }, false, records),
			);
		}
		return {
			assistants,
			get sessions() {
				return db
					.prepare("SELECT payload FROM sessions")
					.all()
					.map((row) => parseMetadata(row.payload));
			},
			hostRuntimes,
			saveSession,
			readToolExecutions(id: string, options: ToolExecutionReadOptions): ToolExecutionPage {
				validateToolExecutionRead(options);
				const rows = db
					.prepare(`SELECT seq, payload FROM tool_execution_journal
					WHERE session_id = ? AND turn_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
					.all(id, options.turnId, options.afterSeq ?? 0, options.limit + 1);
				const entries = rows.slice(0, options.limit).map((row) => ({
					...(JSON.parse(String(row.payload)) as ToolExecutionRecord),
					seq: Number(row.seq),
				}));
				return { entries, nextAfterSeq: rows.length > options.limit ? entries.at(-1)!.seq : null };
			},
			readSession(id: string): SessionMetadata | undefined {
				const row = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id);
				return row ? parseMetadata(row.payload) : undefined;
			},
			listSessions(options: SessionListOptions): SessionPage {
				const { limit, cursor, assistantId, kind, parentSessionId } = options;
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("会话分页需要 1–200 条");
				const clauses: string[] = [];
				const parameters: (string | number)[] = [];
				if (assistantId !== undefined) {
					clauses.push("assistant_id = ?");
					parameters.push(assistantId);
				}
				if (kind !== undefined) {
					clauses.push(
						"COALESCE(json_extract(payload, '$.kind'), CASE WHEN json_extract(payload, '$.parentSessionId') IS NULL THEN 'root' ELSE 'subagent' END) = ?",
					);
					parameters.push(kind);
				}
				if (parentSessionId !== undefined) {
					clauses.push("json_extract(payload, '$.parentSessionId') = ?");
					parameters.push(parentSessionId);
				}
				if (cursor) {
					clauses.push("(json_extract(payload, '$.updatedAt'), id) < (?, ?)");
					parameters.push(cursor.updatedAt, cursor.id);
				}
				const rows = db
					.prepare(`SELECT payload FROM sessions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
					ORDER BY json_extract(payload, '$.updatedAt') DESC, id DESC LIMIT ?`)
					.all(...parameters, limit + 1);
				const sessions = rows.slice(0, limit).map((row) => parseMetadata(row.payload));
				const last = sessions.at(-1);
				return {
					sessions,
					nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
				};
			},
			readPath,
			readTurnPath,
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
					.prepare(`WITH RECURSIVE path(id, parent_id, seq, found_first, found_turn) AS (
					SELECT id, parent_id, seq,
						CASE WHEN id = ? THEN 1 ELSE 0 END,
						CASE WHEN ? IS NULL OR id = ? THEN 1 ELSE 0 END
					FROM session_entries WHERE session_id = ? AND id = ?
					UNION ALL
					SELECT entry.id, entry.parent_id, CAST(entry.seq AS INTEGER),
						CASE WHEN path.found_first = 1 OR entry.id = ? THEN 1 ELSE 0 END,
						CASE WHEN path.found_turn = 1 OR ? IS NULL OR entry.id = ? THEN 1 ELSE 0 END
					FROM session_entries entry
					JOIN path ON entry.id = path.parent_id
					WHERE entry.session_id = ? AND NOT (path.found_first = 1 AND path.found_turn = 1)
				)
					SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
					WHERE entry.session_id = ? AND (
						path.seq >= (SELECT seq FROM path WHERE id = ?) OR path.id = ?
					) ORDER BY path.seq
				`)
					.all(
						compaction.firstKeptEntryId,
						compaction.turnStartEntryId ?? null,
						compaction.turnStartEntryId ?? null,
						id,
						leafId,
						compaction.firstKeptEntryId,
						compaction.turnStartEntryId ?? null,
						compaction.turnStartEntryId ?? null,
						id,
						id,
						compaction.firstKeptEntryId,
						compaction.turnStartEntryId ?? null,
					);
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
				if (beforeSeq <= 1) return { entries: [], nextBeforeSeq: null };
				const rows = db
					.prepare(`WITH RECURSIVE path(id, parent_id, seq, eligible) AS (
					SELECT id, parent_id, seq, CASE WHEN seq < ? THEN 1 ELSE 0 END
					FROM session_entries WHERE session_id = ? AND id = ?
					UNION ALL
					SELECT entry.id, entry.parent_id, CAST(entry.seq AS INTEGER),
						path.eligible + CASE WHEN entry.seq < ? THEN 1 ELSE 0 END
					FROM session_entries entry
					JOIN path ON entry.id = path.parent_id
					WHERE entry.session_id = ? AND path.eligible < ?
				)
					SELECT entry.* FROM path JOIN session_entries entry ON entry.id = path.id
					WHERE entry.session_id = ? AND path.seq < ? ORDER BY path.seq DESC LIMIT ?
				`)
					.all(beforeSeq, id, leafId, beforeSeq, id, limit + 1, id, beforeSeq, limit + 1);
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
		readSession: async (...args) => store.readSession(...args),
		listSessions: async (...args) => store.listSessions(...args),
		saveSession: async (...args) => store.saveSession(...args),
		readToolExecutions: async (...args) => store.readToolExecutions(...args),
		readPath: async (...args) => store.readPath(...args),
		readTurnPath: async (...args) => store.readTurnPath(...args),
		readPathIds: async (...args) => store.readPathIds(...args),
		readWorkingPath: async (...args) => store.readWorkingPath(...args),
		readTree: async (...args) => store.readTree(...args),
		readHistory: async (...args) => store.readHistory(...args),
		deleteSession: async (...args) => store.deleteSession(...args),
		close: async () => store.close(),
	};
}
