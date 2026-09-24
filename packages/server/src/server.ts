import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { contentText } from "@earendil-works/pi-ai";
import { createAgentFactory } from "./agent.ts";
import { parseToolIds, ToolConfigError } from "./external-tools.ts";
import { ModelSettingsError } from "./models/settings.ts";
import { createPlugins, PluginError } from "./plugins.ts";
import type {
	ActivityRecord,
	Assistant,
	ContextCompaction,
	HostRuntimeDefinition,
	InteractionRequest,
	SessionEvent,
	SessionSnapshot,
	SessionSummary,
	SessionTransfer,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import { exportSession, parseSessionTransfer, transferToAgentMessages } from "./session-transfer.ts";
import { hydrateHostRuntime, parseHostRuntimeDefinition, SkillConfigError } from "./skills.ts";
import { openStore, type SavedSession } from "./store.ts";
import { type BackgroundJobInfo, BackgroundJobs } from "./tools/jobs.ts";

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const HOST_RUNTIME_REQUEST_LIMIT = 4 * 1024 * 1024;

async function readJson(req: IncomingMessage, maxBytes = 65536): Promise<Record<string, unknown>> {
	if (req.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new HttpError(415, "需要 application/json");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new HttpError(413, `请求超过 ${Math.floor(maxBytes / 1024)} KiB`);
		chunks.push(chunk);
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON 对象无效");
	}
}

export function createCoreServer(env: NodeJS.ProcessEnv = process.env) {
	const factory = createAgentFactory(env);
	const plugins = createPlugins(env);
	const instanceId = randomUUID();
	const store = openStore(env);
	const jobs = new BackgroundJobs();
	const assistants = new Map(store.assistants.map((assistant) => [assistant.id, assistant]));
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
	const hostRuntimes = parseHostRuntimeRegistry(store.hostRuntimes);
	function localRuntime(assistant: Assistant) {
		return {
			...plugins.runtime(assistant),
			subagents: assistant.subagentIds.map((id) => {
				const target = assistants.get(id);
				if (!target) throw new PluginError(`可调用助手不存在：${id}`);
				return {
					id: `assistant-worker-${target.id}`,
					name: target.name,
					description: `调用 ${target.name} 完成独立任务`,
					assistantId: target.id,
					assistantRevision: String(target.updatedAt),
					runtime: plugins.runtime(target),
				};
			}),
		};
	}
	type Session = SavedSession & {
		agent?: ReturnType<typeof factory.create>;
		cancelRequested: boolean;
		clients: Set<ServerResponse>;
		runPromise?: Promise<void>;
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
	// ponytail: bounded histories are loaded into memory; add pagination/eviction for large installations.
	const sessions = new Map<string, Session>(
		store.sessions.map((session) => [
			session.id,
			{
				...session,
				cancelRequested: false,
				clients: new Set<ServerResponse>(),
			},
		]),
	);
	const pendingInteractions = new Map<string, PendingInteraction>();
	const globalClients = new Set<ServerResponse>();
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
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			turn: session.turn,
		};
	}
	function forkSession(source: Session, messageIndex: number, requestedTitle: unknown) {
		if (source.kind !== "root") throw new HttpError(409, "子会话不能分叉");
		if (source.turn?.status === "running") throw new HttpError(409, "当前会话正在执行，不能分叉");
		if (sessions.size >= 32) throw new HttpError(409, "最多 32 个会话，请删除旧会话");
		const messages = source.agent?.state.messages ?? source.messages;
		const selected = messages[messageIndex];
		if (!Number.isInteger(messageIndex) || !selected || selected.role !== "user")
			throw new HttpError(400, "messageIndex 需要指向有效的用户消息");
		if (
			requestedTitle !== undefined &&
			(typeof requestedTitle !== "string" || !requestedTitle.trim() || requestedTitle.length > 100)
		)
			throw new HttpError(400, "会话标题需要 1–100 个字符");

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
			createdAt: now,
			updatedAt: now,
			messages: keptMessages,
			runtime: source.runtime ? structuredClone(source.runtime) : undefined,
			activities: (source.activities ?? [])
				.filter((activity) => keptToolCalls.has(activity.toolCallId))
				.map((activity) => ({ ...structuredClone(activity), sessionId: id })),
			revision: 0,
			cancelRequested: false,
			clients: new Set(),
		};
		persist(forked);
		sessions.set(id, forked);
		return { session: snapshot(forked), selectedText: contentText(selected.content) };
	}
	function persist(session: Session) {
		if (session.agent) session.messages = session.agent.state.messages;
		try {
			store.saveSession({
				...summary(session),
				astronSessionId: session.astronSessionId,
				assistant: session.assistant,
				revision: session.revision + 1,
				messages: session.messages,
				runtime: session.runtime,
				activities: session.activities,
				compaction: session.compaction,
				transferBase: session.transferBase,
				transferBaseMessageCount: session.transferBaseMessageCount,
			});
		} catch (error) {
			storageFailed = true;
			throw error;
		}
	}
	function recordActivity(session: Session, activity: ToolActivity) {
		if (!session.turn) throw new Error("技能记录缺少 Turn");
		const record: ActivityRecord = { ...activity, sessionId: session.id, turnId: session.turn.id };
		session.activities ??= [];
		const index = session.activities.findIndex((item) => item.id === record.id);
		if (index < 0) session.activities.push(record);
		else session.activities[index] = record;
		persist(session);
		publish(session, "activity.updated", undefined, record);
	}
	function updateCompaction(session: Session, next: ContextCompaction) {
		const previous = session.compaction;
		session.compaction = next;
		try {
			persist(session);
		} catch (error) {
			session.compaction = previous;
			throw error;
		}
		publish(session, "compaction.updated");
	}
	function settleInteraction(id: string, approved: boolean, error?: Error) {
		const pending = pendingInteractions.get(id);
		if (!pending) return false;
		pendingInteractions.delete(id);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		const session = sessions.get(pending.sessionId);
		if (session)
			publish(
				session,
				"interaction.resolved",
				{ type: "interaction.resolved", approved },
				undefined,
				pending.request,
			);
		if (approved) pending.resolve();
		else pending.reject(error ?? new Error("用户拒绝了操作"));
		return true;
	}
	function rejectSessionInteractions(sessionId: string, error: Error) {
		for (const [id, pending] of pendingInteractions) {
			if (pending.sessionId === sessionId || pending.executionSessionId === sessionId)
				settleInteraction(id, false, error);
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
			pending.onAbort = () => settleInteraction(interaction.id, false, new Error("交互已取消"));
			pendingInteractions.set(interaction.id, pending);
			if (signal?.aborted) {
				settleInteraction(interaction.id, false, new Error("交互已取消"));
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			publish(owner, "interaction.requested", undefined, undefined, interaction);
		});
	}
	function createSessionAgent(
		session: Session,
		runtime: NonNullable<Session["runtime"]>,
		messages = session.messages,
	) {
		return factory.create(
			session.mode,
			session.id,
			runtime,
			session.mode === "real" && session.provider ? { provider: session.provider, id: session.model } : undefined,
			messages,
			(activity) => recordActivity(session, activity),
			(request, signal) => requestInteraction(session, request, signal),
			session.kind === "root"
				? (toolCallId, binding, description, prompt, options, signal) =>
						runSubagent(session, toolCallId, binding, description, prompt, options, signal)
				: undefined,
			{
				current: session.compaction,
				update: (next) => updateCompaction(session, next),
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
		const agent = attachAgent(session);
		agent.followUp({ role: "user", content: text, timestamp: Date.now() });
		if (agent.state.isStreaming || session.turn?.status === "running") return;
		session.turn = { id: randomUUID(), status: "running" };
		session.cancelRequested = false;
		session.updatedAt = Date.now();
		persist(session);
		publish(session, "snapshot");
		session.runPromise = run(session);
		await session.runPromise;
	}
	function bindAgent(session: Session, agent: ReturnType<typeof factory.create>) {
		session.agent = agent;
		agent.subscribe((event) => {
			if (event.type === "message_end") persist(session);
			publish(session, "agent.event", event);
		});
		return agent;
	}
	function attachAgent(session: Session, prepared?: ReturnType<typeof factory.create>) {
		if (session.agent) return session.agent;
		if (!session.runtime) {
			if (session.runtimeSource === "host") {
				const definition = hostRuntimes.get(session.assistantId);
				if (!definition) throw new HttpError(409, "宿主未注册此会话的 Assistant runtime");
				session.assistantRevision = definition.assistantRevision;
				session.runtime = hydrateHostRuntime(definition, hostRuntimes);
			} else {
				const assistant = assistants.get(session.assistantId);
				if (!assistant) throw new HttpError(409, "会话引用的助手不存在");
				session.assistant = structuredClone(assistant);
				session.assistantRevision = String(assistant.updatedAt);
				session.runtime = localRuntime(assistant);
			}
		}
		return bindAgent(session, prepared ?? createSessionAgent(session, session.runtime));
	}
	function resolveTurnConfiguration(session: Session, body: Record<string, unknown>) {
		if (body.assistantId !== undefined && body.assistantId !== session.assistantId)
			throw new HttpError(409, "assistantId 与会话归属不一致");
		if (body.runtime !== undefined || body.assistantRevision !== undefined)
			throw new HttpError(400, "runtime 由 /host-runtimes 注册，Turn 不接受内联运行配置");
		if (session.runtimeSource === "host") {
			const definition = hostRuntimes.get(session.assistantId);
			if (!definition) throw new HttpError(409, "宿主未注册此会话的 Assistant runtime");
			return {
				assistant: undefined,
				assistantRevision: definition.assistantRevision,
				runtimeSource: "host" as const,
				runtime: hydrateHostRuntime(definition, hostRuntimes),
			};
		}
		const assistant = assistants.get(session.assistantId);
		if (!assistant) throw new HttpError(409, "会话引用的助手不存在");
		return {
			assistant: structuredClone(assistant),
			assistantRevision: String(assistant.updatedAt),
			runtimeSource: "local" as const,
			runtime: localRuntime(assistant),
		};
	}
	function snapshot(session: Session): SessionSnapshot {
		return {
			instanceId,
			...summary(session),
			assistant: session.assistant,
			revision: session.revision,
			messages: session.agent?.state.messages ?? session.messages,
			streamingMessage: session.agent?.state.streamingMessage,
			turn: session.turn,
			runtime: session.runtime,
			activities: session.activities ?? [],
			compaction: session.compaction,
			interactions: [...pendingInteractions.values()]
				.filter((interaction) => interaction.sessionId === session.id)
				.map((interaction) => interaction.request),
		};
	}
	function globalToolResult(result: unknown) {
		if (!result || typeof result !== "object" || Array.isArray(result)) return result;
		const details = Reflect.get(result, "details");
		if (!details || typeof details !== "object" || Array.isArray(details)) return result;
		return { ...details, ...result };
	}
	function globalAgentEvent(event: SessionEvent["event"]) {
		if (!event) return undefined;
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				return { type: event.type };
			case "message_update":
				return { type: event.type, assistantMessageEvent: event.assistantMessageEvent };
			case "tool_execution_start":
				return event;
			case "tool_execution_update":
				return { ...event, partialResult: globalToolResult(event.partialResult) };
			case "tool_execution_end":
				return { ...event, result: globalToolResult(event.result) };
			default:
				return undefined;
		}
	}
	function publish(
		session: Session,
		type: SessionEvent["type"],
		event?: SessionEvent["event"],
		activity?: ActivityRecord,
		interaction?: InteractionRequest,
	) {
		session.revision++;
		// ponytail: full snapshots simplify reconnects for short test sessions; use deltas for long histories.
		const packet: SessionEvent = {
			type,
			sessionId: session.id,
			turnId: session.turn?.id,
			event,
			activity,
			interaction,
			snapshot: snapshot(session),
		};
		const data = `data: ${JSON.stringify(packet)}\n\n`;
		const projectedEvent = type === "agent.event" ? globalAgentEvent(event) : undefined;
		const globalBase = {
			type,
			sessionId: session.id,
			turnId: session.turn?.id,
			instanceId,
			revision: session.revision,
		};
		const globalPacket =
			type === "agent.event"
				? projectedEvent
					? { ...globalBase, event: projectedEvent }
					: undefined
				: type === "snapshot" || type === "turn.settled"
					? { ...globalBase, snapshot: { turn: session.turn } }
					: type === "interaction.requested"
						? { ...globalBase, interaction }
						: undefined;
		const globalData = globalPacket ? `data: ${JSON.stringify(globalPacket)}\n\n` : undefined;
		for (const client of session.clients) {
			if (client.writableLength > 1024 * 1024) client.destroy();
			else client.write(data);
		}
		if (globalData)
			for (const client of globalClients) {
				if (client.writableLength > 1024 * 1024) client.destroy();
				else client.write(globalData);
			}
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
			const agent = attachAgent(child);
			agent.state.messages = [...agent.state.messages, { role: "user", content: prompt, timestamp: Date.now() }];
			child.turn = { id: randomUUID(), status: "running" };
			child.cancelRequested = false;
			child.updatedAt = Date.now();
			persist(child);
			publish(child, "snapshot");
		} else {
			if (sessions.size >= 32) throw new Error("最多 32 个会话，请删除旧会话");
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
			persist(child);
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
					rejectSessionInteractions(child.id, new Error("Subagent 已取消"));
					child.agent?.abort();
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
		let steps = 0;
		let limitReached = false;
		agent.shouldStopAfterTurn = ({ toolResults }) => {
			limitReached = ++steps >= 8 && toolResults.length > 0;
			return limitReached;
		};
		try {
			do {
				await agent.continue();
			} while (agent.hasQueuedMessages() && !session.cancelRequested && !limitReached);
			turn.error = limitReached ? "已达到每次提交最多 8 轮模型响应的限制" : agent.state.errorMessage;
			turn.status = session.cancelRequested ? "cancelled" : turn.error ? "failed" : "completed";
		} catch (error) {
			turn.status = session.cancelRequested ? "cancelled" : "failed";
			turn.error = error instanceof Error ? error.message : String(error);
		} finally {
			rejectSessionInteractions(session.id, new Error("回合已结束"));
			session.updatedAt = Date.now();
			try {
				persist(session);
			} catch {
				turn.status = "failed";
				turn.error = "会话写入失败，请检查存储后重启服务。";
			}
			// Agent's agent_end listeners have settled; only now may another submit be admitted.
			publish(session, "turn.settled");
		}
	}
	const server = createServer((req, res) => {
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(value));
		};
		void (async () => {
			if (closing) throw new HttpError(503, "服务正在关闭");
			const origin = req.headers.origin;
			if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) throw new HttpError(403, "只接受本地地址");
			if (origin && origin !== (env.PI_WEB_ORIGIN ?? "http://127.0.0.1:5174"))
				throw new HttpError(403, "来源不允许");
			if (env.PI_SERVER_TOKEN && req.headers.authorization !== `Bearer ${env.PI_SERVER_TOKEN}`)
				throw new HttpError(401, "认证失败");
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = url.pathname;
			if (storageFailed && req.method !== "GET") throw new HttpError(503, "存储不可用，请检查后重启服务");
			if (path === "/tools" && req.method === "GET") return json(200, { tools: factory.toolCatalog });
			if (path === "/plugins" && req.method === "GET") return json(200, { plugins: plugins.list() });
			if (path === "/plugins/import" && req.method === "POST") {
				const body = await readJson(req);
				try {
					return json(201, plugins.import(body.path));
				} catch (error) {
					throw new PluginError(error instanceof Error ? error.message : String(error));
				}
			}
			const pluginMatch = /^\/plugins\/([^/]+)$/.exec(path);
			if (pluginMatch && req.method === "DELETE") {
				const id = decodeURIComponent(pluginMatch[1]);
				if (!plugins.list().some((plugin) => plugin.id === id)) throw new HttpError(404, "插件不存在");
				if (
					[...assistants.values()].some((assistant) => assistant.pluginIds.includes(id)) ||
					[...sessions.values()].some((session) => session.assistant?.pluginIds.includes(id)) ||
					[...sessions.values()].some((session) =>
						session.runtime?.skills.some((skill) => skill.source?.pluginId === id),
					)
				)
					throw new HttpError(409, "插件仍被助手或会话引用，请先解除助手挂载并删除相关会话");
				plugins.remove(id);
				return json(200, { deleted: true });
			}
			if (path === "/assistants" && req.method === "GET") return json(200, { assistants: [...assistants.values()] });
			const assistantMatch = /^\/assistants\/([^/]+)$/.exec(path);
			if ((path === "/assistants" && req.method === "POST") || (assistantMatch && req.method === "PUT")) {
				const body = await readJson(req);
				const existing = assistantMatch ? assistants.get(assistantMatch[1]) : undefined;
				if (assistantMatch && !existing) throw new HttpError(404, "助手不存在");
				if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)
					throw new HttpError(400, "助手名称需要 1–100 个字符");
				if (typeof body.systemPrompt !== "string" || body.systemPrompt.length > 16000)
					throw new HttpError(400, "提示词需要字符串，最多 16000 个字符");
				const toolIds = parseToolIds(body.toolIds, factory.toolIds);
				const pluginIds = plugins.resolve(body.pluginIds ?? []).map((plugin) => plugin.id);
				const requestedSubagentIds = body.subagentIds ?? [];
				if (
					!Array.isArray(requestedSubagentIds) ||
					requestedSubagentIds.length > 32 ||
					requestedSubagentIds.some((id) => typeof id !== "string" || !assistants.has(id)) ||
					new Set(requestedSubagentIds).size !== requestedSubagentIds.length
				)
					throw new HttpError(400, "subagentIds 需要不重复的有效助手 ID，最多 32 项");
				const subagentIds = [...requestedSubagentIds] as string[];
				if (existing && subagentIds.includes(existing.id)) throw new HttpError(400, "助手不能调用自己");
				if (!existing && assistants.size >= 32) throw new HttpError(409, "最多 32 个助手");
				const now = Date.now();
				const assistant: Assistant = {
					id: existing?.id ?? randomUUID(),
					name: body.name.trim(),
					systemPrompt: body.systemPrompt,
					toolIds,
					pluginIds,
					subagentIds,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
				};
				store.saveAssistant(assistant);
				assistants.set(assistant.id, assistant);
				return json(existing ? 200 : 201, assistant);
			}
			if (assistantMatch && req.method === "DELETE") {
				const id = assistantMatch[1];
				if (!assistants.has(id)) throw new HttpError(404, "助手不存在");
				if (assistants.size === 1) throw new HttpError(409, "至少保留一个助手");
				if ([...assistants.values()].some((assistant) => assistant.subagentIds.includes(id)))
					throw new HttpError(409, "请先从其他助手的可调用助手中移除该助手");
				if ([...sessions.values()].some((session) => session.assistantId === id))
					throw new HttpError(409, "请先删除该助手的会话");
				store.deleteAssistant(id);
				assistants.delete(id);
				return json(200, { deleted: true });
			}
			if (path === "/sessions" && req.method === "GET") {
				const assistantId = url.searchParams.get("assistantId");
				const includeSubagents = url.searchParams.get("includeSubagents") === "true";
				return json(200, {
					sessions: [...sessions.values()]
						.filter(
							(session) =>
								(includeSubagents || session.kind === "root") &&
								(!assistantId || session.assistantId === assistantId),
						)
						.sort((a, b) => b.updatedAt - a.updatedAt)
						.map(summary),
				});
			}
			if (path === "/events" && req.method === "GET") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache, no-transform",
					"x-accel-buffering": "no",
				});
				globalClients.add(res);
				const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
				res.on("close", () => {
					clearInterval(heartbeat);
					globalClients.delete(res);
				});
				return;
			}
			if (req.method === "GET" && path === "/health") return json(200, { healthy: true, ...factory.info });
			if (req.method === "PUT" && path === "/host-runtimes") {
				const body = await readJson(req, HOST_RUNTIME_REQUEST_LIMIT);
				if (!Array.isArray(body.runtimes)) throw new HttpError(400, "runtimes 需要数组");
				const registry = parseHostRuntimeRegistry(body.runtimes);
				const definitions = [...registry.values()];
				store.replaceHostRuntimes(definitions);
				hostRuntimes.clear();
				for (const [id, definition] of registry) hostRuntimes.set(id, definition);
				return json(200, {
					runtimes: definitions.map(({ assistantId, assistantRevision }) => ({
						assistantId,
						assistantRevision,
					})),
				});
			}
			if (req.method === "GET" && path === "/models") return json(200, factory.settings.catalog());
			if (req.method === "GET" && path === "/providers") return json(200, factory.settings.providers());
			if (req.method === "PUT" && path === "/providers/config") {
				factory.settings.saveProvider(await readJson(req));
				return json(200, factory.settings.providers());
			}
			if (req.method === "POST" && path === "/providers/discover")
				return json(200, { models: await factory.settings.discover(await readJson(req)) });
			if (req.method === "PUT" && path === "/models/config") {
				factory.settings.update(await readJson(req));
				return json(200, factory.settings.catalog());
			}
			if (req.method === "POST" && path === "/models/reload") {
				await readJson(req);
				factory.settings.reload();
				return json(200, factory.settings.catalog());
			}
			if (req.method === "POST" && path === "/sessions") {
				const body = await readJson(req);
				if (body.runtime !== undefined || body.assistantRevision !== undefined)
					throw new HttpError(400, "runtime 由 /host-runtimes 注册，Session 不接受内联运行配置");
				if (
					body.assistantId !== undefined &&
					(typeof body.assistantId !== "string" || !body.assistantId.trim() || body.assistantId.length > 256)
				)
					throw new HttpError(400, "assistantId 需要 1–256 个字符");
				const defaultAssistant = assistants.values().next().value as Assistant | undefined;
				const assistantId = (body.assistantId as string | undefined) ?? defaultAssistant?.id;
				if (!assistantId) throw new HttpError(400, "请选择有效助手");
				const localAssistant = assistants.get(assistantId);
				const hostDefinition = hostRuntimes.get(assistantId);
				if (!hostDefinition && !localAssistant) throw new HttpError(400, "请选择有效助手");
				const title = body.title ?? "新会话";
				if (typeof title !== "string" || !title.trim() || title.length > 100)
					throw new HttpError(400, "会话标题需要 1–100 个字符");
				if (
					body.workspacePath !== undefined &&
					(typeof body.workspacePath !== "string" ||
						!body.workspacePath.trim() ||
						body.workspacePath.length > 4096)
				)
					throw new HttpError(400, "workspacePath 需要 1–4096 个字符");
				const mode = body.mode ?? "faux";
				if (mode !== "faux" && mode !== "real") throw new HttpError(400, "mode 必须为 faux 或 real");
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
						throw new HttpError(400, "model 需要 provider 和 id");
					model = { provider: value.provider, id: value.id };
				}
				if (mode === "real" && !model && !factory.info.realModel)
					throw new HttpError(400, factory.info.realModelError ?? "真实模型未配置");
				if (sessions.size >= 32) throw new HttpError(409, "最多 32 个会话，请删除旧会话");
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
					(activity) => recordActivity(session, activity),
					(request, signal) => requestInteraction(session, request, signal),
					(toolCallId, binding, description, prompt, options, signal) =>
						runSubagent(session, toolCallId, binding, description, prompt, options, signal),
					{
						update: (next) => updateCompaction(session, next),
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
				attachAgent(session, agent);
				persist(session);
				sessions.set(id, session);
				return json(201, snapshot(session));
			}
			const match =
				/^\/sessions\/([^/]+)(?:\/(events|turns|cancel|interactions|export|import|fork)(?:\/([^/]+))?)?$/.exec(
					path,
				);
			const session = match ? sessions.get(match[1]) : undefined;
			if (!session || !match) throw new HttpError(404, "会话或接口不存在");
			const action = match[2];
			const interactionId = match[3];
			if (req.method === "GET" && !action) return json(200, snapshot(session));
			if (req.method === "GET" && action === "export") {
				if (session.turn?.status === "running") throw new HttpError(409, "当前会话正在执行，不能导出");
				return json(200, exportSession(session));
			}
			if (req.method === "POST" && action === "fork") {
				const body = await readJson(req);
				if (typeof body.messageIndex !== "number") throw new HttpError(400, "messageIndex 需要指向有效的用户消息");
				return json(201, forkSession(session, body.messageIndex, body.title));
			}
			if (req.method === "PUT" && action === "import") {
				if (session.kind === "subagent") throw new HttpError(409, "子会话不能导入历史");
				if (session.turn?.status === "running") throw new HttpError(409, "当前会话正在执行，不能导入");
				const transfer = parseSessionTransfer(await readJson(req, 32 * 1024 * 1024));
				const importedMessages = transferToAgentMessages(transfer);
				const previous = {
					agent: session.agent,
					astronSessionId: session.astronSessionId,
					title: session.title,
					workspacePath: session.workspacePath,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					messages: session.messages,
					activities: session.activities,
					compaction: session.compaction,
					transferBase: session.transferBase,
					transferBaseMessageCount: session.transferBaseMessageCount,
				};
				session.agent = undefined;
				session.astronSessionId = transfer.source.astronSessionId;
				session.title = transfer.title ?? session.title;
				session.workspacePath = transfer.workspacePath ?? session.workspacePath;
				session.createdAt = transfer.createdAt ?? session.createdAt;
				session.updatedAt = transfer.updatedAt ?? Date.now();
				session.messages = importedMessages;
				session.activities = [];
				session.compaction = undefined;
				session.transferBase = structuredClone(transfer.transcript);
				session.transferBaseMessageCount = importedMessages.length;
				try {
					persist(session);
				} catch (error) {
					Object.assign(session, previous);
					throw error;
				}
				const result: SessionTransfer = exportSession(session);
				return json(200, { session: snapshot(session), transfer: result });
			}
			if (req.method === "PATCH" && !action) {
				if (session.kind === "subagent") throw new HttpError(409, "子会话为只读会话");
				const body = await readJson(req);
				if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 100)
					throw new HttpError(400, "会话标题需要 1–100 个字符");
				if (session.turn?.status === "running") throw new HttpError(409, "请在执行结束后重命名");
				const previous = session.title;
				session.title = body.title.trim();
				session.updatedAt = Date.now();
				try {
					persist(session);
				} catch (error) {
					session.title = previous;
					throw error;
				}
				publish(session, "snapshot");
				return json(200, snapshot(session));
			}
			if (req.method === "GET" && action === "events") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache, no-transform",
					"x-accel-buffering": "no",
				});
				session.clients.add(res);
				const initial: SessionEvent = {
					type: "snapshot",
					sessionId: session.id,
					turnId: session.turn?.id,
					snapshot: snapshot(session),
				};
				res.write(`data: ${JSON.stringify(initial)}\n\n`);
				const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
				res.on("close", () => {
					clearInterval(heartbeat);
					session.clients.delete(res);
				});
				return;
			}
			if (req.method === "POST" && action === "cancel") {
				if (session.kind === "subagent") throw new HttpError(409, "请取消父会话");
				const body = await readJson(req);
				if (!session.turn || body.turnId !== session.turn.id) throw new HttpError(409, "turnId 不匹配");
				if (session.turn.status === "running") {
					session.cancelRequested = true;
					rejectSessionInteractions(session.id, new Error("会话已取消"));
					session.agent?.abort();
				}
				return json(202, { sessionId: session.id, turnId: session.turn.id });
			}
			if (req.method === "POST" && action === "interactions") {
				if (!interactionId) throw new HttpError(404, "交互不存在");
				const body = await readJson(req);
				if (typeof body.approved !== "boolean") throw new HttpError(400, "approved 必须为布尔值");
				const pending = pendingInteractions.get(interactionId);
				if (!pending || pending.sessionId !== session.id) throw new HttpError(404, "交互不存在");
				if (pending.turnId !== session.turn?.id) throw new HttpError(409, "交互已失效");
				settleInteraction(interactionId, body.approved, body.approved ? undefined : new Error("用户拒绝了操作"));
				return json(202, { sessionId: session.id, interactionId, approved: body.approved });
			}
			if (req.method === "POST" && action === "turns") {
				if (session.kind === "subagent") throw new HttpError(409, "子会话由父会话通过 task 管理");
				const body = await readJson(req);
				if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 16000)
					throw new HttpError(400, "text 需要 1–16000 个字符");
				if (
					body.systemPrompt !== undefined &&
					(typeof body.systemPrompt !== "string" || body.systemPrompt.length > 60000)
				)
					throw new HttpError(400, "systemPrompt 需要字符串，最多 60000 字符");
				if (session.turn?.status === "running") throw new HttpError(409, "当前会话正在执行");
				const configuration = resolveTurnConfiguration(session, body);
				const oldAgent = session.agent;
				const oldSavedMessages = session.messages;
				const oldMessages = oldAgent?.state.messages ?? oldSavedMessages;
				const oldTurn = session.turn;
				const oldAssistant = session.assistant;
				const oldAssistantRevision = session.assistantRevision;
				const oldRuntimeSource = session.runtimeSource;
				const oldRuntime = session.runtime;
				const configurationChanged =
					!oldAgent ||
					configuration.runtimeSource !== oldRuntimeSource ||
					configuration.assistantRevision !== oldAssistantRevision ||
					JSON.stringify(configuration.runtime) !== JSON.stringify(oldRuntime);
				const agent = configurationChanged
					? createSessionAgent(session, configuration.runtime, oldMessages)
					: oldAgent;
				session.assistant = configuration.assistant;
				session.assistantRevision = configuration.assistantRevision;
				session.runtimeSource = configuration.runtimeSource;
				session.runtime = configuration.runtime;
				if (configurationChanged) bindAgent(session, agent);
				const now = Date.now();
				agent.state.messages = [...oldMessages, { role: "user", content: body.text, timestamp: now }];
				session.turn = { id: randomUUID(), status: "running" };
				session.updatedAt = now;
				session.cancelRequested = false;
				try {
					persist(session);
				} catch (error) {
					session.agent = oldAgent;
					session.messages = oldSavedMessages;
					session.assistant = oldAssistant;
					session.assistantRevision = oldAssistantRevision;
					session.runtimeSource = oldRuntimeSource;
					session.runtime = oldRuntime;
					session.turn = oldTurn;
					throw error;
				}
				agent.state.systemPrompt = factory.composeSystemPrompt(
					configuration.runtime,
					typeof body.systemPrompt === "string" ? body.systemPrompt : configuration.runtime.systemPrompt,
				);
				publish(session, "snapshot");
				json(202, { sessionId: session.id, turnId: session.turn.id });
				session.runPromise = run(session);
				return;
			}
			if (req.method === "DELETE" && !action) {
				if (session.kind === "subagent") throw new HttpError(409, "子会话随父会话删除");
				if (session.turn?.status === "running") throw new HttpError(409, "请先停止当前执行");
				for (const child of [...sessions.values()].filter(
					(candidate) => candidate.parentSessionId === session.id,
				)) {
					store.deleteSession(child.id);
					for (const client of child.clients) client.end();
					sessions.delete(child.id);
				}
				store.deleteSession(session.id);
				for (const client of session.clients) client.end();
				sessions.delete(session.id);
				return json(200, { deleted: true });
			}
			throw new HttpError(405, "不支持此操作");
		})().catch((error: unknown) => {
			if (res.headersSent) return res.destroy();
			json(
				error instanceof HttpError
					? error.status
					: error instanceof ModelSettingsError ||
							error instanceof ToolConfigError ||
							error instanceof PluginError ||
							error instanceof SkillConfigError
						? 400
						: 500,
				{
					error: error instanceof Error ? error.message : "服务错误",
				},
			);
		});
	});
	return {
		server,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				jobs.close();
				for (const client of globalClients) client.end();
				globalClients.clear();
				for (const session of sessions.values()) {
					session.cancelRequested = true;
					rejectSessionInteractions(session.id, new Error("服务正在关闭"));
					session.agent?.abort();
					for (const client of session.clients) client.end();
				}
				await Promise.all([...sessions.values()].map((session) => session.runPromise));
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				});
				store.close();
			})();
			return closePromise;
		},
	};
}
