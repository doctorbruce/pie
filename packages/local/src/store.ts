import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssignmentRecord,
	CoordinationError,
	type InputBatch,
	type WorkerCoordinationStore,
	type WorkerDelivery,
	type WorkerEnqueueResult,
	type WorkerMessage,
	type WorkerRecord,
	type WorkItem,
	type YieldRecord,
} from "@pie/runtime/coordination";
import type { Assistant, ContextCompaction, HostRuntimeDefinition } from "@pie/runtime/protocol";
import type {
	RuntimeStore,
	SavedSession,
	SessionCreationRecord,
	SessionListOptions,
	SessionMetadata,
	SessionPage,
	SessionWriteOptions,
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
import type {
	WorkerCallContext,
	WorkerCommunicationStore,
	WorkerWaitOptions,
	WorkerWaitRecord,
	WorkerWaitResult,
} from "@pie/runtime/worker-communication";

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
			CREATE TABLE IF NOT EXISTS session_creations (creation_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS coordination_input_batches (batch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS coordination_yields (yield_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS workers (worker_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS work_items (work_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS assignments (
				assignment_id TEXT PRIMARY KEY,
				work_id TEXT NOT NULL,
				worker_id TEXT NOT NULL,
				session_id TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS assignments_work ON assignments (work_id, created_at, assignment_id);
			CREATE INDEX IF NOT EXISTS assignments_session ON assignments (session_id, created_at, assignment_id);
			CREATE TABLE IF NOT EXISTS messages (
				message_id TEXT PRIMARY KEY,
				worker_id TEXT NOT NULL,
				source_worker_id TEXT NOT NULL,
				source_session_id TEXT,
				work_id TEXT,
				target_session_id TEXT,
				sequence INTEGER NOT NULL,
				payload TEXT NOT NULL,
				UNIQUE (worker_id, sequence)
			);
			CREATE INDEX IF NOT EXISTS messages_worker_sequence ON messages (worker_id, sequence);
			CREATE INDEX IF NOT EXISTS messages_work ON messages (work_id, sequence);
			CREATE TABLE IF NOT EXISTS deliveries (
				delivery_id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				worker_id TEXT NOT NULL,
				assignment_id TEXT,
				session_id TEXT,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id, delivery_id);
			CREATE INDEX IF NOT EXISTS deliveries_worker_status ON deliveries (worker_id, status, updated_at);
			CREATE TABLE IF NOT EXISTS worker_sequences (
				worker_id TEXT PRIMARY KEY,
				next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
			);
			CREATE TABLE IF NOT EXISTS worker_cancelled_turns (
				session_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, turn_id)
			);
			CREATE TABLE IF NOT EXISTS worker_turn_cutoffs (
				session_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				worker_id TEXT NOT NULL,
				sequence INTEGER NOT NULL CHECK (sequence >= 0),
				rearmed INTEGER NOT NULL DEFAULT 0 CHECK (rearmed IN (0, 1)),
				PRIMARY KEY (session_id, turn_id)
			);
			CREATE TABLE IF NOT EXISTS worker_waits (
				wait_id TEXT PRIMARY KEY,
				worker_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				status TEXT NOT NULL,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS worker_waits_message ON worker_waits (message_id, session_id, status);
			CREATE INDEX IF NOT EXISTS worker_waits_turn ON worker_waits (session_id, turn_id);
			CREATE TABLE IF NOT EXISTS worker_wait_responses (
				message_id TEXT NOT NULL,
				response_id TEXT NOT NULL,
				wait_id TEXT NOT NULL,
				PRIMARY KEY (message_id, response_id)
			);
			CREATE INDEX IF NOT EXISTS worker_wait_responses_wait ON worker_wait_responses (wait_id);
			CREATE TABLE IF NOT EXISTS worker_wait_claims (
				delivery_id TEXT PRIMARY KEY,
				wait_id TEXT NOT NULL,
				message_id TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS worker_wait_claims_wait ON worker_wait_claims (wait_id);
		`);
		if (
			!db
				.prepare("PRAGMA table_info(worker_turn_cutoffs)")
				.all()
				.some((column) => column.name === "rearmed")
		)
			db.exec(
				"ALTER TABLE worker_turn_cutoffs ADD COLUMN rearmed INTEGER NOT NULL DEFAULT 0 CHECK (rearmed IN (0, 1))",
			);
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
		const cancelledWorkerTurn = (sessionId: string, turnId: string) =>
			Boolean(
				db
					.prepare("SELECT 1 FROM worker_cancelled_turns WHERE session_id = ? AND turn_id = ?")
					.get(sessionId, turnId),
			);
		const workerTurnCutoff = (sessionId: string) =>
			Number(
				db
					.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM worker_turn_cutoffs WHERE session_id = ?")
					.get(sessionId)!.sequence,
			);
		const recordWorkerTurnCutoff = (sessionId: string, turnId: string, workerId: string, sequence: number) => {
			if (!Number.isSafeInteger(sequence) || sequence < 0)
				throw new CoordinationError(400, "Worker 取消截止序号无效");
			db.prepare(`INSERT INTO worker_turn_cutoffs (session_id, turn_id, worker_id, sequence) VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id, turn_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence), rearmed = 0
				WHERE worker_turn_cutoffs.rearmed = 1`).run(sessionId, turnId, workerId, sequence);
			return workerTurnCutoff(sessionId);
		};
		const recordSessionWorkerCutoff = (session: SessionMetadata) => {
			if (session.turn?.status === "running") {
				const previous = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(session.id);
				const turn = previous ? (JSON.parse(String(previous.payload)) as SessionMetadata).turn : undefined;
				if (turn?.id === session.turn.id && turn.status === "interrupted")
					db.prepare("UPDATE worker_turn_cutoffs SET rearmed = 1 WHERE session_id = ? AND turn_id = ?").run(
						session.id,
						turn.id,
					);
				return;
			}
			if (session.turn?.status === "completed")
				db.prepare("UPDATE worker_turn_cutoffs SET rearmed = 0 WHERE session_id = ? AND turn_id = ?").run(
					session.id,
					session.turn.id,
				);
			if (!session.turn || !["cancelled", "failed", "interrupted"].includes(session.turn.status)) return;
			const assignment = db.prepare("SELECT worker_id FROM assignments WHERE session_id = ?").get(session.id);
			if (!assignment) return;
			const workerId = String(assignment.worker_id);
			const latest = db
				.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE worker_id = ?")
				.get(workerId)!;
			recordWorkerTurnCutoff(session.id, session.turn.id, workerId, Number(latest.sequence));
		};
		const cancelledWorkerMessage = (messageId: string) =>
			Boolean(
				db
					.prepare(`WITH RECURSIVE ancestors AS (
						SELECT * FROM messages WHERE message_id = ?
						UNION
						SELECT parent.* FROM messages parent
						JOIN ancestors child ON json_extract(child.payload, '$.replyTo') = parent.message_id
						LEFT JOIN deliveries parent_receipt ON parent_receipt.delivery_id = COALESCE(json_extract(parent.payload, '$.deliveryId'), parent.message_id || ':delivery')
						LEFT JOIN deliveries child_receipt ON child_receipt.delivery_id = COALESCE(json_extract(child.payload, '$.deliveryId'), child.message_id || ':delivery')
						WHERE child.source_worker_id = parent.worker_id AND child.worker_id = parent.source_worker_id
							AND (child.source_session_id = COALESCE(parent_receipt.session_id, parent.target_session_id)
								OR (child.source_session_id IS NULL AND COALESCE(parent_receipt.session_id, parent.target_session_id) IS NULL
									AND parent_receipt.status = 'failed' AND json_extract(child.payload, '$.kind') = 'result'))
							AND COALESCE(child_receipt.session_id, child.target_session_id) = parent.source_session_id
					)
					SELECT 1 FROM ancestors original WHERE (
						EXISTS (SELECT 1 FROM worker_cancelled_turns cancelled
							WHERE cancelled.session_id = original.source_session_id
								AND cancelled.turn_id = json_extract(original.payload, '$.sourceTurnId'))
						OR EXISTS (SELECT 1 FROM worker_waits wait
							WHERE wait.message_id = original.message_id AND wait.status = 'cancelled')
					) LIMIT 1`)
					.get(messageId),
			);
		const consumedWaitMessages = (wait: WorkerWaitRecord, includeResolved = false): WorkerMessage[] =>
			db
				.prepare(`WITH RECURSIVE descendants AS (
						SELECT * FROM messages WHERE message_id = ?
						UNION
						SELECT reply.* FROM messages reply
						JOIN descendants parent ON json_extract(reply.payload, '$.replyTo') = parent.message_id
						LEFT JOIN deliveries parent_receipt ON parent_receipt.delivery_id = COALESCE(json_extract(parent.payload, '$.deliveryId'), parent.message_id || ':delivery')
						LEFT JOIN deliveries reply_receipt ON reply_receipt.delivery_id = COALESCE(json_extract(reply.payload, '$.deliveryId'), reply.message_id || ':delivery')
						WHERE reply.source_worker_id = parent.worker_id AND reply.worker_id = parent.source_worker_id
							AND (reply.source_session_id = COALESCE(parent_receipt.session_id, parent.target_session_id)
								OR (reply.source_session_id IS NULL AND COALESCE(parent_receipt.session_id, parent.target_session_id) IS NULL
									AND parent_receipt.status = 'failed' AND json_extract(reply.payload, '$.kind') = 'result'))
							AND COALESCE(reply_receipt.session_id, reply.target_session_id) = parent.source_session_id
					)
					SELECT reply.payload FROM descendants reply
					JOIN deliveries receipt ON receipt.delivery_id = COALESCE(json_extract(reply.payload, '$.deliveryId'), reply.message_id || ':delivery')
					JOIN messages original ON original.message_id = ?
					LEFT JOIN deliveries sent ON sent.delivery_id = COALESCE(json_extract(original.payload, '$.deliveryId'), original.message_id || ':delivery')
					LEFT JOIN worker_wait_responses claimed ON claimed.message_id = original.message_id AND claimed.response_id = reply.message_id
					LEFT JOIN worker_wait_claims reservation ON reservation.delivery_id = receipt.delivery_id
					WHERE reply.worker_id = ? AND receipt.worker_id = reply.worker_id
						AND receipt.session_id = ?
						AND (receipt.status = 'consumed' OR (? = 1 AND receipt.status = 'resolved'
							AND json_extract(receipt.payload, '$.acceptedTurnId') IS NULL AND reply.sequence > ?))
						AND (reservation.wait_id IS NULL OR reservation.wait_id = ?)
						AND reply.source_worker_id = original.worker_id
						AND (reply.source_session_id = COALESCE(sent.session_id, original.target_session_id)
							OR (reply.source_session_id IS NULL AND COALESCE(sent.session_id, original.target_session_id) IS NULL
								AND sent.status = 'failed' AND json_extract(reply.payload, '$.kind') = 'result'))
						AND reply.message_id != original.message_id
						AND (claimed.wait_id = ? OR (? = 1 AND claimed.wait_id IS NULL))
						AND NOT EXISTS (SELECT 1 FROM worker_wait_responses other
							WHERE other.response_id = reply.message_id AND other.wait_id != ?)
						AND json_extract(reply.payload, '$.kind') IN ('question', 'reply', 'result')
					ORDER BY reply.sequence`)
				.all(
					wait.messageId,
					wait.messageId,
					wait.workerId,
					wait.sessionId,
					Number(includeResolved),
					workerTurnCutoff(wait.sessionId),
					wait.waitId,
					wait.waitId,
					Number(wait.status === "waiting"),
					wait.waitId,
				)
				.map((row) => JSON.parse(String(row.payload)) as WorkerMessage);
		const claimWaitMessages = (wait: WorkerWaitRecord, messages: readonly WorkerMessage[]) => {
			for (const message of messages)
				db.prepare(
					"INSERT OR IGNORE INTO worker_wait_responses (message_id, response_id, wait_id) VALUES (?, ?, ?)",
				).run(wait.messageId, message.messageId, wait.waitId);
		};
		const claimedWaitResult = (wait: WorkerWaitRecord): WorkerWaitResult | undefined => {
			const rows = db
				.prepare(`SELECT claim.delivery_id, claim.message_id, message.payload
					FROM worker_wait_claims claim JOIN messages message ON message.message_id = claim.message_id
					WHERE claim.wait_id = ? ORDER BY message.sequence`)
				.all(wait.waitId);
			return rows.length
				? {
						wait: { ...wait, status: "ready" },
						messages: rows.map((row) => JSON.parse(String(row.payload)) as WorkerMessage),
						receipts: rows.map((row) => ({
							deliveryId: String(row.delivery_id),
							messageId: String(row.message_id),
						})),
					}
				: undefined;
		};
		const saveSession = (
			session: SavedSession,
			replaceHistory = false,
			toolExecutions: readonly ToolExecutionRecord[] = [],
			options?: SessionWriteOptions,
		): SessionMetadata => {
			const { messages, tree: savedTree, transferBase: _transferBase, ...fields } = session;
			const tree = savedTree ?? syncMessageTree(undefined, messages);
			const metadata: SessionMetadata = { ...fields, leafId: tree.leafId };
			const pending = tree.nodes.filter((node) => node.seq === undefined);
			const committed: { node: MessageTree["nodes"][number]; seq: number }[] = [];
			db.exec("BEGIN IMMEDIATE");
			try {
				// Freeze once per terminal Turn, in the same transaction as its Session state.
				recordSessionWorkerCutoff(metadata);
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
				if (options?.creation) {
					if (options.creation.sessionId !== session.id) throw new Error("会话创建记录身份不匹配");
					db.prepare("INSERT INTO session_creations (creation_key, payload) VALUES (?, ?)").run(
						options.creation.creationKey,
						JSON.stringify(options.creation),
					);
				}
				let completingWait: WorkerWaitRecord | undefined;
				if (options?.workerWait) {
					const completion = options.workerWait;
					const savedWait = db
						.prepare("SELECT payload FROM worker_waits WHERE wait_id = ?")
						.get(completion.waitId);
					if (!savedWait) throw new CoordinationError(404, "同步等待不存在");
					completingWait = JSON.parse(String(savedWait.payload)) as WorkerWaitRecord;
					if (
						completingWait.mode !== "sync" ||
						completingWait.sessionId !== session.id ||
						completingWait.turnId !== session.turn?.id ||
						completingWait.toolCallId !== completion.toolCallId ||
						!["waiting", "ready"].includes(completingWait.status) ||
						!messages.some(
							(message) =>
								message.role === "toolResult" &&
								["wait_message", "communicate"].includes(message.toolName) &&
								message.toolCallId === completion.toolCallId &&
								!message.isError,
						)
					)
						throw new CoordinationError(409, "同步等待与所属 Turn 或工具结果不匹配");
					const reserved = db
						.prepare(
							"SELECT delivery_id, message_id FROM worker_wait_claims WHERE wait_id = ? ORDER BY delivery_id",
						)
						.all(completion.waitId)
						.map((row) => ({ deliveryId: String(row.delivery_id), messageId: String(row.message_id) }));
					if (
						!completion.responses.length ||
						(completingWait.status === "waiting" &&
							!isDeepStrictEqual(
								reserved,
								[...completion.responses].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)),
							))
					)
						throw new CoordinationError(409, "同步等待回信占有记录不匹配");
					if (completingWait.status === "ready") {
						for (const response of completion.responses) {
							const consumed = db
								.prepare(`SELECT 1 FROM worker_wait_responses response
									JOIN deliveries delivery ON delivery.message_id = response.response_id
									WHERE response.wait_id = ? AND response.message_id = ? AND response.response_id = ?
										AND delivery.delivery_id = ? AND delivery.session_id = ? AND delivery.status = 'consumed'
										AND json_extract(delivery.payload, '$.acceptedTurnId') = ?`)
								.get(
									completion.waitId,
									completingWait.messageId,
									response.messageId,
									response.deliveryId,
									session.id,
									session.turn!.id,
								);
							if (!consumed) throw new CoordinationError(409, "同步等待已完成，不能接纳其他回信");
						}
					}
				}
				for (const input of [...(options?.workerInputs ?? []), ...(options?.workerWait?.responses ?? [])]) {
					if (!session.turn?.id || cancelledWorkerTurn(session.id, session.turn.id))
						throw new CoordinationError(409, "Worker 输入所属 Turn 已取消或不存在");
					const row = db.prepare("SELECT payload FROM deliveries WHERE delivery_id = ?").get(input.deliveryId);
					const messageRow = db.prepare("SELECT payload FROM messages WHERE message_id = ?").get(input.messageId);
					if (!row || !messageRow) throw new CoordinationError(404, "Worker 输入或投递不存在");
					const delivery = JSON.parse(String(row.payload)) as WorkerDelivery;
					const message = JSON.parse(String(messageRow.payload)) as WorkerMessage;
					const claim = db
						.prepare("SELECT wait_id FROM worker_wait_claims WHERE delivery_id = ?")
						.get(input.deliveryId);
					if (claim && claim.wait_id !== completingWait?.waitId)
						throw new CoordinationError(409, "Worker 回信已由同步等待占有");
					const assignmentRow = db.prepare("SELECT payload FROM assignments WHERE session_id = ?").get(session.id);
					const assignment = assignmentRow
						? (JSON.parse(String(assignmentRow.payload)) as AssignmentRecord)
						: undefined;
					const workerRow = db.prepare("SELECT payload FROM workers WHERE worker_id = ?").get(delivery.workerId);
					const worker = workerRow ? (JSON.parse(String(workerRow.payload)) as WorkerRecord) : undefined;
					if (
						delivery.messageId !== message.messageId ||
						delivery.workerId !== message.workerId ||
						delivery.sessionId !== session.id ||
						(message.targetSessionId !== undefined && message.targetSessionId !== session.id) ||
						assignment?.workerId !== delivery.workerId ||
						assignment.assignmentId !== delivery.assignmentId ||
						worker?.assistantId !== session.assistantId
					)
						throw new CoordinationError(409, "Worker 输入与目标 Session 不匹配");
					if (!["resolved", "dispatched", "accepted", "consumed"].includes(delivery.status))
						throw new CoordinationError(409, "Worker 输入尚未完成会话关联");
					if (delivery.acceptedTurnId && delivery.acceptedTurnId !== session.turn.id)
						throw new CoordinationError(409, "Worker 输入已被其他 Turn 消费");
					if (delivery.status !== "consumed") {
						if (worker?.status === "stopped" || assignment.status === "stopped" || assignment.stopRequested)
							throw new CoordinationError(409, "目标 Worker 或 Session 已暂停或停止");
						const workRow = db.prepare("SELECT payload FROM work_items WHERE work_id = ?").get(assignment.workId);
						const work = workRow ? (JSON.parse(String(workRow.payload)) as WorkItem) : undefined;
						if (!work || work.status === "stopped") throw new CoordinationError(409, "目标工作项已停止或不存在");
						if (worker?.status !== "active") throw new CoordinationError(409, "目标 Worker 已暂停，暂不接纳输入");
					}
					if (delivery.status !== "consumed" && message.sequence <= workerTurnCutoff(session.id))
						throw new CoordinationError(409, "前一 Turn 已取消或中断，不能接纳原排队消息");
					if (message.replyTo && cancelledWorkerMessage(message.replyTo))
						throw new CoordinationError(409, "Worker 回复关联的请求已取消");
					const now = Date.now();
					const consumed: WorkerDelivery = {
						...delivery,
						status: "consumed",
						acceptedTurnId: session.turn.id,
						consumedAt: delivery.consumedAt ?? now,
						updatedAt: delivery.status === "consumed" ? delivery.updatedAt : now,
					};
					db.prepare("UPDATE deliveries SET status = ?, updated_at = ?, payload = ? WHERE delivery_id = ?").run(
						consumed.status,
						consumed.updatedAt,
						JSON.stringify(consumed),
						consumed.deliveryId,
					);
					db.prepare("UPDATE messages SET payload = ? WHERE message_id = ?").run(
						JSON.stringify({ ...message, status: "dispatched" }),
						message.messageId,
					);
					if (message.replyTo && ["question", "reply", "result"].includes(message.kind)) {
						for (const waiting of db
							.prepare(
								"SELECT payload FROM worker_waits WHERE session_id = ? AND status = 'waiting' ORDER BY json_extract(payload, '$.createdAt'), rowid",
							)
							.all(session.id)) {
							const wait = JSON.parse(String(waiting.payload)) as WorkerWaitRecord;
							if (wait.mode === "sync") continue;
							const responses = consumedWaitMessages(wait);
							if (
								!cancelledWorkerTurn(wait.sessionId, wait.turnId) &&
								!cancelledWorkerMessage(wait.messageId) &&
								responses.length
							) {
								claimWaitMessages(wait, responses);
								db.prepare("UPDATE worker_waits SET status = 'ready', payload = ? WHERE wait_id = ?").run(
									JSON.stringify({ ...wait, status: "ready", updatedAt: now }),
									wait.waitId,
								);
							}
						}
					}
				}
				if (completingWait) {
					const ready: WorkerWaitRecord = { ...completingWait, status: "ready", updatedAt: Date.now() };
					db.prepare("UPDATE worker_waits SET status = 'ready', payload = ? WHERE wait_id = ?").run(
						JSON.stringify(ready),
						ready.waitId,
					);
					db.prepare("DELETE FROM worker_wait_claims WHERE wait_id = ?").run(ready.waitId);
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
			async createInputBatch(batch: InputBatch) {
				const existing = db
					.prepare("SELECT payload FROM coordination_input_batches WHERE batch_id = ?")
					.get(batch.batchId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as InputBatch;
					if (saved.sessionId !== batch.sessionId || saved.requestFingerprint !== batch.requestFingerprint)
						throw new Error("输入批次身份冲突");
					return saved;
				}
				db.prepare("INSERT INTO coordination_input_batches (batch_id, session_id, payload) VALUES (?, ?, ?)").run(
					batch.batchId,
					batch.sessionId,
					JSON.stringify(batch),
				);
				return batch;
			},
			async readInputBatch(batchId: string) {
				const row = db.prepare("SELECT payload FROM coordination_input_batches WHERE batch_id = ?").get(batchId);
				return row ? (JSON.parse(String(row.payload)) as InputBatch) : undefined;
			},
			async updateInputBatch(
				batchId: string,
				update: Partial<Pick<InputBatch, "status" | "acceptedTurnId" | "consumedAt" | "error">>,
			) {
				const row = db.prepare("SELECT payload FROM coordination_input_batches WHERE batch_id = ?").get(batchId);
				if (!row) throw new Error("输入批次不存在");
				const next = { ...(JSON.parse(String(row.payload)) as InputBatch), ...update };
				db.prepare("UPDATE coordination_input_batches SET payload = ? WHERE batch_id = ?").run(
					JSON.stringify(next),
					batchId,
				);
				return next;
			},
			async createYield(record: YieldRecord) {
				const existing = db
					.prepare("SELECT payload FROM coordination_yields WHERE yield_id = ?")
					.get(record.yieldId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as YieldRecord;
					if (saved.sessionId !== record.sessionId || saved.turnId !== record.turnId)
						throw new Error("让出记录身份冲突");
					return saved;
				}
				db.prepare("INSERT INTO coordination_yields (yield_id, session_id, payload) VALUES (?, ?, ?)").run(
					record.yieldId,
					record.sessionId,
					JSON.stringify(record),
				);
				return record;
			},
			async readYield(yieldId: string) {
				const row = db.prepare("SELECT payload FROM coordination_yields WHERE yield_id = ?").get(yieldId);
				return row ? (JSON.parse(String(row.payload)) as YieldRecord) : undefined;
			},
			async registerWorkerWait(
				context: WorkerCallContext,
				messageId: string,
				waitId: string,
				options?: WorkerWaitOptions,
			): Promise<WorkerWaitResult> {
				for (const value of [
					context.workerId,
					context.sessionId,
					context.turnId,
					context.toolCallId,
					messageId,
					waitId,
				])
					if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0"))
						throw new CoordinationError(400, "Worker 等待身份无效");
				db.exec("BEGIN IMMEDIATE");
				try {
					if (cancelledWorkerTurn(context.sessionId, context.turnId))
						throw new CoordinationError(409, "Worker Turn 已取消，不能登记等待");
					const originalRow = db.prepare("SELECT payload FROM messages WHERE message_id = ?").get(messageId);
					if (!originalRow) throw new CoordinationError(404, "等待的 Worker 消息不存在");
					const original = JSON.parse(String(originalRow.payload)) as WorkerMessage;
					const assignment = db
						.prepare("SELECT worker_id, payload FROM assignments WHERE session_id = ?")
						.get(context.sessionId);
					if (
						original.sourceWorkerId !== context.workerId ||
						original.sourceSessionId !== context.sessionId ||
						assignment?.worker_id !== context.workerId
					)
						throw new CoordinationError(403, "只能等待当前 Worker Session 发起的消息");
					if (cancelledWorkerMessage(messageId)) throw new CoordinationError(409, "等待的 Worker 请求已取消");
					const mode = options?.mode ?? "async";
					if (mode !== "sync" && mode !== "async") throw new CoordinationError(400, "Worker 等待模式无效");
					if (mode === "sync") {
						const target = db
							.prepare("SELECT session_id FROM deliveries WHERE delivery_id = ?")
							.get(original.deliveryId ?? `${original.messageId}:delivery`);
						if ((target?.session_id ?? original.targetSessionId) === context.sessionId)
							throw new CoordinationError(409, "不能同步等待当前 Session，自身调用请使用异步等待");
						const saved = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(context.sessionId);
						const session = saved ? (JSON.parse(String(saved.payload)) as SessionMetadata) : undefined;
						if (session?.turn?.id !== context.turnId || session.turn.status !== "running")
							throw new CoordinationError(409, "同步等待所属 Turn 未在运行");
					}
					const existing = db.prepare("SELECT payload FROM worker_waits WHERE wait_id = ?").get(waitId);
					const now = Date.now();
					let wait: WorkerWaitRecord = existing
						? (JSON.parse(String(existing.payload)) as WorkerWaitRecord)
						: {
								waitId,
								workerId: context.workerId,
								sessionId: context.sessionId,
								turnId: context.turnId,
								toolCallId: context.toolCallId,
								messageId,
								mode,
								status: "waiting",
								createdAt: now,
								updatedAt: now,
							};
					if (
						wait.workerId !== context.workerId ||
						wait.sessionId !== context.sessionId ||
						wait.turnId !== context.turnId ||
						wait.toolCallId !== context.toolCallId ||
						wait.messageId !== messageId ||
						(wait.mode ?? "async") !== mode
					)
						throw new CoordinationError(409, "Worker 等待身份冲突");
					let claimed = mode === "sync" ? claimedWaitResult(wait) : undefined;
					const messages =
						claimed?.messages ?? consumedWaitMessages(wait, mode === "sync" && wait.status === "waiting");
					if (messages.length && wait.status === "waiting") {
						claimWaitMessages(wait, messages);
						if (mode === "sync") {
							const unconsumed = messages.filter((message) => {
								const deliveryId = message.deliveryId ?? `${message.messageId}:delivery`;
								return (
									db.prepare("SELECT status FROM deliveries WHERE delivery_id = ?").get(deliveryId)?.status ===
									"resolved"
								);
							});
							if (unconsumed.length) {
								const owner = JSON.parse(String(assignment!.payload)) as AssignmentRecord;
								const workerRow = db
									.prepare("SELECT payload FROM workers WHERE worker_id = ?")
									.get(context.workerId);
								const worker = workerRow ? (JSON.parse(String(workerRow.payload)) as WorkerRecord) : undefined;
								const workRow = db
									.prepare("SELECT payload FROM work_items WHERE work_id = ?")
									.get(owner.workId);
								const work = workRow ? (JSON.parse(String(workRow.payload)) as WorkItem) : undefined;
								if (!worker || worker.status === "stopped" || owner.status === "stopped" || owner.stopRequested)
									throw new CoordinationError(409, "目标 Worker 或 Session 已暂停或停止");
								if (worker.status !== "active")
									throw new CoordinationError(409, "目标 Worker 已暂停，暂不接纳输入");
								if (!work || work.status === "stopped")
									throw new CoordinationError(409, "目标工作项已停止或不存在");
								for (const message of unconsumed)
									if (message.replyTo && cancelledWorkerMessage(message.replyTo))
										throw new CoordinationError(409, "Worker 回复关联的请求已取消");
							}
							for (const message of messages) {
								const deliveryId = message.deliveryId ?? `${message.messageId}:delivery`;
								const delivery = db
									.prepare("SELECT status FROM deliveries WHERE delivery_id = ?")
									.get(deliveryId);
								if (delivery?.status === "resolved")
									db.prepare(
										"INSERT OR IGNORE INTO worker_wait_claims (delivery_id, wait_id, message_id) VALUES (?, ?, ?)",
									).run(deliveryId, wait.waitId, message.messageId);
							}
							claimed = claimedWaitResult(wait);
						}
						if (!claimed) wait = { ...wait, status: "ready", updatedAt: now };
					}
					db.prepare(
						`INSERT INTO worker_waits (wait_id, worker_id, session_id, turn_id, message_id, status, payload)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(wait_id) DO UPDATE SET status = excluded.status, payload = excluded.payload`,
					).run(
						wait.waitId,
						wait.workerId,
						wait.sessionId,
						wait.turnId,
						wait.messageId,
						wait.status,
						JSON.stringify(wait),
					);
					db.exec("COMMIT");
					return claimed ?? { wait, messages };
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			async finishWorkerWait(
				context: WorkerCallContext,
				waitId: string,
				status: "timed_out" | "cancelled",
			): Promise<WorkerWaitResult> {
				db.exec("BEGIN IMMEDIATE");
				try {
					const row = db.prepare("SELECT payload FROM worker_waits WHERE wait_id = ?").get(waitId);
					if (!row) throw new CoordinationError(404, "Worker 等待不存在");
					const wait = JSON.parse(String(row.payload)) as WorkerWaitRecord;
					if (
						wait.workerId !== context.workerId ||
						wait.sessionId !== context.sessionId ||
						wait.turnId !== context.turnId ||
						wait.toolCallId !== context.toolCallId ||
						wait.mode !== "sync"
					)
						throw new CoordinationError(409, "同步等待身份不匹配");
					const claimed =
						status === "timed_out" && wait.status === "waiting" ? claimedWaitResult(wait) : undefined;
					if (claimed) {
						db.exec("COMMIT");
						return claimed;
					}
					const next: WorkerWaitRecord =
						wait.status === "waiting" ? { ...wait, status, updatedAt: Date.now() } : wait;
					db.prepare("UPDATE worker_waits SET status = ?, payload = ? WHERE wait_id = ?").run(
						next.status,
						JSON.stringify(next),
						waitId,
					);
					if (next.status === "cancelled")
						db.prepare("DELETE FROM worker_wait_claims WHERE wait_id = ?").run(waitId);
					db.exec("COMMIT");
					return { wait: next, messages: [] };
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			async isWorkerDeliveryClaimed(deliveryId: string) {
				return Boolean(db.prepare("SELECT 1 FROM worker_wait_claims WHERE delivery_id = ?").get(deliveryId));
			},
			async cancelWorkerTurn(sessionId: string, turnId: string) {
				db.exec("BEGIN IMMEDIATE");
				try {
					const now = Date.now();
					db.prepare(
						"INSERT OR IGNORE INTO worker_cancelled_turns (session_id, turn_id, created_at) VALUES (?, ?, ?)",
					).run(sessionId, turnId, now);
					const saved = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(sessionId);
					if (saved) {
						const session = JSON.parse(String(saved.payload)) as SessionMetadata;
						if (session.turn?.id === turnId) recordSessionWorkerCutoff(session);
					}
					for (const row of db
						.prepare("SELECT payload FROM worker_waits WHERE session_id = ? AND turn_id = ?")
						.all(sessionId, turnId)) {
						const wait = JSON.parse(String(row.payload)) as WorkerWaitRecord;
						db.prepare("UPDATE worker_waits SET status = 'cancelled', payload = ? WHERE wait_id = ?").run(
							JSON.stringify({ ...wait, status: "cancelled", updatedAt: now }),
							wait.waitId,
						);
						db.prepare("DELETE FROM worker_wait_claims WHERE wait_id = ?").run(wait.waitId);
					}
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			async isWorkerTurnCancelled(sessionId: string, turnId: string) {
				return cancelledWorkerTurn(sessionId, turnId);
			},
			async isWorkerMessageCancelled(messageId: string) {
				return cancelledWorkerMessage(messageId);
			},
			async recordWorkerTurnCutoff(sessionId: string, turnId: string, workerId: string, sequence: number) {
				return recordWorkerTurnCutoff(sessionId, turnId, workerId, sequence);
			},
			async readWorkerTurnCutoff(sessionId: string) {
				return workerTurnCutoff(sessionId);
			},
			async listWorkerInputs(sessionId: string): Promise<WorkerEnqueueResult[]> {
				return db
					.prepare(`SELECT message.payload AS message, delivery.payload AS delivery FROM deliveries delivery
						JOIN messages message ON message.message_id = delivery.message_id
						JOIN assignments assignment ON assignment.session_id = delivery.session_id
						WHERE delivery.session_id = ? AND delivery.status = 'resolved'
							AND NOT EXISTS (SELECT 1 FROM worker_wait_claims claim WHERE claim.delivery_id = delivery.delivery_id)
							AND delivery.worker_id = message.worker_id AND assignment.worker_id = delivery.worker_id
							AND delivery.assignment_id = assignment.assignment_id
							AND (message.target_session_id IS NULL OR message.target_session_id = delivery.session_id)
						ORDER BY message.sequence, delivery.delivery_id`)
					.all(sessionId)
					.map((row) => ({
						message: JSON.parse(String(row.message)) as WorkerMessage,
						delivery: JSON.parse(String(row.delivery)) as WorkerDelivery,
					}));
			},
			async registerWorker(worker: WorkerRecord) {
				// This synchronous check and write share the single SQLite writer; a
				// service-level preflight alone races concurrent registrations.
				if (
					db
						.prepare("SELECT 1 FROM workers WHERE worker_id != ? AND json_extract(payload, '$.assistantId') = ?")
						.get(worker.workerId, worker.assistantId)
				)
					throw new CoordinationError(409, "assistantId 已注册其他逻辑 Worker");
				const existing = db.prepare("SELECT payload FROM workers WHERE worker_id = ?").get(worker.workerId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as WorkerRecord;
					if (saved.assistantId !== worker.assistantId)
						throw new CoordinationError(409, "Worker 已绑定其他 assistant");
					const next = { ...worker, createdAt: saved.createdAt };
					db.prepare("UPDATE workers SET payload = ? WHERE worker_id = ?").run(
						JSON.stringify(next),
						worker.workerId,
					);
					return next;
				}
				db.prepare("INSERT INTO workers (worker_id, payload) VALUES (?, ?)").run(
					worker.workerId,
					JSON.stringify(worker),
				);
				return worker;
			},
			async deleteWorker(workerId: string) {
				db.prepare("DELETE FROM workers WHERE worker_id = ?").run(workerId);
			},
			async readWorker(workerId: string) {
				const row = db.prepare("SELECT payload FROM workers WHERE worker_id = ?").get(workerId);
				return row ? (JSON.parse(String(row.payload)) as WorkerRecord) : undefined;
			},
			async listWorkers() {
				return db
					.prepare("SELECT payload FROM workers ORDER BY worker_id")
					.all()
					.map((row) => JSON.parse(String(row.payload)) as WorkerRecord);
			},
			async createWorkItem(workItem: WorkItem) {
				const existing = db.prepare("SELECT payload FROM work_items WHERE work_id = ?").get(workItem.workId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as WorkItem;
					const { createdAt: _savedCreated, updatedAt: _savedUpdated, ...savedFields } = saved;
					const { createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = workItem;
					if (!isDeepStrictEqual(savedFields, fields)) throw new CoordinationError(409, "工作项身份冲突");
					return saved;
				}
				db.prepare("INSERT INTO work_items (work_id, payload) VALUES (?, ?)").run(
					workItem.workId,
					JSON.stringify(workItem),
				);
				return workItem;
			},
			async readWorkItem(workId: string) {
				const row = db.prepare("SELECT payload FROM work_items WHERE work_id = ?").get(workId);
				return row ? (JSON.parse(String(row.payload)) as WorkItem) : undefined;
			},
			async findAssignmentByWork(workId: string) {
				return db
					.prepare("SELECT payload FROM assignments WHERE work_id = ? ORDER BY created_at, assignment_id")
					.all(workId)
					.map((row) => JSON.parse(String(row.payload)) as AssignmentRecord);
			},
			async findAssignmentBySession(sessionId: string) {
				const row = db.prepare("SELECT payload FROM assignments WHERE session_id = ?").get(sessionId);
				return row ? (JSON.parse(String(row.payload)) as AssignmentRecord) : undefined;
			},
			async createAssignment(assignment: AssignmentRecord) {
				const existing = db
					.prepare("SELECT payload FROM assignments WHERE assignment_id = ?")
					.get(assignment.assignmentId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as AssignmentRecord;
					const { createdAt: _savedCreated, updatedAt: _savedUpdated, ...savedFields } = saved;
					const { createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = assignment;
					if (!isDeepStrictEqual(savedFields, fields)) throw new CoordinationError(409, "工作会话关联身份冲突");
					return saved;
				}
				if (db.prepare("SELECT 1 FROM assignments WHERE session_id = ?").get(assignment.sessionId))
					throw new CoordinationError(409, "Session 已关联工作项");
				db.prepare(
					"INSERT INTO assignments (assignment_id, work_id, worker_id, session_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					assignment.assignmentId,
					assignment.workId,
					assignment.workerId,
					assignment.sessionId,
					assignment.createdAt,
					JSON.stringify(assignment),
				);
				return assignment;
			},
			async readWorkerMessage(messageId: string) {
				const row = db.prepare("SELECT payload FROM messages WHERE message_id = ?").get(messageId);
				return row ? (JSON.parse(String(row.payload)) as WorkerMessage) : undefined;
			},
			async createWorkerMessage(message: WorkerMessage) {
				const existing = db.prepare("SELECT payload FROM messages WHERE message_id = ?").get(message.messageId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as WorkerMessage;
					const {
						sequence: _savedSequence,
						status: _savedStatus,
						createdAt: _savedCreated,
						...savedFields
					} = saved;
					const { sequence: _sequence, status: _status, createdAt: _createdAt, ...fields } = message;
					if (!isDeepStrictEqual(savedFields, fields)) throw new CoordinationError(409, "工作消息身份冲突");
					return saved;
				}
				// Model sends recheck source control facts synchronously with insertion.
				// System failure receipts have no source Turn and may report stopped targets.
				if (message.sourceTurnId) {
					const sourceWorkerRow = db
						.prepare("SELECT payload FROM workers WHERE worker_id = ?")
						.get(message.sourceWorkerId);
					if (!sourceWorkerRow) throw new CoordinationError(404, "来源 Worker 不存在");
					const sourceWorker = JSON.parse(String(sourceWorkerRow.payload)) as WorkerRecord;
					if (sourceWorker.status === "stopped") throw new CoordinationError(409, "来源 Worker 已停止");
					const sourceAssignmentRow = message.sourceSessionId
						? db.prepare("SELECT payload FROM assignments WHERE session_id = ?").get(message.sourceSessionId)
						: undefined;
					const sourceAssignment = sourceAssignmentRow
						? (JSON.parse(String(sourceAssignmentRow.payload)) as AssignmentRecord)
						: undefined;
					if (!sourceAssignment || sourceAssignment.workerId !== message.sourceWorkerId)
						throw new CoordinationError(403, "来源 Session 不属于当前 Worker");
					if (sourceAssignment.status === "stopped" || sourceAssignment.stopRequested)
						throw new CoordinationError(409, "来源 Session 已停止");
					const sourceWorkRow = db
						.prepare("SELECT payload FROM work_items WHERE work_id = ?")
						.get(sourceAssignment.workId);
					if (!sourceWorkRow) throw new CoordinationError(404, "来源工作项不存在");
					const sourceWork = JSON.parse(String(sourceWorkRow.payload)) as WorkItem;
					if (sourceWork.status === "stopped") throw new CoordinationError(409, "来源工作项已停止");
				}
				if (
					message.sourceSessionId &&
					message.sourceTurnId &&
					cancelledWorkerTurn(message.sourceSessionId, message.sourceTurnId)
				)
					throw new CoordinationError(409, "Worker 消息来源 Turn 已取消");
				if (!Number.isSafeInteger(message.sequence) || message.sequence < 1)
					throw new CoordinationError(400, "工作消息序号无效");
				if (
					db
						.prepare("SELECT 1 FROM messages WHERE worker_id = ? AND sequence = ?")
						.get(message.workerId, message.sequence)
				)
					throw new CoordinationError(409, "工作消息序号冲突");
				db.prepare(
					`INSERT INTO messages
					(message_id, worker_id, source_worker_id, source_session_id, work_id, target_session_id, sequence, payload)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					message.messageId,
					message.workerId,
					message.sourceWorkerId,
					message.sourceSessionId ?? null,
					message.workId ?? null,
					message.targetSessionId ?? null,
					message.sequence,
					JSON.stringify(message),
				);
				return message;
			},
			async createWorkerDelivery(delivery: WorkerDelivery) {
				const existing = db
					.prepare("SELECT payload FROM deliveries WHERE delivery_id = ?")
					.get(delivery.deliveryId);
				if (existing) {
					const saved = JSON.parse(String(existing.payload)) as WorkerDelivery;
					if (saved.messageId !== delivery.messageId || saved.workerId !== delivery.workerId)
						throw new CoordinationError(409, "消息投递身份冲突");
					return saved;
				}
				db.prepare(
					`INSERT INTO deliveries
					(delivery_id, message_id, worker_id, assignment_id, session_id, status, created_at, updated_at, payload)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					delivery.deliveryId,
					delivery.messageId,
					delivery.workerId,
					delivery.assignmentId ?? null,
					delivery.sessionId ?? null,
					delivery.status,
					delivery.createdAt,
					delivery.updatedAt,
					JSON.stringify(delivery),
				);
				return delivery;
			},
			async readWorkerDelivery(deliveryId: string) {
				const row = db.prepare("SELECT payload FROM deliveries WHERE delivery_id = ?").get(deliveryId);
				return row ? (JSON.parse(String(row.payload)) as WorkerDelivery) : undefined;
			},
			async updateWorkerDelivery(
				deliveryId: string,
				update: Parameters<WorkerCoordinationStore["updateWorkerDelivery"]>[1],
			) {
				const row = db.prepare("SELECT payload FROM deliveries WHERE delivery_id = ?").get(deliveryId);
				if (!row) throw new CoordinationError(404, "消息投递不存在");
				const saved = JSON.parse(String(row.payload)) as WorkerDelivery;
				if (saved.status === "failed") return saved;
				if (saved.status === "consumed") {
					if (update.acceptedTurnId && update.acceptedTurnId !== saved.acceptedTurnId)
						throw new CoordinationError(409, "Worker 输入已被其他 Turn 消费");
					if (
						(update.sessionId !== undefined && update.sessionId !== saved.sessionId) ||
						(update.assignmentId !== undefined && update.assignmentId !== saved.assignmentId)
					)
						throw new CoordinationError(409, "不能修改已消费 Worker 输入的会话关联");
					if (update.status === "consumed" && update.acceptedTurnId && update.error) {
						const next = { ...saved, error: update.error, updatedAt: update.updatedAt ?? Date.now() };
						db.prepare("UPDATE deliveries SET updated_at = ?, payload = ? WHERE delivery_id = ?").run(
							next.updatedAt,
							JSON.stringify(next),
							deliveryId,
						);
						return next;
					}
					return saved;
				}
				const next = {
					...saved,
					...update,
					deliveryId: saved.deliveryId,
					messageId: saved.messageId,
					workerId: saved.workerId,
					updatedAt: update.updatedAt ?? Date.now(),
				};
				db.prepare(
					`UPDATE deliveries
					SET assignment_id = ?, session_id = ?, status = ?, updated_at = ?, payload = ?
					WHERE delivery_id = ?`,
				).run(
					next.assignmentId ?? null,
					next.sessionId ?? null,
					next.status,
					next.updatedAt,
					JSON.stringify(next),
					deliveryId,
				);
				return next;
			},
			async nextWorkerSequence(workerId: string) {
				db.exec("BEGIN IMMEDIATE");
				try {
					const row = db.prepare("SELECT next_sequence FROM worker_sequences WHERE worker_id = ?").get(workerId);
					const lastMessage = db
						.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE worker_id = ?")
						.get(workerId)!;
					const sequence = Math.max(row ? Number(row.next_sequence) : 1, Number(lastMessage.sequence) + 1);
					if (!Number.isSafeInteger(sequence + 1)) throw new CoordinationError(503, "Worker 消息序号已耗尽");
					if (row) {
						db.prepare("UPDATE worker_sequences SET next_sequence = ? WHERE worker_id = ?").run(
							sequence + 1,
							workerId,
						);
					} else {
						db.prepare("INSERT INTO worker_sequences (worker_id, next_sequence) VALUES (?, ?)").run(
							workerId,
							sequence + 1,
						);
					}
					db.exec("COMMIT");
					return sequence;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			readSessionCreation(creationKey: string): SessionCreationRecord | undefined {
				const row = db.prepare("SELECT payload FROM session_creations WHERE creation_key = ?").get(creationKey);
				return row ? (JSON.parse(String(row.payload)) as SessionCreationRecord) : undefined;
			},
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
				if (options.includeArchived === false) clauses.push("COALESCE(json_extract(payload, '$.archived'), 0) = 0");
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
					const now = Date.now();
					// Keep the stopped association so later messages cannot recreate this work Session.
					db.prepare(
						`UPDATE assignments SET payload = json_set(payload, '$.status', 'stopped', '$.stopRequested', json('true'), '$.updatedAt', ?)
						WHERE session_id = ? AND (json_extract(payload, '$.status') != 'stopped' OR COALESCE(json_extract(payload, '$.stopRequested'), 0) != 1)`,
					).run(now, id);
					db.prepare(
						"UPDATE worker_waits SET status = 'cancelled', payload = json_set(payload, '$.status', 'cancelled', '$.updatedAt', ?) WHERE session_id = ? AND status = 'waiting'",
					).run(now, id);
					db.prepare(
						"DELETE FROM worker_wait_claims WHERE wait_id IN (SELECT wait_id FROM worker_waits WHERE session_id = ?)",
					).run(id);
					const relatedDeliveries = `SELECT d.delivery_id FROM deliveries d JOIN messages m ON m.message_id = d.message_id
							WHERE d.session_id = ? OR m.target_session_id = ?
							OR json_extract(m.payload, '$.replyTo') IN (SELECT message_id FROM messages WHERE source_session_id = ?)
							OR (d.session_id IS NULL AND m.target_session_id IS NULL
								AND json_extract(m.payload, '$.replyTo') IS NULL AND COALESCE(json_extract(m.payload, '$.newSession'), 0) = 0
								AND (m.worker_id, m.work_id) IN (
									SELECT a.worker_id, a.work_id FROM assignments a WHERE a.session_id = ?
									AND (SELECT COUNT(*) FROM assignments b WHERE b.worker_id = a.worker_id AND b.work_id = a.work_id) = 1
								))`;
					db.prepare(
						`UPDATE deliveries SET status = 'failed', updated_at = ?,
						payload = json_set(payload, '$.status', 'failed', '$.error', '目标 Session 已删除', '$.updatedAt', ?)
						WHERE status IN ('pending', 'resolved') AND delivery_id IN (${relatedDeliveries})`,
					).run(now, now, id, id, id, id);
					// A failed report can be retried after the Session row has already been deleted.
					const failed = db
						.prepare(
							`SELECT payload FROM deliveries WHERE status = 'failed'
						AND json_extract(payload, '$.error') = '目标 Session 已删除'
						AND delivery_id IN (${relatedDeliveries})`,
						)
						.all(id, id, id, id);
					db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(id);
					db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
					db.exec("COMMIT");
					return failed.map((row) => JSON.parse(String(row.payload)) as WorkerDelivery);
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

export function createSqliteRuntimeStore(
	store: ReturnType<typeof openStore>,
): RuntimeStore & WorkerCoordinationStore & WorkerCommunicationStore {
	return {
		persistence: "sqlite",
		readSession: async (...args) => store.readSession(...args),
		listSessions: async (...args) => store.listSessions(...args),
		saveSession: async (...args) => store.saveSession(...args),
		createInputBatch: async (...args) => store.createInputBatch(...args),
		readInputBatch: async (...args) => store.readInputBatch(...args),
		updateInputBatch: async (...args) => store.updateInputBatch(...args),
		createYield: async (...args) => store.createYield(...args),
		readYield: async (...args) => store.readYield(...args),
		registerWorkerWait: async (...args) => store.registerWorkerWait(...args),
		finishWorkerWait: async (...args) => store.finishWorkerWait(...args),
		isWorkerDeliveryClaimed: async (...args) => store.isWorkerDeliveryClaimed(...args),
		cancelWorkerTurn: async (...args) => store.cancelWorkerTurn(...args),
		isWorkerTurnCancelled: async (...args) => store.isWorkerTurnCancelled(...args),
		isWorkerMessageCancelled: async (...args) => store.isWorkerMessageCancelled(...args),
		recordWorkerTurnCutoff: async (...args) => store.recordWorkerTurnCutoff(...args),
		readWorkerTurnCutoff: async (...args) => store.readWorkerTurnCutoff(...args),
		listWorkerInputs: async (...args) => store.listWorkerInputs(...args),
		registerWorker: async (...args) => store.registerWorker(...args),
		deleteWorker: async (...args) => store.deleteWorker(...args),
		readWorker: async (...args) => store.readWorker(...args),
		listWorkers: async (...args) => store.listWorkers(...args),
		createWorkItem: async (...args) => store.createWorkItem(...args),
		readWorkItem: async (...args) => store.readWorkItem(...args),
		findAssignmentByWork: async (...args) => store.findAssignmentByWork(...args),
		findAssignmentBySession: async (...args) => store.findAssignmentBySession(...args),
		createAssignment: async (...args) => store.createAssignment(...args),
		readWorkerMessage: async (...args) => store.readWorkerMessage(...args),
		createWorkerMessage: async (...args) => store.createWorkerMessage(...args),
		createWorkerDelivery: async (...args) => store.createWorkerDelivery(...args),
		readWorkerDelivery: async (...args) => store.readWorkerDelivery(...args),
		updateWorkerDelivery: async (...args) => store.updateWorkerDelivery(...args),
		nextWorkerSequence: async (...args) => store.nextWorkerSequence(...args),
		readSessionCreation: async (...args) => store.readSessionCreation(...args),
		readToolExecutions: async (...args) => store.readToolExecutions(...args),
		readPath: async (...args) => store.readPath(...args),
		readTurnPath: async (...args) => store.readTurnPath(...args),
		readPathIds: async (...args) => store.readPathIds(...args),
		readWorkingPath: async (...args) => store.readWorkingPath(...args),
		readTree: async (...args) => store.readTree(...args),
		readHistory: async (...args) => store.readHistory(...args),
		deleteSession: async (...args) => {
			store.deleteSession(...args);
		},
		close: async () => store.close(),
	};
}
