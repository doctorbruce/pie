import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { createAgentFactory } from "./agent.ts";
import type { AssistantSource } from "./capabilities.ts";
import { checkpointMessage, isContextCheckpoint } from "./compaction.ts";
import { hydrateHostRuntime, parseHostRuntimeDefinition, SkillConfigError } from "./config.ts";
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
	SessionSummary,
	SessionTransfer,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import type { RuntimeStore, SavedSession } from "./runtime-store.ts";
import {
	displayAgentMessages,
	exportSession,
	parseSessionModelOverride,
	parseSessionTransfer,
	transferToAgentMessages,
} from "./session-transfer.ts";
import { completeToolHistory, historyMessageId, type MessageTree, sessionTree, treePath } from "./session-tree.ts";

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
	hostRuntimes?: readonly HostRuntimeDefinition[];
	saveHostRuntimes?: (definitions: readonly HostRuntimeDefinition[]) => Promise<void>;
	assistants?: AssistantSource;
};

async function initializeRuntime(options: RuntimeOptions) {
	const { agents: factory, store } = options;
	const initial = await store.loadSessions();
	if (initial.some((session) => session.turn?.status === "running"))
		throw new RuntimeError(409, "持久会话仍有运行中回合，请由宿主完成归属核对与启动恢复后重试");
	const instanceId = randomUUID();
	const jobs = new BackgroundJobs();
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
		mcpAbort?: AbortController;
		agent?: ReturnType<typeof factory.create>;
		cancelRequested: boolean;
		clients: Set<RuntimeSubscriber>;
		runPromise?: Promise<void>;
		writePromise?: Promise<void>;
		publishPromise?: Promise<void>;
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
	const sessions = new Map<string, Session>(
		initial.map((session) => [
			session.id,
			{
				...session,
				messages: [],
				tree: { nodes: [], leafId: session.leafId },
				historyLoaded: false,
				cancelRequested: false,
				clients: new Set<RuntimeSubscriber>(),
			},
		]),
	);
	const pendingInteractions = new Map<string, PendingInteraction>();
	const entryIds = new WeakMap<AgentMessage, string>();
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
	function summary(session: Session): SessionSummary {
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
	async function persist(session: Session, replaceHistory = false, update?: ReturnType<typeof historyUpdate>) {
		const pending = (session.writePromise ?? Promise.resolve()).then(async () => {
			await loadHistory(session);
			const messages = session.agent?.state.messages ?? session.messages;
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
						transferBase: session.transferBase,
						transferBaseMessageCount: session.transferBaseMessageCount,
					},
					replaceHistory,
				);
			} catch (error) {
				storageFailed = true;
				throw error;
			}
			session.messages = messages;
			session.tree = { nodes: [], leafId: tree.leafId };
			session.transferBase = undefined;
			for (const [message, id] of identities) entryIds.set(message, id);
		});
		session.writePromise = pending.catch(() => {});
		await pending;
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
			},
		);
	}
	async function notifyBackground(session: Session, text: string) {
		if (closing) return;
		const agent = await attachAgent(session);
		const content = [{ type: "text" as const, text, synthetic: true as const }];
		agent.followUp({ role: "user", content, timestamp: Date.now() });
		if (agent.state.isStreaming || session.turn?.status === "running") return;
		session.turn = { id: randomUUID(), status: "running" };
		session.cancelRequested = false;
		session.updatedAt = Date.now();
		await persist(session);
		await publish(session, "snapshot");
		session.runPromise = run(session);
		await session.runPromise;
	}
	function bindAgent(session: Session, agent: ReturnType<typeof factory.create>) {
		session.agent = agent;
		agent.subscribe(async (event) => {
			if (event.type === "message_end") await persist(session);
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
	async function snapshot(session: Session): Promise<SessionSnapshot> {
		const messages = await fullHistory(session);
		return structuredClone({
			instanceId,
			...summary(session),
			assistant: session.assistant,
			revision: session.revision,
			messages: displayAgentMessages(messages),
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
			if (session.clients.size) notifySubscribers(session.clients, { ...packet, snapshot: await snapshot(session) });
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
		let child: Session;
		if (options.taskId) {
			const existing = sessions.get(options.taskId);
			if (!existing || existing.kind !== "subagent" || existing.parentSessionId !== parent.id)
				throw new Error(`不可继续的 task_id：${options.taskId}`);
			if (existing.subagentType !== binding.id || existing.assistantId !== binding.assistantId)
				throw new Error("task_id 与指定 Subagent 不匹配");
			if (existing.turn?.status === "running") throw new Error(`Subagent 仍在运行：${existing.id}`);
			child = existing;
			const agent = await attachAgent(child);
			agent.state.messages = [...agent.state.messages, { role: "user", content: prompt, timestamp: Date.now() }];
			child.turn = { id: randomUUID(), status: "running" };
			child.cancelRequested = false;
			child.updatedAt = Date.now();
			await persist(child);
			await publish(child, "snapshot");
		} else {
			const id = randomUUID();
			const now = Date.now();
			const runtime = { ...structuredClone(binding.runtime), subagents: [] };
			const selected =
				binding.model ??
				(parent.mode === "real" && parent.provider ? { provider: parent.provider, id: parent.model } : undefined);
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
				try {
					child.runPromise = run(child);
					await child.runPromise;
				} finally {
					jobSignal.removeEventListener("abort", abortChild);
				}
				if (child.turn?.status !== "completed")
					throw new Error(
						`Subagent 执行${child.turn?.status === "cancelled" ? "已取消" : "失败"}（${child.id}）：${child.turn?.error ?? "没有完成"}`,
					);
				const message = [...(child.agent?.state.messages ?? [])]
					.reverse()
					.find((item) => item.role === "assistant");
				const output =
					message?.role === "assistant"
						? contentText(message.content) || "Subagent 已完成任务。"
						: "Subagent 已完成任务。";
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
			} while (agent.hasQueuedMessages() && !session.cancelRequested);
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
			session.updatedAt = Date.now();
			try {
				await persist(session);
			} catch {
				turn.status = "failed";
				turn.error = "会话写入失败，请检查存储后重启服务。";
			}
			// Agent's agent_end listeners have settled; only now may another submit be admitted.
			try {
				await publish(session, "turn.settled");
			} catch {
				storageFailed = true;
				turn.status = "failed";
				turn.error = "无法读取会话结果，请检查存储后重启运行时。";
			}
		}
	}

	let commands = Promise.resolve();
	function execute<Result>(operation: () => Promise<Result>, mutating: boolean): Promise<Result> {
		const result = commands.then(() => {
			if (closing) throw new RuntimeError(503, "运行时正在关闭");
			if (mutating && storageFailed) throw new RuntimeError(503, "存储不可用，请检查后重启运行时");
			return operation();
		});
		commands = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	function requireSession(id: string) {
		const session = sessions.get(id);
		if (!session) throw new RuntimeError(404, "会话不存在");
		return session;
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
			return execute(
				async () =>
					structuredClone(
						[...sessions.values()].map((session) => ({
							...summary(session),
							astronSessionId: session.astronSessionId,
							assistant: session.assistant,
							revision: session.revision,
							runtime: session.runtime,
							activities: session.activities,
							compaction: session.compaction,
							transferBaseMessageCount: session.transferBaseMessageCount,
							leafId: session.tree?.leafId ?? null,
						})),
					),
				false,
			);
		},
		listSessions(filter: { assistantId?: string; includeSubagents?: boolean } = {}) {
			return execute(async () => {
				const assistantId = filter.assistantId;
				const includeSubagents = filter.includeSubagents;
				return {
					sessions: [...sessions.values()]
						.filter(
							(session) =>
								(includeSubagents || session.kind === "root") &&
								(!assistantId || session.assistantId === assistantId),
						)
						.sort((a, b) => b.updatedAt - a.updatedAt)
						.map(summary),
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
		getSession(sessionId: string) {
			return execute(async () => {
				const session = requireSession(sessionId);
				return await snapshot(session);
			}, false);
		},
		exportSession(sessionId: string) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行，不能导出");
				return exportSession({ ...session, messages: await fullHistory(session) });
			}, false);
		},
		forkSession(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = requireSession(sessionId);
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
				const session = requireSession(sessionId);
				return sessionTree(await store.readTree(session.id));
			}, false);
		},
		readHistory(sessionId: string, options: { limit: number; beforeSeq?: number; leafId?: string | null }) {
			return execute(async () => {
				const session = requireSession(sessionId);
				return await store.readHistory(session.id, options);
			}, false);
		},
		selectTree(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.kind !== "root") throw new RuntimeError(409, "子会话不能切换分支");

				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行，不能切换分支");
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
				await publish(session, "snapshot");
				const displayed = displayAgentMessages([selected.message])[0];
				return {
					session: await snapshot(session),
					selectedText: selected.message.role === "user" && displayed ? contentText(displayed.content) : "",
				};
			}, true);
		},
		importSession(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话不能导入历史");
				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行，不能导入");
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
				const result: SessionTransfer = exportSession({ ...session, messages: await fullHistory(session) });
				return { session: await snapshot(session), transfer: result };
			}, true);
		},
		setModelOverride(sessionId: string, body: Record<string, unknown>) {
			return execute(async () => {
				const session = requireSession(sessionId);
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
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话为只读会话");

				if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 100)
					throw new RuntimeError(400, "会话标题需要 1–100 个字符");
				if (session.turn?.status === "running") throw new RuntimeError(409, "请在执行结束后重命名");
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
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "请取消父会话");

				if (!session.turn || body.turnId !== session.turn.id) throw new RuntimeError(409, "turnId 不匹配");
				if (session.turn.status === "running") {
					session.cancelRequested = true;
					session.agent?.clearAllQueues();
					session.agent?.abort();
					session.mcpAbort?.abort();
					await rejectSessionInteractions(session.id, new Error("会话已取消"));
				}
				return { sessionId: session.id, turnId: session.turn.id };
			}, true);
		},
		steer(sessionId: string, body: TurnInput & { turnId: string }) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话由父会话通过 task 管理");

				const content = turnContent(body);
				if (!session.turn || session.turn.status !== "running")
					throw new RuntimeError(409, "当前会话没有正在执行的回合");
				if (body.turnId !== session.turn.id) throw new RuntimeError(409, "turnId 不匹配");
				const requestId = optionalRequestId(body);
				const messageIdentity = optionalMessageIdentity(body);
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
				const session = requireSession(sessionId);
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
		submitTurn(sessionId: string, body: TurnInput) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话由父会话通过 task 管理");

				const content = turnContent(body);
				if (
					body.systemPrompt !== undefined &&
					(typeof body.systemPrompt !== "string" || body.systemPrompt.length > 60000)
				)
					throw new RuntimeError(400, "systemPrompt 需要字符串，最多 60000 字符");
				if (session.turn?.status === "running") throw new RuntimeError(409, "当前会话正在执行");
				const requestId = optionalRequestId(body);
				const messageIdentity = optionalMessageIdentity(body);
				const configuration = resolveTurnConfiguration(session, body);
				await loadHistory(session);
				const oldAgent = session.agent;
				const oldSavedMessages = session.messages;
				const oldMessages = oldAgent?.state.messages ?? oldSavedMessages;
				const oldTurn = session.turn;
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
				session.updatedAt = now;
				session.cancelRequested = false;
				try {
					await persist(session);
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
					throw error;
				}
				agent.state.systemPrompt = factory.composeSystemPrompt(
					configuration.runtime,
					typeof body.systemPrompt === "string" ? body.systemPrompt : configuration.runtime.systemPrompt,
				);
				await publish(session, "snapshot");
				const accepted = { sessionId: session.id, turnId: session.turn.id, requestId };
				session.runPromise = run(session);
				return accepted;
			}, true);
		},
		deleteSession(sessionId: string) {
			return execute(async () => {
				const session = requireSession(sessionId);
				if (session.kind === "subagent") throw new RuntimeError(409, "子会话随父会话删除");
				if (session.turn?.status === "running") throw new RuntimeError(409, "请先停止当前执行");
				for (const child of [...sessions.values()].filter(
					(candidate) => candidate.parentSessionId === session.id,
				)) {
					await store.deleteSession(child.id);
					for (const client of child.clients) closeSubscriber(client);
					sessions.delete(child.id);
				}
				await store.deleteSession(session.id);
				for (const client of session.clients) closeSubscriber(client);
				sessions.delete(session.id);
				return { deleted: true };
			}, true);
		},
		subscribe(sessionId: string, next: (event: SessionEvent) => void, onClose: () => void = () => {}) {
			if (closing) throw new RuntimeError(503, "运行时正在关闭");
			const listeners = requireSession(sessionId).clients;
			const subscriber = { next, close: onClose };
			listeners.add(subscriber);
			return () => {
				listeners.delete(subscriber);
			};
		},
		subscribeAll(next: (event: GlobalSessionEvent) => void, onClose: () => void = () => {}) {
			if (closing) throw new RuntimeError(503, "运行时正在关闭");
			const subscriber = { next, close: onClose };
			globalClients.add(subscriber);
			return () => {
				globalClients.delete(subscriber);
			};
		},
		async waitForTurn(sessionId: string) {
			const session = requireSession(sessionId);
			await session.runPromise;
			return await snapshot(session);
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
					session.cancelRequested = true;
					session.agent?.abort();
					session.mcpAbort?.abort();
					settlements.push(rejectSessionInteractions(session.id, new Error("运行时正在关闭")));
					if (session.runPromise) settlements.push(session.runPromise);
					for (const client of session.clients) closeSubscriber(client);
					session.clients.clear();
				}
				await Promise.allSettled(settlements);
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
