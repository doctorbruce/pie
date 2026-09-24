import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ActivityRecord,
	Assistant,
	ContextCompaction,
	HostRuntimeDefinition,
	RuntimeConfig,
	SessionSummary,
	TransferMessage,
} from "./protocol.ts";

export type SavedSession = SessionSummary & {
	astronSessionId?: string;
	assistant?: Assistant;
	revision: number;
	messages: AgentMessage[];
	runtime?: RuntimeConfig;
	activities?: ActivityRecord[];
	compaction?: ContextCompaction;
	transferBase?: TransferMessage[];
	transferBaseMessageCount?: number;
};

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
		const saveSession = (session: SavedSession) => {
			db.prepare(
				"INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
			).run(session.id, session.assistantId, JSON.stringify(session));
		};
		const sessions = db
			.prepare("SELECT payload FROM sessions")
			.all()
			.map((row) => JSON.parse(String(row.payload)) as SavedSession);
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
				if (recoveredActivity) saveSession(session);
				continue;
			}
			session.turn = {
				...session.turn,
				status: "failed",
				error: "服务中断，本次执行未完成；工具可能已产生效果，请核对后继续。",
			};
			// Never replay tools after a crash. Close unmatched calls with an explicit unknown-outcome result.
			const results = new Set(session.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
			for (const message of [...session.messages]) {
				if (message.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall" || results.has(part.id)) continue;
					const activity = session.activities?.find(
						(item) => item.turnId === session.turn?.id && item.toolCallId === part.id,
					);
					session.messages.push({
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
			saveSession(session);
		}
		return {
			assistants,
			sessions,
			hostRuntimes,
			saveSession,
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
				db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
