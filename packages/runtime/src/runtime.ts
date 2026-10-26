import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { createAgentFactory } from "./agent.ts";
import type { AssistantSource } from "./capabilities.ts";
import { checkpointMessage, isContextCheckpoint } from "./compaction.ts";
import { hydrateHostRuntime, parseHostRuntimeDefinition, SkillConfigError } from "./config.ts";
import { DurableJobError, type DurableJobExecutor, durableJobResult, pendingDurableJobs } from "./durable-jobs.ts";
import { projectSessionAgentEvent } from "./event-projection.ts";
import { type BackgroundJobInfo, BackgroundJobs } from "./jobs.ts";
import type {
	ActivityRecord,
	Assistant,
	ContextCompaction,
	GlobalSessionEvent,
	HostRuntimeDefinition,
	ImagePart,
	InteractionRequest,
	SessionEvent,
	SessionSnapshot,
	SessionState,
	SessionSummary,
	SessionTransfer,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import type { RuntimeStore, SavedSession, SessionCursor, SessionMetadata } from "./runtime-store.ts";
import {
	displayAgentMessages,
	exportSession,
	parseSessionModelOverride,
	parseSessionTransfer,
	transferToAgentMessages,
} from "./session-transfer.ts";
import { completeToolHistory, historyMessageId, type MessageTree, sessionTree, treePath } from "./session-tree.ts";
import {
	createToolExecutionRecord,
	type ToolExecutionMode,
	type ToolExecutionReadOptions,
	type ToolExecutionRecord,
	validateToolExecutionRead,
	validateToolExecutionRecord,
} from "./tool-execution.ts";
import { recoverInterruptedTurn } from "./turn-recovery.ts";

export class RuntimeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;

function optionalRequestId(body: Record<string, unknown>): string | undefined {
	if (body.requestId === undefined) return undefined;
	if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 256)
		throw new RuntimeError(400, "requestId 需要 1–256 个字符");
	return body.requestId.trim();
}

function turnContent(body: Record<string, unknown>): Extract<AgentMessage, { role: "user" }>["content"] {
	const text = body.text === undefined ? "" : body.text;
	if (typeof text !== "string" || text.length > 16000)
		throw new RuntimeError(400, "text 需要字符串，最多 16000 个字符");
	const values = body.images === undefined ? [] : body.images;
	if (!Array.isArray(values)) throw new RuntimeError(400, "images 需要图片数组");
	const images: ImagePart[] = [];
	let totalBytes = 0;
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new RuntimeError(400, "images 需要有效的图片对象");
		const image = value as Record<string, unknown>;
		if (
			image.type !== "image" ||
			typeof image.mimeType !== "string" ||
			!/^image\/[a-z0-9.+-]+$/i.test(image.mimeType) ||
			typeof image.data !== "string" ||
			!image.data
		)
			throw new RuntimeError(400, "图片需要 type、image MIME 类型和 Base64 data");
		if (image.data.length > Math.ceil(MAX_TURN_IMAGE_BYTES / 3) * 4)
			throw new RuntimeError(413, "图片总大小不能超过 20 MiB");
		const bytes = Buffer.from(image.data, "base64");
		if (bytes.toString("base64") !== image.data) throw new RuntimeError(400, "图片 Base64 data 无效");
		totalBytes += bytes.length;
		if (totalBytes > MAX_TURN_IMAGE_BYTES) throw new RuntimeError(413, "图片总大小不能超过 20 MiB");
		images.push({ type: "image", mimeType: image.mimeType, data: image.data });
	}
	if (!text.trim() && images.length === 0) throw new RuntimeError(400, "text 或 images 不能为空");
	if (
		body.displayText !== undefined &&
		(typeof body.displayText !== "string" ||
			body.displayText.length > 16000 ||
			(!body.displayText.trim() && images.length === 0))
	)
		throw new RuntimeError(400, "displayText 需要字符串，最多 16000 个字符；纯文本消息不能为空");
	return images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
}

/**
 * 引擎侧（Astron）的 canonical 身份。Pie 自己不认识它，只是原样存到那条 user 消息上，
 * 历史读回时由引擎用来把运行时消息认领回它的 turn / 计划任务，自身不参与任何逻辑。
 */
type UserMessageIdentity = {
	clientMessageId?: string;
	userMessageId?: string;
	triggerTaskId?: string;
};

const USER_MESSAGE_IDENTITY_KEYS = ["clientMessageId", "userMessageId", "triggerTaskId"] as const;

function optionalMessageIdentity(body: Record<string, unknown>): UserMessageIdentity {
	const identity: UserMessageIdentity = {};
	for (const key of USER_MESSAGE_IDENTITY_KEYS) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim() || value.length > 256)
			throw new RuntimeError(400, `${key} 需要 1–256 个字符`);
		identity[key] = value.trim();
	}
	return identity;
}

export type CreateSessionInput = {
	assistantId?: string;
	title?: string;
	workspacePath?: string;
	mode?: "faux" | "real";
	model?: { provider: string; id: string };
};
export type TurnInput = {
	text?: string;
	images?: ImagePart[];
	displayText?: string;
	requestId?: string;
	assistantId?: string;
	systemPrompt?: string;
	model?: { provider: string; id: string };
	clientMessageId?: string;
	userMessageId?: string;
	triggerTaskId?: string;
};
type RuntimeSubscriber<Event = SessionEvent> = { next: (event: Event) => void; close: () => void };
function closeSubscriber(subscriber: { close: () => void }) {
	try {
		subscriber.close();
	} catch {}
}
function notifySubscribers<Event>(listeners: Set<RuntimeSubscriber<Event>>, packet: Event) {
	for (const listener of listeners) {
		try {
			listener.next(structuredClone(packet));
		} catch {
			listeners.delete(listener);
			closeSubscriber(listener);
		}
	}
}
export type RuntimeAgents = Omit<ReturnType<typeof createAgentFactory>, "settings"> & {
	settings: { readonly current: { selected?: { provider: string; id: string } } };
};
export type RuntimeOptions = {
	store: RuntimeStore;
	agents: RuntimeAgents;
	sessionRetention?: "retain" | "release-after-turn";
	hostRuntimes?: readonly HostRuntimeDefinition[];
	saveHostRuntimes?: (definitions: readonly HostRuntimeDefinition[]) => Promise<void>;
	assistants?: AssistantSource;
	jobs?: DurableJobExecutor;
};

async function initializeRuntime(options: RuntimeOptions) {
	const { agents: factory, store } = options;
	const instanceId = randomUUID();
	const jobs = new BackgroundJobs();
	const pollIntervalMs = options.jobs?.pollIntervalMs ?? 1000;
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60000)
		throw new Error("外部任务查询间隔需要 1–60000 毫秒");
	function parseHostRuntimeRegistry(values: readonly unknown[]) {
		if (values.length > 256) throw new SkillConfigError("runtimes 最多 256 项");
		const definitions = values.map((value) => parseHostRuntimeDefinition(value, factory.toolIds));
		const registry = new Map<string, HostRuntimeDefinition>();
		for (const definition of definitions) {
			if (registry.has(definition.assistantId))
				throw new SkillConfigError(`Assistant ID 不可重复：${definition.assistantId}`);
			registry.set(definition.assistantId, definition);
		}
		for (const definition of definitions)
			for (const binding of definition.runtime.subagents)
				if (!registry.has(binding.assistantId))
					throw new SkillConfigError(`Subagent Assistant 不存在：${binding.assistantId}`);
		return registry;
	}
	// Persisted host runtimes are validated against the tool catalog. A registry that no
	// longer parses (for example a tool id the host has since replaced) must not stop the
	// process: the host re-registers authoritative definitions on connect, so stale
	// entries are dropped instead of crashing at boot.
	let hostRuntimes: Map<string, HostRuntimeDefinition>;
	try {
		hostRuntimes = parseHostRuntimeRegistry(options.hostRuntimes ?? []);
	} catch (error) {
		hostRuntimes = new Map();
		await options.saveHostRuntimes?.([]);
		console.warn(
			`Discarded ${options.hostRuntimes?.length ?? 0} persisted host runtime(s) that no longer parse; the host will re-register: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	function localRuntime(assistant: Assistant) {
		if (!options.assistants) throw new RuntimeError(405, "当前宿主未启用助手配置");
		return options.assistants.runtime(assistant);
	}
	factory.mcp.configure([...hostRuntimes.values()].map((definition) => definition.runtime.mcp ?? {}));
	type Session = SavedSession & {
		historyLoaded?: boolean;
		waiters?: number;
		mcpAbort?: AbortController;
		agent?: ReturnType<typeof factory.create>;
		cancelRequested: boolean;
		clients: Set<RuntimeSubscriber>;
		runPromise?: Promise<string | undefined>;
		writePromise?: Promise<void>;
		publishPromise?: Promise<void>;
		jobInterruption?: string;
	};
	type PendingInteraction = {
		request: InteractionRequest;
		sessionId: string;
		executionSessionId: string;
		turnId: string;
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	};
	const sessions = new Map<string, Session>();
	const waitingReads = new Set<Promise<SessionSnapshot>>();
	let commandActive = false;
	let queuedCommands = 0;
	const pendingInteractions = new Map<string, PendingInteraction>();
	const entryIds = new WeakMap<AgentMessage, string>();
	function releaseSession(session: Session) {
		if (
			options.sessionRetention !== "release-after-turn" ||
			storageFailed ||
			session.waiters ||
			session.runPromise ||
			session.turn?.status === "running" ||
			session.agent?.state.isStreaming ||
			session.agent?.hasQueuedMessages() ||
			jobs.list(session.id).some((job) => job.status === "running") ||
			[...pendingInteractions.values()].some(
				(pending) => pending.sessionId === session.id || pending.executionSessionId === session.id,
			)
		)
			return;
		session.agent = undefined;
		session.messages = [];
		session.transferBase = undefined;
		session.historyLoaded = false;
		if (!commandActive && queuedCommands === 0 && session.clients.size === 0 && sessions.get(session.id) === session)
			sessions.delete(session.id);
	}
	async function loadHistory(session: Session) {
		if (session.historyLoaded !== false) return;
		if (session.compaction && !session.compaction.firstKeptEntryId) {
			const ids = await store.readPathIds(session.id);
			session.compaction = {
				...session.compaction,
				firstKeptEntryId: ids[session.compaction.firstKeptMessage],
				turnStartEntryId:
					session.compaction.turnStartIndex === undefined ? undefined : ids[session.compaction.turnStartIndex],
			};
			if (!session.compaction.firstKeptEntryId) throw new Error("压缩 checkpoint 缺少有效保留边界");
		}
		const tree = await store.readWorkingPath(session.id, session.compaction);
		for (const node of tree.nodes) entryIds.set(node.message, node.id);
		session.tree = { nodes: [], leafId: tree.leafId };
		session.messages = tree.nodes.map((node) => node.message);
		if (session.compaction) {
			session.messages.unshift(checkpointMessage(session.compaction));
			session.compaction.workingMessageCount ??=
				session.compaction.messageCount === undefined
					? session.messages.length
					: 1 +
						(session.compaction.turnStartEntryId ? 1 : 0) +
						Math.max(0, session.compaction.messageCount - session.compaction.firstKeptMessage);
		}
		session.historyLoaded = true;
	}
	async function fullHistory(session: Session) {
		return (await store.readPath(session.id)).nodes.map((node) => node.message);
	}
	function historyUpdate(session: Session, messages: AgentMessage[]) {
		const tree: MessageTree = { nodes: [], leafId: session.tree?.leafId ?? null };
		const identities = new Map<AgentMessage, string>();
		for (const message of messages) {
			if (isContextCheckpoint(message)) continue;
			const existing = entryIds.get(message);
			if (existing) {
				identities.set(message, existing);
				continue;
			}
			const id = randomUUID();
			tree.nodes.push({ id, parentId: tree.leafId, message });
			tree.leafId = id;
			identities.set(message, id);
		}
		return { tree, identities };
	}
	const globalClients = new Set<RuntimeSubscriber<GlobalSessionEvent>>();
	let storageFailed = false;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	function summary(session: SessionSummary): SessionSummary {
		return {
			id: session.id,
			kind: session.kind,
			forkedFromSessionId: session.forkedFromSessionId,
			parentSessionId: session.parentSessionId,
			parentToolCallId: session.parentToolCallId,
			subagentType: session.subagentType,
			assistantId: session.assistantId,
			assistantRevision: session.assistantRevision,
			runtimeSource: session.runtimeSource,
			title: session.title,
			workspacePath: session.workspacePath,
			mode: session.mode,
			model: session.model,
			provider: session.provider,
			modelOverride: session.modelOverride,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			turn: session.turn,
		};
	}
	async function forkSession(source: Session, messageIndex: number, requestedTitle: unknown, boundary = false) {
		if (source.kind !== "root") throw new RuntimeError(409, "子会话不能分叉");
		if (source.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行，不能分叉");
		await source.runPromise;
		const messages = await fullHistory(source);
		const selected = messages[messageIndex];
		if (
			!Number.isInteger(messageIndex) ||
			messageIndex < 0 ||
			messageIndex > messages.length ||
			(!boundary && selected?.role !== "user")
		)
			throw new RuntimeError(400, "messageIndex 需要指向有效的用户消息");
		if (!completeToolHistory(messages.slice(0, messageIndex)))
			throw new RuntimeError(409, "不能在未完成的工具调用中分叉");
		if (
			requestedTitle !== undefined &&
			(typeof requestedTitle !== "string" || !requestedTitle.trim() || requestedTitle.length > 100)
		)
			throw new RuntimeError(400, "会话标题需要 1–100 个字符");

		const id = randomUUID();
		const now = Date.now();
		const keptMessages = structuredClone(messages.slice(0, messageIndex));
		const keptToolCalls = new Set(
			keptMessages.flatMap((message) =>
				message.role === "assistant"
					? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
					: [],
			),
		);
		const forked: Session = {
			id,
			kind: "root",
			forkedFromSessionId: source.id,
			assistantId: source.assistantId,
			assistantRevision: source.assistantRevision,
			runtimeSource: source.runtimeSource,
			assistant: source.assistant ? structuredClone(source.assistant) : undefined,
			title: typeof requestedTitle === "string" ? requestedTitle.trim() : `${source.title.slice(0, 95)}（分支）`,
			workspacePath: source.workspacePath,
			mode: source.mode,
			model: source.model,
			provider: source.provider,
			modelOverride: structuredClone(source.modelOverride),
			createdAt: now,
			updatedAt: now,
			messages: keptMessages,
			transferBase: source.transferBase
				? structuredClone(
						source.transferBase.slice(
							0,
							keptMessages
								.slice(0, source.transferBaseMessageCount ?? 0)
								.filter((message) => message.role !== "toolResult").length,
						),
					)
				: undefined,
			transferBaseMessageCount:
				source.transferBaseMessageCount === undefined
					? undefined
					: Math.min(source.transferBaseMessageCount, messageIndex),
			runtime: source.runtime ? structuredClone(source.runtime) : undefined,
			activities: (source.activities ?? [])
				.filter((activity) => keptToolCalls.has(activity.toolCallId))
				.map((activity) => ({ ...structuredClone(activity), sessionId: id })),
			revision: 0,
			cancelRequested: false,
			clients: new Set(),
		};
		await persist(forked);
		sessions.set(id, forked);
		return {
			session: await snapshot(forked),
			selectedText: selected?.role === "user" ? contentText(selected.content) : "",
		};
	}
	async function persist(
		session: Session,
		replaceHistory = false,
		update?: ReturnType<typeof historyUpdate>,
		toolExecutions: readonly ToolExecutionRecord[] = [],
	) {
		const pending = (session.writePromise ?? Promise.resolve()).then(async () => {
			if (storageFailed) throw new Error("会话写入屏障已失败，请重启运行时后恢复");
			await loadHistory(session);
			const messages = session.jobInterruption
				? session.messages
				: (session.agent?.state.messages ?? session.messages);
			const { tree, identities } = update ?? historyUpdate(session, messages);
			try {
				await store.saveSession(
					{
						...summary(session),
						astronSessionId: session.astronSessionId,
						assistant: session.assistant,
						revision: session.revision + 1,
						messages,
						tree,
						runtime: session.runtime,
						activities: session.activities,
						compaction: session.compaction,
						turnCheckpoint: session.turnCheckpoint,
						transferBase: session.transferBase,
						transferBaseMessageCount: session.transferBaseMessageCount,
					},
					replaceHistory,
					toolExecutions,
				);
			} catch (error) {
				storageFailed = true;
				throw error;
			}
			session.messages = [...messages];
			session.tree = { nodes: [], leafId: tree.leafId };
			session.transferBase = undefined;
			for (const [message, id] of identities) entryIds.set(message, id);
		});
		session.writePromise = pending.catch(() => {});
		await pending;
		releaseSession(session);
	}
	function executionRecord(
		session: Session,
		toolCallId: string,
		toolName: string,
		phase: ToolExecutionRecord["phase"],
		error?: string,
	): ToolExecutionRecord {
		if (!session.turn) throw new Error("工具执行账本缺少 Turn");
		const reference = session.turnCheckpoint?.jobs?.find((job) => job.toolCallId === toolCallId);
		const tool = session.agent?.state.tools.find((candidate) => candidate.name === toolName);
		const declared: unknown = tool && "toolExecutionMode" in tool ? tool.toolExecutionMode : undefined;
		const mode: ToolExecutionMode = reference
			? "durable"
			: declared === "durable" || declared === "delegated" || declared === "inline"
				? declared
				: toolName === "task"
					? "delegated"
					: "inline";
		return createToolExecutionRecord({
			sessionId: session.id,
			turnId: session.turn.id,
			toolCallId,
			toolName,
			mode,
			phase,
			externalId: reference?.id,
			error: error?.slice(0, 4000),
		});
	}
	async function recordActivity(session: Session, activity: ToolActivity) {
		if (!session.turn) throw new Error("技能记录缺少 Turn");
		const record: ActivityRecord = { ...activity, sessionId: session.id, turnId: session.turn.id };
		session.activities ??= [];
		const index = session.activities.findIndex((item) => item.id === record.id);
		if (index < 0) session.activities.push(record);
		else session.activities[index] = record;
		await persist(session);
		await publish(session, "activity.updated", undefined, record);
	}
	async function updateCompaction(
		session: Session,
		next: ContextCompaction,
		source: AgentMessage[],
		projected: AgentMessage[],
	) {
		const update = historyUpdate(session, source);
		const ids = [
			...(await store.readPathIds(session.id, session.tree?.leafId ?? null)),
			...update.tree.nodes.map((node) => node.id),
		];
		const firstKeptEntryId = update.identities.get(source[next.firstKeptMessage]);
		const turnStartEntryId =
			next.turnStartIndex === undefined ? undefined : update.identities.get(source[next.turnStartIndex]);
		if (!firstKeptEntryId) throw new Error("压缩保留边界缺少历史节点");
		Object.assign(next, {
			firstKeptEntryId,
			turnStartEntryId,
			firstKeptMessage: ids.indexOf(firstKeptEntryId),
			turnStartIndex: turnStartEntryId === undefined ? undefined : ids.indexOf(turnStartEntryId),
			messageCount: ids.length,
		});
		const previous = session.compaction;
		session.compaction = next;
		try {
			await persist(session, false, update);
		} catch (error) {
			session.compaction = previous;
			throw error;
		}
		session.messages = projected;
		await publish(session, "compaction.updated");
	}
	async function settleInteraction(id: string, approved: boolean, error?: Error) {
		const pending = pendingInteractions.get(id);
		if (!pending) return false;
		pendingInteractions.delete(id);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		const session = sessions.get(pending.sessionId);
		try {
			if (session)
				await publish(
					session,
					"interaction.resolved",
					{ type: "interaction.resolved", approved },
					undefined,
					pending.request,
				);
		} finally {
			if (approved) pending.resolve();
			else pending.reject(error ?? new Error("用户拒绝了操作"));
		}
		return true;
	}
	async function rejectSessionInteractions(sessionId: string, error: Error) {
		for (const [id, pending] of pendingInteractions) {
			if (pending.sessionId === sessionId || pending.executionSessionId === sessionId)
				await settleInteraction(id, false, error);
		}
	}
	function requestInteraction(
		session: Session,
		request: Omit<InteractionRequest, "id">,
		signal?: AbortSignal,
	): Promise<void> {
		const owner = session.parentSessionId ? sessions.get(session.parentSessionId) : session;
		if (!owner?.turn || owner.turn.status !== "running") return Promise.reject(new Error("会话当前不可交互"));
		if (
			request.type !== "confirmation" ||
			typeof request.title !== "string" ||
			typeof request.message !== "string" ||
			!request.title.trim() ||
			!request.message.trim()
		)
			return Promise.reject(new Error("交互请求无效"));
		const interaction: InteractionRequest = { ...request, id: randomUUID() };
		return new Promise<void>((resolve, reject) => {
			const pending: PendingInteraction = {
				request: interaction,
				sessionId: owner.id,
				executionSessionId: session.id,
				turnId: owner.turn!.id,
				resolve,
				reject,
				signal,
			};
			pending.onAbort = () => {
				void settleInteraction(interaction.id, false, new Error("交互已取消")).catch(reject);
			};
			pendingInteractions.set(interaction.id, pending);
			if (signal?.aborted) {
				void settleInteraction(interaction.id, false, new Error("交互已取消")).catch(reject);
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			void publish(owner, "interaction.requested", undefined, undefined, interaction).catch(reject);
		});
	}
	function createSessionAgent(
		session: Session,
		runtime: NonNullable<Session["runtime"]>,
		messages = session.messages,
		selected?: { provider: string; id: string } | null,
	) {
		return factory.create(
			session.mode,
			session.id,
			runtime,
			selected === undefined
				? session.mode === "real" && session.provider
					? { provider: session.provider, id: session.model }
					: undefined
				: (selected ?? undefined),
			messages,
			async (activity) => await recordActivity(session, activity),
			(request, signal) => requestInteraction(session, request, signal),
			session.kind === "root"
				? (toolCallId, binding, description, prompt, options, signal) =>
						runSubagent(session, toolCallId, binding, description, prompt, options, signal)
				: undefined,
			{
				current: session.compaction,
				update: async (next, source, projected) => await updateCompaction(session, next, source, projected),
				report: async (event) => await publish(session, event.type, event),
			},
			{
				directory: session.workspacePath ?? process.cwd(),
				jobs,
				notifyBackground: (message) => notifyBackground(session, message),
				runJob: options.jobs ? (toolCallId, signal) => runJob(session, toolCallId, signal) : undefined,
			},
		);
	}
	async function runJob(session: Session, toolCallId: string, signal?: AbortSignal) {
		const executor = options.jobs;
		const checkpoint = session.turnCheckpoint;
		if (!executor || !checkpoint || session.kind !== "root" || session.turn?.status !== "running")
			throw new Error("当前执行不支持可接管的外部任务");
		if (closing || storageFailed) throw new Error("运行时不可提交外部任务");
		if (session.mcpAbort)
			signal = signal ? AbortSignal.any([signal, session.mcpAbort.signal]) : session.mcpAbort.signal;
		signal?.throwIfAborted();
		const tree = await store.readTurnPath(session.id, checkpoint.inputEntryId);
		const call =
			tree.nodes
				.flatMap((node) =>
					node.message.role === "assistant"
						? node.message.content.filter((part) => part.type === "toolCall" && part.id === toolCallId)
						: [],
				)
				.at(-1) ??
			checkpoint.pendingAssistant?.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
		if (!call || call.type !== "toolCall") throw new Error("外部任务缺少已提交的工具调用");
		const previous = checkpoint.jobs?.find((job) => job.toolCallId === toolCallId);
		const reference = previous ?? {
			id: randomUUID(),
			sessionId: session.id,
			turnId: session.turn.id,
			toolCallId,
			toolName: call.name,
		};
		try {
			if (!previous) {
				checkpoint.jobs ??= [];
				checkpoint.jobs.push(reference);
				await persist(session, false, undefined, [
					executionRecord(session, toolCallId, call.name, "submission_intent"),
				]);
				signal?.throwIfAborted();
				await executor.submit(
					{ ...structuredClone(reference), arguments: structuredClone(call.arguments) },
					signal,
				);
			}
			if (!previous)
				await persist(session, false, undefined, [executionRecord(session, toolCallId, call.name, "submitted")]);
			while (true) {
				signal?.throwIfAborted();
				const result = durableJobResult(reference, await executor.get(structuredClone(reference), signal));
				signal?.throwIfAborted();
				if (result) return { content: result.content, details: result.details, usage: result.usage };
				await delay(pollIntervalMs, undefined, { signal });
			}
		} catch (error) {
			session.jobInterruption = error instanceof Error ? error.message : String(error);
			session.agent?.abort();
			if (!storageFailed)
				await persist(session, false, undefined, [
					executionRecord(session, toolCallId, call.name, "recovery_required", session.jobInterruption),
				]);
			throw error;
		}
	}
	async function pendingJobs(session: Session) {
		if (!session.turnCheckpoint?.jobs?.length || !session.turn) return [];
		const tree = await store.readTurnPath(session.id, session.turnCheckpoint.inputEntryId);
		return pendingDurableJobs(
			session.id,
			session.turn.id,
			session.turnCheckpoint.jobs,
			tree.nodes.map((node) => node.message),
		);
	}
	async function cancelJobs(session: Session) {
		const pending = await pendingJobs(session);
		if (pending.length && !options.jobs) throw new RuntimeError(409, "宿主未配置外部任务执行器，无法请求取消");
		if (session.turn?.status === "running") {
			session.jobInterruption = "外部任务取消已请求";
			session.agent?.abort();
			session.mcpAbort?.abort();
		}
		for (const reference of pending) await options.jobs!.cancel(reference);
	}
	async function closeCancelledJobs(session: Session) {
		const pending = await pendingJobs(session);
		await loadHistory(session);
		if (session.jobInterruption) session.agent = undefined;
		const messages = session.agent?.state.messages ?? session.messages;
		for (const reference of pending)
			messages.push({
				role: "toolResult",
				toolCallId: reference.toolCallId,
				toolName: reference.toolName,
				content: [{ type: "text", text: "已请求取消；外部任务最终状态和副作用仍需向执行器核对。" }],
				details: { durableJob: { ...reference, status: "unknown", cancelRequested: true } },
				isError: true,
				timestamp: Date.now(),
			});
		session.messages = [...messages];
		return pending.map((reference) =>
			executionRecord(
				session,
				reference.toolCallId,
				reference.toolName,
				"recovery_required",
				"取消已请求，最终副作用未知",
			),
		);
	}
	async function notifyBackground(session: Session, text: string) {
		if (closing) return;
		const started = await execute(async () => {
			session = await requireSession(session.id);
			if (session.turn?.status !== "running") await session.runPromise;
			if (session.turnCheckpoint) {
				session.turnCheckpoint.blockedReason = "包含尚未持久化的后台通知队列";
				await persist(session);
			}
			const agent = await attachAgent(session);
			const content = [{ type: "text" as const, text, synthetic: true as const }];
			agent.followUp({ role: "user", content, timestamp: Date.now() });
			if (agent.state.isStreaming || session.turn?.status === "running") return;
			session.turn = { id: randomUUID(), status: "running" };
			session.turnCheckpoint = undefined;
			session.cancelRequested = false;
			session.updatedAt = Date.now();
			await persist(session);
			await publish(session, "snapshot");
			return { runPromise: startRun(session) };
		}, true);
		await started?.runPromise;
	}
	function bindAgent(session: Session, agent: ReturnType<typeof factory.create>) {
		session.agent = agent;
		agent.subscribe(async (event) => {
			if (session.jobInterruption) return;
			if (event.type === "tool_execution_start") {
				if (session.turnCheckpoint && event.assistantMessage)
					session.turnCheckpoint.pendingAssistant = structuredClone(event.assistantMessage);
				await persist(session, false, undefined, [
					executionRecord(session, event.toolCallId, event.toolName, "started"),
				]);
			}
			if (event.type === "message_end") {
				if (event.message.role === "assistant" && session.turnCheckpoint)
					delete session.turnCheckpoint.pendingAssistant;
				if (session.turnCheckpoint && jobs.list(session.id).some((job) => job.status === "running"))
					session.turnCheckpoint.blockedReason = "包含后台任务，尚不支持接管";
				const message = event.message;
				const background =
					message.role === "toolResult" &&
					message.details &&
					typeof message.details === "object" &&
					Reflect.get(message.details, "background") === true;
				const records =
					message.role === "toolResult"
						? [
								executionRecord(
									session,
									message.toolCallId,
									message.toolName,
									background ? "recovery_required" : message.isError ? "failed" : "completed",
									background
										? "内存后台执行不可跨实例接管"
										: message.isError
											? contentText(message.content)
											: undefined,
								),
							]
						: [];
				await persist(session, false, undefined, records);
			}
			await publish(session, "agent.event", event);
		});
		return agent;
	}
	async function attachAgent(session: Session, prepared?: ReturnType<typeof factory.create>) {
		await loadHistory(session);
		if (session.agent) return session.agent;
		if (!session.runtime) {
			if (session.runtimeSource === "host") {
				const definition = hostRuntimes.get(session.assistantId);
				if (!definition) throw new RuntimeError(409, "宿主未注册此会话的 Assistant runtime");
				session.assistantRevision = definition.assistantRevision;
				session.runtime = hydrateHostRuntime(definition, hostRuntimes);
			} else {
				const assistant = options.assistants?.list().find((assistant) => assistant.id === session.assistantId);
				if (!assistant) throw new RuntimeError(409, "会话引用的助手不存在");
				session.assistant = structuredClone(assistant);
				session.assistantRevision = String(assistant.updatedAt);
				session.runtime = localRuntime(assistant);
			}
		}
		return bindAgent(session, prepared ?? createSessionAgent(session, session.runtime));
	}
	function resolveTurnConfiguration(session: Session, body: Record<string, unknown>) {
		if (body.assistantId !== undefined && body.assistantId !== session.assistantId)
			throw new RuntimeError(409, "assistantId 与会话归属不一致");
		if (Reflect.get(body, "runtime") !== undefined || Reflect.get(body, "assistantRevision") !== undefined)
			throw new RuntimeError(400, "runtime 由 /host-runtimes 注册，Turn 不接受内联运行配置");
		if (session.runtimeSource === "host") {
			const definition = hostRuntimes.get(session.assistantId);
			if (!definition) throw new RuntimeError(409, "宿主未注册此会话的 Assistant runtime");
			return {
				assistant: undefined,
				assistantRevision: definition.assistantRevision,
				runtimeSource: "host" as const,
				runtime: hydrateHostRuntime(definition, hostRuntimes),
			};
		}
		const assistant = options.assistants?.list().find((assistant) => assistant.id === session.assistantId);
		if (!assistant) throw new RuntimeError(409, "会话引用的助手不存在");
		return {
			assistant: structuredClone(assistant),
			assistantRevision: String(assistant.updatedAt),
			runtimeSource: "local" as const,
			runtime: localRuntime(assistant),
		};
	}
	function sessionState(session: Session): SessionState {
		return structuredClone({
			instanceId,
			...summary(session),
			assistant: session.assistant,
			revision: session.revision,
			streamingMessage: session.agent?.state.streamingMessage,
			turn: session.turn,
			runtime: session.runtime,
			activities: session.activities ?? [],
			compaction: session.compaction,
			interactions: [...pendingInteractions.values()]
				.filter((interaction) => interaction.sessionId === session.id)
				.map((interaction) => interaction.request),
		});
	}
	async function snapshot(session: Session, options?: { limit: number }): Promise<SessionSnapshot> {
		const state = sessionState(session);
		const leafId = session.tree?.leafId ?? null;
		const page = options ? await store.readHistory(session.id, { ...options, leafId }) : undefined;
		const messages = page ? page.entries.map((entry) => entry.message) : await fullHistory(session);
		return structuredClone({
			...state,
			messages: displayAgentMessages(messages),
			...(page ? { history: { leafId, nextBeforeSeq: page.nextBeforeSeq } } : {}),
		});
	}
	function validateHistoryOptions(options: { limit: number; beforeSeq?: number; leafId?: string | null }) {
		if (
			!Number.isSafeInteger(options.limit) ||
			options.limit < 1 ||
			options.limit > 200 ||
			(options.beforeSeq !== undefined && (!Number.isSafeInteger(options.beforeSeq) || options.beforeSeq < 1)) ||
			(options.leafId !== undefined &&
				options.leafId !== null &&
				(typeof options.leafId !== "string" || !options.leafId))
		)
			throw new RuntimeError(400, "历史分页需要 1–200 条、有效 seq 游标和叶子 ID");
	}
	async function publish(
		session: Session,
		type: SessionEvent["type"],
		event?: SessionEvent["event"],
		activity?: ActivityRecord,
		interaction?: InteractionRequest,
	) {
		const pending = (session.publishPromise ?? Promise.resolve()).then(async () => {
			session.revision++;
			const packet: GlobalSessionEvent = {
				type,
				sessionId: session.id,
				turnId: session.turn?.id,
				event,
				activity,
				interaction,
				snapshot: { instanceId, revision: session.revision, turn: session.turn },
			};
			if (session.clients.size)
				notifySubscribers(session.clients, {
					type,
					sessionId: session.id,
					turnId: session.turn?.id,
					instanceId,
					revision: session.revision,
					turn: session.turn,
					activity,
					interaction,
					event: type === "agent.event" ? projectSessionAgentEvent(event) : event,
					...(type === "agent.event" ? {} : { state: sessionState(session) }),
				});
			notifySubscribers(globalClients, packet);
		});
		session.publishPromise = pending.catch(() => {});
		await pending;
	}

	async function runSubagent(
		parent: Session,
		toolCallId: string,
		binding: SubagentBinding,
		description: string,
		prompt: string,
		options: { taskId?: string; background?: boolean },
		signal?: AbortSignal,
	) {
		if (parent.kind !== "root" || !parent.turn || parent.turn.status !== "running")
			throw new Error("父会话当前不能调用 Subagent");
		signal?.throwIfAborted();
		if (parent.turnCheckpoint) {
			parent.turnCheckpoint.blockedReason = "包含 Subagent 执行，尚不支持级联恢复";
			await persist(parent);
		}
		const child = await execute(async () => {
			let child: Session;
			if (options.taskId) {
				const existing = await requireSession(options.taskId);
				if (existing.kind !== "subagent" || existing.parentSessionId !== parent.id)
					throw new Error(`不可继续的 task_id：${options.taskId}`);
				if (existing.subagentType !== binding.id || existing.assistantId !== binding.assistantId)
					throw new Error("task_id 与指定 Subagent 不匹配");
				if (existing.turn?.status === "running" || jobs.get(existing.id)?.status === "running")
					throw new Error(`Subagent 仍在运行：${existing.id}`);
				await existing.runPromise;
				child = existing;
				const agent = await attachAgent(child);
				agent.state.messages = [...agent.state.messages, { role: "user", content: prompt, timestamp: Date.now() }];
				child.turn = { id: randomUUID(), status: "running" };
				child.cancelRequested = false;
				child.updatedAt = Date.now();
				await persist(child);
				await publish(
					child,
					"snapshot",
					projectSessionAgentEvent({ type: "message_end", message: agent.state.messages.at(-1) }),
				);
			} else {
				const id = randomUUID();
				const now = Date.now();
				const runtime = { ...structuredClone(binding.runtime), subagents: [] };
				const selected =
					binding.model ??
					(parent.mode === "real" && parent.provider
						? { provider: parent.provider, id: parent.model }
						: undefined);
				child = {
					id,
					kind: "subagent",
					parentSessionId: parent.id,
					parentToolCallId: toolCallId,
					subagentType: binding.id,
					assistantId: binding.assistantId,
					assistantRevision: binding.assistantRevision,
					runtimeSource: parent.runtimeSource,
					title: description.trim().slice(0, 100) || binding.name,
					workspacePath: parent.workspacePath,
					mode: parent.mode,
					model: selected?.id ?? parent.model,
					provider: selected?.provider ?? parent.provider,
					createdAt: now,
					updatedAt: now,
					turn: { id: randomUUID(), status: "running" },
					messages: [{ role: "user", content: prompt, timestamp: now }],
					runtime,
					activities: [],
					revision: 0,
					cancelRequested: false,
					clients: new Set(),
				};
				bindAgent(child, createSessionAgent(child, runtime));
				await persist(child);
				sessions.set(id, child);
			}
			return child;
		}, true);
		const background = options.background === true;
		const started = jobs.start({
			id: child.id,
			ownerSessionId: parent.id,
			type: "task",
			title: child.title,
			async run(jobSignal) {
				const abortChild = () => {
					child.cancelRequested = true;
					void rejectSessionInteractions(child.id, new Error("Subagent 已取消")).catch(console.error);
					child.agent?.abort();
					child.mcpAbort?.abort();
				};
				jobSignal.addEventListener("abort", abortChild, { once: true });
				if (jobSignal.aborted) abortChild();
				let output: string | undefined;
				try {
					output = await startRun(child);
				} finally {
					jobSignal.removeEventListener("abort", abortChild);
				}
				if (child.turn?.status !== "completed")
					throw new Error(
						`Subagent 执行${child.turn?.status === "cancelled" ? "已取消" : "失败"}（${child.id}）：${child.turn?.error ?? "没有完成"}`,
					);
				return { output };
			},
			async onSettled(job) {
				if (!background) return;
				const state = job.status === "completed" ? "completed" : "error";
				await notifyBackground(
					parent,
					`<task id="${child.id}" state="${state}">\n<summary>${state === "completed" ? "Background task completed" : "Background task failed"}: ${description}</summary>\n<task_result>\n${job.error ?? job.output}\n</task_result>\n</task>`,
				);
			},
		});
		if (background) {
			return {
				content: [
					{
						type: "text" as const,
						text: `<task id="${child.id}" state="running">\n后台 Subagent 已启动，完成后会自动通知。\n</task>`,
					},
				],
				details: {
					childSessionId: child.id,
					targetAssistantId: binding.assistantId,
					subagentType: binding.id,
					background: true,
					jobId: started.id,
				},
			};
		}
		const abort = () => jobs.cancel(started.id);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		let job: BackgroundJobInfo | undefined;
		try {
			job = await jobs.wait(started.id);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		if (!job || job.status !== "completed") throw new Error(job?.error ?? "Subagent 没有完成");
		return {
			content: [{ type: "text" as const, text: job.output || "Subagent 已完成任务。" }],
			details: { childSessionId: child.id, targetAssistantId: binding.assistantId, subagentType: binding.id },
		};
	}
	async function run(session: Session) {
		const turn = session.turn;
		const agent = session.agent;
		if (!turn || !agent) return;
		const mcpAbort = new AbortController();
		session.mcpAbort = mcpAbort;
		if (session.cancelRequested) mcpAbort.abort();
		let releaseMcp: (() => void) | undefined;
		try {
			releaseMcp = await agent.prepareMcp(mcpAbort.signal);
			do {
				await agent.continue();
			} while (agent.hasQueuedMessages() && !session.cancelRequested && !session.jobInterruption);
			turn.error = agent.state.errorMessage;
			turn.status = session.cancelRequested ? "cancelled" : turn.error ? "failed" : "completed";
		} catch (error) {
			turn.status = session.cancelRequested ? "cancelled" : "failed";
			turn.error = error instanceof Error ? error.message : String(error);
		} finally {
			releaseMcp?.();
			session.mcpAbort = undefined;
			try {
				await rejectSessionInteractions(session.id, new Error("回合已结束"));
			} catch {
				storageFailed = true;
			}
			if (session.jobInterruption) {
				session.agent = undefined;
				turn.status = session.cancelRequested ? "cancelled" : "interrupted";
				turn.error = session.cancelRequested ? undefined : session.jobInterruption;
			}
			session.updatedAt = Date.now();
			try {
				const records =
					session.cancelRequested && session.turnCheckpoint?.jobs?.length ? await closeCancelledJobs(session) : [];
				if (turn.status !== "interrupted") session.turnCheckpoint = undefined;
				await persist(session, false, undefined, records);
			} catch {
				turn.status = "failed";
				turn.error = "会话写入失败，请检查存储后重启服务。";
			}
			// Agent's agent_end listeners have settled; only now may another submit be admitted.
			try {
				if (session.jobInterruption) await publish(session, "snapshot", { type: "history.reset" });
				await publish(session, "turn.settled");
			} catch {
				storageFailed = true;
				turn.status = "failed";
				turn.error = "无法读取会话结果，请检查存储后重启运行时。";
			}
		}
		if (session.kind === "subagent") {
			const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
			return message?.role === "assistant"
				? contentText(message.content) || "Subagent 已完成任务。"
				: "Subagent 已完成任务。";
		}
	}
	function startRun(session: Session) {
		const pending = run(session).finally(() => {
			if (session.runPromise !== pending) return;
			session.runPromise = undefined;
			releaseSession(session);
		});
		session.runPromise = pending;
		return pending;
	}

	let commands = Promise.resolve();
	function execute<Result>(operation: () => Promise<Result>, mutating: boolean): Promise<Result> {
		queuedCommands++;
		const result = commands.then(async () => {
			try {
				if (closing) throw new RuntimeError(503, "运行时正在关闭");
				if (mutating && storageFailed) throw new RuntimeError(503, "存储不可用，请检查后重启运行时");
				commandActive = true;
				return await operation();
			} finally {
				commandActive = false;
				queuedCommands--;
				if (options.sessionRetention === "release-after-turn" && queuedCommands === 0)
					for (const session of sessions.values()) releaseSession(session);
			}
		});
		commands = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async function requireSession(id: string): Promise<Session> {
		const session = sessions.get(id);
		if (session) return session;
		const metadata = await store.readSession(id);
		if (!metadata) throw new RuntimeError(404, "会话不存在");
		if (metadata.turn?.status === "running")
			throw new RuntimeError(409, "持久会话仍有运行中回合，请由宿主完成归属核对与启动恢复后重试");
		const loaded: Session = {
			...structuredClone(metadata),
			messages: [],
			tree: { nodes: [], leafId: metadata.leafId },
			historyLoaded: false,
			cancelRequested: false,
			clients: new Set(),
		};
		sessions.set(id, loaded);
		return loaded;
	}
	function metadata(session: Session): SessionMetadata {
		return {
			...summary(session),
			astronSessionId: session.astronSessionId,
			assistant: session.assistant,
			revision: session.revision,
			runtime: session.runtime,
			activities: session.activities,
			compaction: session.compaction,
			turnCheckpoint: session.turnCheckpoint,
			transferBaseMessageCount: session.transferBaseMessageCount,
			leafId: session.tree?.leafId ?? null,
		};
	}
	return {
		get info() {
			return { ...factory.info, persistence: store.persistence };
		},
		get storageAvailable() {
			return !storageFailed;
		},
		get tools() {
			return structuredClone(factory.toolCatalog);
		},
		listSessionMetadata() {
			return execute(async () => {
				const result: SessionMetadata[] = [];
				let cursor: SessionCursor | undefined;
				do {
					const page = await store.listSessions({ limit: 200, cursor });
					for (const saved of page.sessions) {
						const loaded = sessions.get(saved.id);
						result.push(loaded ? metadata(loaded) : saved);
					}
					cursor = page.nextCursor ?? undefined;
				} while (cursor);
				return structuredClone(result);
			}, false);
		},
		listSessions(
			filter: { assistantId?: string; includeSubagents?: boolean; limit?: number; cursor?: SessionCursor } = {},
		) {
			return execute(async () => {
				const { assistantId, includeSubagents, limit = 50, cursor } = filter;
				if (
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 200 ||
					(cursor !== undefined &&
						(!cursor ||
							!Number.isSafeInteger(cursor.updatedAt) ||
							cursor.updatedAt < 0 ||
							typeof cursor.id !== "string" ||
							!cursor.id))
				)
					throw new RuntimeError(400, "会话分页需要 1–200 条及有效游标");
				const page = await store.listSessions({
					limit,
					cursor,
					assistantId,
					kind: includeSubagents ? undefined : "root",
				});
				return {
					sessions: structuredClone(page.sessions.map((saved) => summary(sessions.get(saved.id) ?? saved))),
					nextCursor: page.nextCursor,
				};
			}, false);
		},
		registerHostRuntimes(values: readonly HostRuntimeDefinition[]) {
			return execute(async () => {
				if (!Array.isArray(values)) throw new RuntimeError(400, "runtimes 需要数组");
				const registry = parseHostRuntimeRegistry(values);
				const definitions = [...registry.values()];
				await options.saveHostRuntimes?.(definitions);
				hostRuntimes.clear();
				for (const [id, definition] of registry) hostRuntimes.set(id, definition);
				factory.mcp.configure(definitions.map((definition) => definition.runtime.mcp ?? {}));
				return {
					runtimes: definitions.map(({ assistantId, assistantRevision }) => ({
						assistantId,
						assistantRevision,
					})),
				};
			}, true);
		},
		createSession(body: CreateSessionInput) {
			return execute(async () => {
				if (Reflect.get(body, "runtime") !== undefined || Reflect.get(body, "assistantRevision") !== undefined)
					throw new RuntimeError(400, "runtime 由 /host-runtimes 注册，Session 不接受内联运行配置");
				if (
					body.assistantId !== undefined &&
					(typeof body.assistantId !== "string" || !body.assistantId.trim() || body.assistantId.length > 256)
				)
					throw new RuntimeError(400, "assistantId 需要 1–256 个字符");
				const defaultAssistant = options.assistants?.list()[0];
				const assistantId = (body.assistantId as string | undefined) ?? defaultAssistant?.id;
				if (!assistantId) throw new RuntimeError(400, "请选择有效助手");
				const localAssistant = options.assistants?.list().find((assistant) => assistant.id === assistantId);
				const hostDefinition = hostRuntimes.get(assistantId);
				if (!hostDefinition && !localAssistant) throw new RuntimeError(400, "请选择有效助手");
				const title = body.title ?? "新会话";
				if (typeof title !== "string" || !title.trim() || title.length > 100)
					throw new RuntimeError(400, "会话标题需要 1–100 个字符");
				if (
					body.workspacePath !== undefined &&
					(typeof body.workspacePath !== "string" ||
						!body.workspacePath.trim() ||
						body.workspacePath.length > 4096)
				)
					throw new RuntimeError(400, "workspacePath 需要 1–4096 个字符");
				const mode = body.mode ?? "faux";
				if (mode !== "faux" && mode !== "real") throw new RuntimeError(400, "mode 必须为 faux 或 real");
				let model: { provider: string; id: string } | undefined;
				if (body.model !== undefined) {
					const value = body.model;
					if (
						!value ||
						typeof value !== "object" ||
						!("provider" in value) ||
						!("id" in value) ||
						typeof value.provider !== "string" ||
						typeof value.id !== "string"
					)
						throw new RuntimeError(400, "model 需要 provider 和 id");
					model = { provider: value.provider, id: value.id };
				}
				if (mode === "real" && !model && !factory.info.realModel)
					throw new RuntimeError(400, factory.info.realModelError ?? "真实模型未配置");
				const id = randomUUID();
				const runtime = hostDefinition
					? hydrateHostRuntime(hostDefinition, hostRuntimes)
					: localRuntime(localAssistant!);
				const assistantRevision = hostDefinition?.assistantRevision ?? String(localAssistant!.updatedAt);
				let session: Session;
				const agent = factory.create(
					mode,
					id,
					runtime,
					model,
					[],
					async (activity) => await recordActivity(session, activity),
					(request, signal) => requestInteraction(session, request, signal),
					(toolCallId, binding, description, prompt, options, signal) =>
						runSubagent(session, toolCallId, binding, description, prompt, options, signal),
					{
						update: async (next, source, projected) => await updateCompaction(session, next, source, projected),
						report: async (event) => await publish(session, event.type, event),
					},
					{
						directory: typeof body.workspacePath === "string" ? body.workspacePath.trim() : process.cwd(),
						jobs,
						notifyBackground: (message) => notifyBackground(session, message),
						runJob: options.jobs ? (toolCallId, signal) => runJob(session, toolCallId, signal) : undefined,
					},
				);
				session = {
					id,
					kind: "root",
					mode,
					assistantId,
					assistantRevision,
					runtimeSource: hostDefinition ? "host" : "local",
					assistant: localAssistant && !hostDefinition ? structuredClone(localAssistant) : undefined,
					title: title.trim(),
					workspacePath: typeof body.workspacePath === "string" ? body.workspacePath.trim() : undefined,
					model: agent.state.model.id,
					provider: agent.state.model.provider,
					modelOverride: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messages: [],
					runtime,
					activities: [],
					revision: 0,
					cancelRequested: false,
					clients: new Set(),
				};
				// Retain the applied runtime and model selection; local Assistant changes are resolved before the next turn.
				await attachAgent(session, agent);
				await persist(session);
				sessions.set(id, session);
				return await snapshot(session);
			}, true);
		},
		getSession(sessionId: string, options?: { limit: number }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (options) validateHistoryOptions(options);
				return await snapshot(session, options);
			}, false);
		},
		exportSession(sessionId: string) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行，不能导出");
				await session.runPromise;
				return exportSession({ ...session, messages: await fullHistory(session) });
			}, false);
		},
		forkSession(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if ("beforeMessageId" in body) {
					const messages = await fullHistory(session);
					const index =
						body.beforeMessageId === null
							? messages.length
							: messages.findIndex((message) => historyMessageId(message) === body.beforeMessageId);
					if (index < 0) throw new RuntimeError(400, "分叉边界消息不存在");
					return await forkSession(session, index, body.title, true);
				}
				if (typeof body.messageIndex !== "number")
					throw new RuntimeError(400, "messageIndex 需要指向有效的用户消息");
				return await forkSession(session, body.messageIndex, body.title);
			}, true);
		},
		getTree(sessionId: string) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				return sessionTree(await store.readTree(session.id));
			}, false);
		},
		readToolExecutions(sessionId: string, options: ToolExecutionReadOptions) {
			return execute(async () => {
				try {
					validateToolExecutionRead(options);
				} catch (error) {
					throw new RuntimeError(400, error instanceof Error ? error.message : String(error));
				}
				const session = await requireSession(sessionId);
				return store.readToolExecutions(session.id, options);
			}, false);
		},
		readHistory(sessionId: string, options: { limit: number; beforeSeq?: number; leafId?: string | null }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				validateHistoryOptions(options);
				const leafId = options.leafId === undefined ? (session.tree?.leafId ?? null) : options.leafId;
				const revision = session.revision;
				const page = await store.readHistory(session.id, { ...options, leafId });
				return {
					...page,
					instanceId,
					revision,
					leafId,
					entries: page.entries.flatMap((entry) => {
						const message = displayAgentMessages([entry.message])[0];
						return message ? [{ ...entry, message }] : [];
					}),
				};
			}, false);
		},
		selectTree(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind !== "root") throw new RuntimeError(409, "子会话不能切换分支");

				if (session.turn?.status === "running" || session.turn?.status === "interrupted")
					throw new RuntimeError(409, "请先结束或取消当前 Turn，再切换分支");
				await session.runPromise;
				const tree = await store.readTree(session.id);
				const selected = tree.nodes.find((node) =>
					"entryId" in body ? node.id === body.entryId : historyMessageId(node.message) === body.messageId,
				);
				if (!selected) throw new RuntimeError(400, "会话树节点不存在");
				const leafId = selected.message.role === "user" ? selected.parentId : selected.id;
				const path = treePath(tree, leafId);
				const messages = path.map((node) => structuredClone(node.message));
				for (const [index, message] of messages.entries()) entryIds.set(message, path[index].id);
				if (!completeToolHistory(messages)) throw new RuntimeError(409, "不能切换到未完成的工具调用");
				const previous = { ...session };
				session.tree = { leafId, nodes: [] };
				session.historyLoaded = true;
				session.agent = undefined;
				session.messages = messages;
				session.turn = undefined;
				session.turnCheckpoint = undefined;
				session.compaction = undefined;
				session.transferBase = undefined;
				session.transferBaseMessageCount = undefined;
				session.updatedAt = Date.now();
				try {
					await persist(session);
				} catch (error) {
					Object.assign(session, previous);
					throw error;
				}
				await publish(session, "snapshot", { type: "history.reset" });
				const displayed = displayAgentMessages([selected.message])[0];
				return {
					session: await snapshot(session),
					selectedText: selected.message.role === "user" && displayed ? contentText(displayed.content) : "",
				};
			}, true);
		},
		importSession(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话不能导入历史");
				if (session.turn?.status === "running" || session.turn?.status === "interrupted")
					throw new RuntimeError(409, "请先结束或取消当前 Turn，再导入历史");
				await session.runPromise;
				const transfer = parseSessionTransfer(body);
				const importedMessages = transferToAgentMessages(transfer);
				const previous = {
					agent: session.agent,
					historyLoaded: session.historyLoaded,
					astronSessionId: session.astronSessionId,
					title: session.title,
					workspacePath: session.workspacePath,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					messages: session.messages,
					tree: session.tree,
					activities: session.activities,
					compaction: session.compaction,
					transferBase: session.transferBase,
					transferBaseMessageCount: session.transferBaseMessageCount,
					modelOverride: session.modelOverride,
				};
				session.agent = undefined;
				session.astronSessionId = transfer.source.astronSessionId;
				session.title = transfer.title ?? session.title;
				session.workspacePath = transfer.workspacePath ?? session.workspacePath;
				session.createdAt = transfer.createdAt ?? session.createdAt;
				session.updatedAt = transfer.updatedAt ?? Date.now();
				session.messages = importedMessages;
				session.historyLoaded = true;
				session.tree = undefined;
				session.activities = [];
				session.compaction = undefined;
				session.transferBase = structuredClone(transfer.transcript);
				session.transferBaseMessageCount = importedMessages.length;
				session.modelOverride = transfer.modelOverride ?? null;
				try {
					await persist(session, true);
				} catch (error) {
					Object.assign(session, previous);
					throw error;
				}
				await publish(session, "snapshot", { type: "history.reset" });
				const result: SessionTransfer = exportSession({ ...session, messages: await fullHistory(session) });
				return { session: await snapshot(session), transfer: result };
			}, true);
		},
		setModelOverride(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话为只读会话");

				if (!("modelOverride" in body)) throw new RuntimeError(400, "需要 modelOverride 字段");
				const selection = parseSessionModelOverride(body.modelOverride);
				if (body.initializeOnly === true && "modelOverride" in session) return await snapshot(session);
				const previous = { modelOverride: session.modelOverride, updatedAt: session.updatedAt };
				const initialized = "modelOverride" in session;
				session.modelOverride = selection ?? null;
				session.updatedAt = Date.now();
				try {
					await persist(session);
				} catch (error) {
					Object.assign(session, previous);
					if (!initialized) delete session.modelOverride;
					throw error;
				}
				await publish(session, "snapshot");
				return await snapshot(session);
			}, true);
		},
		renameSession(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话为只读会话");

				if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 100)
					throw new RuntimeError(400, "会话标题需要 1–100 个字符");
				if (session.turn?.status === "running") throw new RuntimeError(409, "请在执行结束后重命名");
				await session.runPromise;
				const previous = session.title;
				session.title = body.title.trim();
				session.updatedAt = Date.now();
				try {
					await persist(session);
				} catch (error) {
					session.title = previous;
					throw error;
				}
				await publish(session, "snapshot");
				return await snapshot(session);
			}, true);
		},
		cancelTurn(sessionId: string, body: { turnId: string }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "请取消父会话");

				if (!session.turn || body.turnId !== session.turn.id) throw new RuntimeError(409, "turnId 不匹配");
				if (session.turn.status === "running") {
					session.cancelRequested = true;
					if (session.turnCheckpoint) session.turnCheckpoint.cancelRequested = true;
					if (session.turnCheckpoint?.jobs?.length) {
						await persist(session);
						try {
							await cancelJobs(session);
						} finally {
							session.jobInterruption = "外部任务取消已请求";
							session.agent?.abort();
							session.mcpAbort?.abort();
						}
					}
					session.agent?.clearAllQueues();
					session.agent?.abort();
					session.mcpAbort?.abort();
					await rejectSessionInteractions(session.id, new Error("会话已取消"));
					await persist(session);
				} else if (session.turn.status === "interrupted") {
					let records: ToolExecutionRecord[] = [];
					const previous = {
						turn: session.turn,
						turnCheckpoint: session.turnCheckpoint,
						updatedAt: session.updatedAt,
					};
					if (session.turnCheckpoint?.jobs?.length) {
						session.turnCheckpoint.cancelRequested = true;
						await persist(session);
						await cancelJobs(session);
						records = await closeCancelledJobs(session);
					}
					session.turn = { ...session.turn, status: "cancelled", error: undefined };
					session.turnCheckpoint = undefined;
					session.updatedAt = Date.now();
					try {
						await persist(session, false, undefined, records);
					} catch (error) {
						Object.assign(session, previous);
						throw error;
					}
					await publish(session, "turn.settled");
				}
				return { sessionId: session.id, turnId: session.turn.id };
			}, true);
		},
		steer(sessionId: string, body: TurnInput & { turnId: string }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话由父会话通过 task 管理");

				const content = turnContent(body);
				if (!session.turn || session.turn.status !== "running")
					throw new RuntimeError(409, "当前会话没有正在执行的回合");
				if (body.turnId !== session.turn.id) throw new RuntimeError(409, "turnId 不匹配");
				const requestId = optionalRequestId(body);
				const messageIdentity = optionalMessageIdentity(body);
				if (session.turnCheckpoint) {
					session.turnCheckpoint.blockedReason = "包含尚未持久化的 Steer 队列";
					await persist(session);
				}
				const agent = await attachAgent(session);
				const userMessage: Extract<AgentMessage, { role: "user" }> & {
					displayContent?: string;
				} & UserMessageIdentity = {
					role: "user",
					content,
					timestamp: Date.now(),
					...messageIdentity,
				};
				if (typeof body.displayText === "string") userMessage.displayContent = body.displayText;
				if (requestId) session.turn.requestId = requestId;
				agent.steer(userMessage);
				return { sessionId: session.id, turnId: session.turn.id, requestId };
			}, true);
		},
		replyInteraction(sessionId: string, interactionId: string, body: { approved: boolean }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (!interactionId) throw new RuntimeError(404, "交互不存在");

				if (typeof body.approved !== "boolean") throw new RuntimeError(400, "approved 必须为布尔值");
				const pending = pendingInteractions.get(interactionId);
				if (!pending || pending.sessionId !== session.id) throw new RuntimeError(404, "交互不存在");
				if (pending.turnId !== session.turn?.id) throw new RuntimeError(409, "交互已失效");
				await settleInteraction(
					interactionId,
					body.approved,
					body.approved ? undefined : new Error("用户拒绝了操作"),
				);
				return { sessionId: session.id, interactionId, approved: body.approved };
			}, true);
		},
		resumeTurn(sessionId: string, body: { turnId: string }) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (!session.turn || body.turnId !== session.turn.id) throw new RuntimeError(409, "turnId 不匹配");
				if (session.turn.status !== "interrupted") throw new RuntimeError(409, "当前 Turn 不可恢复");
				await session.runPromise;
				const tree = session.turnCheckpoint?.inputEntryId
					? await store.readTurnPath(session.id, session.turnCheckpoint.inputEntryId)
					: await store.readPath(session.id);
				const recovered = recoverInterruptedTurn({ ...session, leafId: tree.leafId }, tree);
				if (!recovered || (recovered.status !== "interrupted" && recovered.status !== "completed"))
					throw new RuntimeError(409, recovered?.error ?? "当前 Turn 不在可恢复边界");
				const calls = new Map(
					tree.nodes.flatMap(({ message }) =>
						message.role === "assistant"
							? message.content.flatMap((part) =>
									part.type === "toolCall" ? [[part.id, part.name] as const] : [],
								)
							: [],
					),
				);
				const savedResults = new Map(
					tree.nodes.flatMap(({ message }) =>
						message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
					),
				);
				const externalIds = new Map((session.turnCheckpoint?.jobs ?? []).map((job) => [job.toolCallId, job.id]));
				let afterSeq: number | undefined;
				do {
					const page = await store.readToolExecutions(session.id, {
						turnId: session.turn.id,
						limit: 200,
						afterSeq,
					});
					for (const record of page.entries) {
						try {
							validateToolExecutionRecord(record, session.id, session.turn.id);
							const result = savedResults.get(record.toolCallId);
							if (
								calls.get(record.toolCallId) !== record.toolName ||
								(record.externalId !== undefined && record.externalId !== externalIds.get(record.toolCallId)) ||
								((record.phase === "completed" || record.phase === "failed") &&
									(!result ||
										result.toolName !== record.toolName ||
										result.isError !== (record.phase === "failed")))
							)
								throw new Error("工具执行账本与历史或外部关联不一致");
						} catch (error) {
							throw new RuntimeError(409, error instanceof Error ? error.message : String(error));
						}
					}
					afterSeq = page.nextAfterSeq ?? undefined;
				} while (afterSeq !== undefined);
				const results: AgentMessage[] = [];
				const records: ToolExecutionRecord[] = [];
				for (const reference of await pendingJobs(session)) {
					if (!options.jobs) throw new RuntimeError(409, "宿主未配置外部任务执行器");
					const job = await options.jobs.get(reference);
					let result: ReturnType<typeof durableJobResult>;
					try {
						result = durableJobResult(reference, job);
					} catch (error) {
						if (error instanceof DurableJobError) throw new RuntimeError(409, error.message);
						throw error;
					}
					if (!result) throw new RuntimeError(409, "外部任务仍在运行，请稍后查询后恢复");
					results.push(result);
					records.push(
						executionRecord(
							session,
							reference.toolCallId,
							reference.toolName,
							result.isError ? "failed" : "completed",
						),
					);
				}
				await loadHistory(session);
				const previous = {
					turn: session.turn,
					turnCheckpoint: session.turnCheckpoint,
					agent: session.agent,
					updatedAt: session.updatedAt,
					messages: session.messages,
					jobInterruption: session.jobInterruption,
				};
				session.jobInterruption = undefined;
				if (recovered.status === "interrupted") {
					session.messages = [...session.messages, ...results];
					const agent = createSessionAgent(session, session.runtime!);
					agent.state.systemPrompt = session.turnCheckpoint!.systemPrompt;
					bindAgent(session, agent);
					session.turn = { ...recovered, status: "running" };
				} else {
					session.turn = recovered;
					session.turnCheckpoint = undefined;
				}
				session.cancelRequested = false;
				session.updatedAt = Date.now();
				try {
					await persist(session, false, undefined, records);
				} catch (error) {
					Object.assign(session, previous);
					throw error;
				}
				await publish(session, recovered.status === "completed" ? "turn.settled" : "snapshot");
				for (const result of results)
					await publish(
						session,
						"agent.event",
						projectSessionAgentEvent({ type: "message_end", message: result }),
					);
				const accepted = { sessionId: session.id, turnId: session.turn.id, requestId: session.turn.requestId };
				if (session.turn.status === "running") startRun(session);
				return accepted;
			}, true);
		},
		submitTurn(sessionId: string, body: TurnInput) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话由父会话通过 task 管理");

				const content = turnContent(body);
				if (
					body.systemPrompt !== undefined &&
					(typeof body.systemPrompt !== "string" || body.systemPrompt.length > 60000)
				)
					throw new RuntimeError(400, "systemPrompt 需要字符串，最多 60000 字符");
				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行");
				if (session.turn?.status === "interrupted") throw new RuntimeError(409, "请先恢复或取消中断的 Turn");
				await session.runPromise;
				const requestId = optionalRequestId(body);
				const messageIdentity = optionalMessageIdentity(body);
				const configuration = resolveTurnConfiguration(session, body);
				await loadHistory(session);
				const oldAgent = session.agent;
				const oldSavedMessages = session.messages;
				const oldMessages = oldAgent?.state.messages ?? oldSavedMessages;
				const oldTurn = session.turn;
				const oldCheckpoint = session.turnCheckpoint;
				session.jobInterruption = undefined;
				const oldAssistant = session.assistant;
				const oldAssistantRevision = session.assistantRevision;
				const oldRuntimeSource = session.runtimeSource;
				const oldRuntime = session.runtime;
				const oldModel = session.model;
				const oldProvider = session.provider;
				let selectedModel = session.modelOverride
					? { provider: session.modelOverride.providerId, id: session.modelOverride.model }
					: (factory.settings.current.selected ?? null);
				if (body.model !== undefined) {
					const value = body.model;
					if (
						!value ||
						typeof value !== "object" ||
						!("provider" in value) ||
						!("id" in value) ||
						typeof value.provider !== "string" ||
						typeof value.id !== "string" ||
						!value.provider.trim() ||
						!value.id.trim()
					)
						throw new RuntimeError(400, "model 需要 provider 和 id");
					selectedModel = { provider: value.provider, id: value.id };
				}
				const configurationChanged =
					!oldAgent ||
					configuration.runtimeSource !== oldRuntimeSource ||
					configuration.assistantRevision !== oldAssistantRevision ||
					JSON.stringify(configuration.runtime) !== JSON.stringify(oldRuntime) ||
					Boolean(selectedModel && (selectedModel.id !== oldModel || selectedModel.provider !== oldProvider));
				const agent = configurationChanged
					? createSessionAgent(session, configuration.runtime, oldMessages, selectedModel)
					: oldAgent;
				session.assistant = configuration.assistant;
				session.assistantRevision = configuration.assistantRevision;
				session.runtimeSource = configuration.runtimeSource;
				session.runtime = configuration.runtime;
				session.model = agent.state.model.id;
				session.provider = agent.state.model.provider;
				if (configurationChanged) bindAgent(session, agent);
				const now = Date.now();
				const userMessage: Extract<AgentMessage, { role: "user" }> & {
					displayContent?: string;
				} & UserMessageIdentity = {
					role: "user",
					content,
					timestamp: now,
					...messageIdentity,
				};
				if (typeof body.displayText === "string") userMessage.displayContent = body.displayText;
				agent.state.messages = [...oldMessages, userMessage];
				session.turn = { id: randomUUID(), requestId, status: "running" };
				const update = historyUpdate(session, agent.state.messages);
				const systemPrompt = factory.composeSystemPrompt(
					configuration.runtime,
					typeof body.systemPrompt === "string" ? body.systemPrompt : configuration.runtime.systemPrompt,
				);
				session.turnCheckpoint = {
					version: 1,
					turnId: session.turn.id,
					inputEntryId: update.identities.get(userMessage)!,
					systemPrompt,
					blockedReason: jobs.list(session.id).some((job) => job.status === "running")
						? "存在先前尚未结束的后台任务"
						: undefined,
				};
				session.updatedAt = now;
				session.cancelRequested = false;
				try {
					await persist(session, false, update);
				} catch (error) {
					agent.state.messages = oldMessages;
					session.agent = oldAgent;
					session.messages = oldSavedMessages;
					session.assistant = oldAssistant;
					session.assistantRevision = oldAssistantRevision;
					session.runtimeSource = oldRuntimeSource;
					session.runtime = oldRuntime;
					session.model = oldModel;
					session.provider = oldProvider;
					session.turn = oldTurn;
					session.turnCheckpoint = oldCheckpoint;
					throw error;
				}
				agent.state.systemPrompt = systemPrompt;
				await publish(session, "snapshot", projectSessionAgentEvent({ type: "message_end", message: userMessage }));
				const accepted = { sessionId: session.id, turnId: session.turn.id, requestId };
				startRun(session);
				return accepted;
			}, true);
		},
		deleteSession(sessionId: string) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话随父会话删除");
				if (session.turn?.status === "running" || jobs.list(session.id).some((job) => job.status === "running"))
					throw new RuntimeError(409, "请先停止当前执行及后台任务");
				await session.runPromise;
				const children: string[] = [];
				let cursor: SessionCursor | undefined;
				do {
					const page = await store.listSessions({ limit: 200, cursor, parentSessionId: session.id });
					for (const child of page.sessions) {
						const loaded = sessions.get(child.id);
						if ((loaded ?? child).turn?.status === "running" || loaded?.runPromise)
							throw new RuntimeError(409, "请先停止子会话执行");
						children.push(child.id);
					}
					cursor = page.nextCursor ?? undefined;
				} while (cursor);
				for (const id of children) {
					await store.deleteSession(id);
					for (const client of sessions.get(id)?.clients ?? []) closeSubscriber(client);
					sessions.delete(id);
				}
				await store.deleteSession(session.id);
				for (const client of session.clients) closeSubscriber(client);
				sessions.delete(session.id);
				return { deleted: true };
			}, true);
		},
		subscribe(sessionId: string, next: (event: SessionEvent) => void, onClose: () => void = () => {}) {
			return execute(async () => {
				const session = await requireSession(sessionId);
				const subscriber = { next, close: onClose };
				session.clients.add(subscriber);
				return () => {
					session.clients.delete(subscriber);
					releaseSession(session);
				};
			}, false);
		},
		subscribeAll(next: (event: GlobalSessionEvent) => void, onClose: () => void = () => {}) {
			if (closing) throw new RuntimeError(503, "运行时正在关闭");
			const subscriber = { next, close: onClose };
			globalClients.add(subscriber);
			return () => {
				globalClients.delete(subscriber);
			};
		},
		waitForTurn(sessionId: string) {
			const pending = (async () => {
				if (closing) throw new RuntimeError(503, "运行时正在关闭");
				let session = sessions.get(sessionId);
				if (session) session.waiters = (session.waiters ?? 0) + 1;
				else
					session = await execute(async () => {
						const loaded = await requireSession(sessionId);
						loaded.waiters = (loaded.waiters ?? 0) + 1;
						return loaded;
					}, false);
				try {
					await session.runPromise;
					return await snapshot(session);
				} finally {
					session.waiters = (session.waiters ?? 1) - 1;
					releaseSession(session);
				}
			})();
			waitingReads.add(pending);
			return pending.finally(() => waitingReads.delete(pending));
		},
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				await commands;
				jobs.close();
				for (const client of globalClients) closeSubscriber(client);
				globalClients.clear();
				const settlements: Promise<unknown>[] = [];
				for (const session of sessions.values()) {
					if (
						session.turn?.status === "running" &&
						session.turnCheckpoint?.jobs?.length &&
						!session.cancelRequested
					)
						session.jobInterruption = "服务关闭，外部任务保留，等待新实例查询结果";
					else session.cancelRequested = true;
					session.agent?.abort();
					session.mcpAbort?.abort();
					settlements.push(rejectSessionInteractions(session.id, new Error("运行时正在关闭")));
					if (session.runPromise) settlements.push(session.runPromise);
					for (const client of session.clients) closeSubscriber(client);
					session.clients.clear();
				}
				await Promise.allSettled(settlements);
				await Promise.allSettled(waitingReads);
				try {
					await factory.mcp.close();
				} finally {
					await store.close();
				}
			})();
			return closePromise;
		},
	};
}

export async function createRuntime(options: RuntimeOptions) {
	try {
		return await initializeRuntime(options);
	} catch (error) {
		await Promise.allSettled([options.agents.mcp.close(), options.store.close()]);
		throw error;
	}
}

export type PieRuntime = Awaited<ReturnType<typeof createRuntime>>;
