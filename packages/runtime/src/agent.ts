import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { type AgentFactoryOptions, ModelSettingsError } from "./capabilities.ts";
import { isCapabilityCatalog, nextCapabilityCatalog } from "./capability-catalog.ts";
import { retryAssistantCall } from "./compaction/retry.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction/utils.ts";
import { type CompactionEvent, createCompactionStream, createCompactionTransform } from "./compaction.ts";
import { resolveCompactionSettings } from "./compaction-settings.ts";
import { projectImageHistory } from "./image-history.ts";
import { BackgroundJobs } from "./jobs.ts";
import { isMcpError } from "./mcp.ts";
import { createRetryStream } from "./model-retry.ts";
import type {
	ContextCompaction,
	InteractionRequest,
	Mode,
	ModelRetryEvent,
	ModelSelection,
	RuntimeConfig,
	ServerInfo,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import { createSkillSearch, skillDescription } from "./skills.ts";
import { withToolProgress } from "./tool-progress.ts";
import { toolRepetitionReminder } from "./tool-repetition.ts";
import { createToolSearch } from "./tool-search.ts";
import { applyPermissionPolicy, parseToolIds, ToolConfigError, type ToolRuntime } from "./tools.ts";
import type { WorkerSessionCommunication } from "./worker-communication.ts";

const SKILL_DESCRIPTION_LIMIT = 160;

function oneLineDescription(description: string, fallback: string) {
	const summary =
		description
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	if (summary.length > SKILL_DESCRIPTION_LIMIT) return `${summary.slice(0, SKILL_DESCRIPTION_LIMIT - 3)}...`;
	return summary || fallback;
}

export function createAgentFactory(options: AgentFactoryOptions) {
	const env = Object.freeze({ ...options.env });
	const { recordModelRequest, models: settings, mcp } = options;
	const toolCatalog = structuredClone([...options.tools.catalog]);
	const toolIds = toolCatalog.map((tool) => tool.id);
	if (
		new Set(toolIds).size !== toolIds.length ||
		toolIds.some((id) =>
			["skill", "skill_search", "task", "tool_search", "communicate", "send_message", "wait_message"].includes(id),
		)
	)
		throw new ToolConfigError("工具 ID 重复或使用了保留名称");
	const composeSystemPrompt = (runtime: RuntimeConfig, turnSystemPrompt?: string) => {
		return [
			...(turnSystemPrompt?.trim() && turnSystemPrompt !== runtime.systemPrompt ? [turnSystemPrompt] : []),
			runtime.systemPrompt,
		]
			.filter((prompt) => prompt.trim().length > 0)
			.join("\n\n");
	};
	const composeCapabilityCatalog = (runtime: RuntimeConfig) => {
		const chinese = runtime.language?.trim().toLowerCase().startsWith("zh") ?? false;
		const skills = [...(runtime.toolAvailability?.skill === false ? [] : runtime.skills)]
			.sort((first, second) => first.id.localeCompare(second.id))
			.map(
				(binding) =>
					`- ${binding.id}: ${oneLineDescription(skillDescription(binding, runtime.language), chinese ? "未提供描述。" : "No description provided.")}`,
			);
		const guidance = chinese
			? "## 可用技能\n以下列出技能 ID 和一句简短说明；完整指引仅在调用 skill 工具后加载。\n不要默认认为技能所需的程序或依赖已安装。"
			: "## Available Skills\nSkill IDs and one-line descriptions; full instructions are loaded only after calling the skill tool; do not assume missing host dependencies are installed.";
		const discoveryGuidance =
			runtime.toolAvailability?.skill_search === false
				? ""
				: chinese
					? "\n不确定技能 ID，或用户询问可用技能、能力时，先调用 skill_search；用返回的精确 id 调用 skill，不要扫描插件或技能目录来发现技能。"
					: "\nUse skill_search when unsure of a skill ID or when asked which skills or capabilities are available. Call skill with an exact id from the index or search results; do not scan plugin or skill directories to discover skills.";
		return [
			skills.length
				? `${guidance}\n${skills.join("\n")}${discoveryGuidance}`
				: chinese
					? "当前没有可用专项技能。"
					: "No specialized skills are currently available.",
			runtime.capabilityCatalog,
		]
			.filter(Boolean)
			.join("\n\n");
	};

	return {
		settings,
		mcp,
		toolIds,
		composeSystemPrompt,
		composeCapabilityCatalog,
		toolCatalog,
		get info(): ServerInfo {
			return {
				protocolVersion: 1,
				coreId: "pie",
				persistence: "injected",
				realModel: settings.current.selected,
				realModelError: settings.current.selected ? undefined : "请在模型设置中配置并选择真实模型。",
			};
		},
		create(
			mode: Mode,
			sessionId: string,
			configInput: RuntimeConfig,
			selected?: ModelSelection,
			messages: AgentMessage[] = [],
			record: (activity: ToolActivity) => unknown = () => {},
			ask: (request: Omit<InteractionRequest, "id">, signal?: AbortSignal) => Promise<void> = async () => {
				throw new Error("当前运行时不支持工具交互");
			},
			delegate?: (
				toolCallId: string,
				binding: SubagentBinding,
				description: string,
				prompt: string,
				options: { taskId?: string; background?: boolean },
				signal?: AbortSignal,
			) => Promise<
				AgentToolResult<{
					childSessionId: string;
					targetAssistantId: string;
					subagentType: string;
					background?: boolean;
					jobId?: string;
				}>
			>,
			compaction?: {
				current?: ContextCompaction;
				update: (next: ContextCompaction, messages: AgentMessage[], projected: AgentMessage[]) => unknown;
				report?: (event: CompactionEvent) => unknown;
			},
			native?: Pick<ToolRuntime, "directory" | "jobs" | "cancellationSignals" | "notifyBackground" | "runJob">,
			report?: (event: ModelRetryEvent) => unknown,
			communication?: WorkerSessionCommunication,
		) {
			const runtime = structuredClone(configInput);
			parseToolIds(runtime.toolIds, toolIds);
			const requestInteraction = applyPermissionPolicy(runtime.permissions, ask);
			const context = Object.freeze({
				sessionId,
				directory: native?.directory ?? process.cwd(),
				allowedDirectories: runtime.allowedDirectories,
				env,
				Type,
				ask: requestInteraction,
				jobs: native?.jobs ?? new BackgroundJobs(),
				get cancellationSignals() {
					return native?.cancellationSignals;
				},
				notifyBackground: native?.notifyBackground,
				runJob: native?.runJob,
			});
			const tools = options.tools.create(context, runtime.toolIds);
			if (tools.some((tool) => !toolIds.includes(tool.name)))
				throw new ToolConfigError("工具实现未在 catalog 中注册");
			let skillTools = options.skills(runtime, record);
			const taskParameters = Type.Object(
				{
					description: Type.String({ description: "Short description of the delegated task" }),
					prompt: Type.String({ description: "Complete instructions for the target assistant" }),
					subagent_type: Type.String({ description: "Exact subagent ID from the available catalog" }),
					task_id: Type.Optional(
						Type.String({ description: "Existing child session ID to continue instead of creating a new task" }),
					),
					background: Type.Optional(
						Type.Boolean({ description: "Run asynchronously and notify this session when it finishes" }),
					),
				},
				{ additionalProperties: false },
			);
			const taskTool:
				| AgentTool<
						typeof taskParameters,
						{
							childSessionId: string;
							targetAssistantId: string;
							subagentType: string;
							background?: boolean;
							jobId?: string;
						}
				  >
				| undefined =
				!communication && delegate && runtime.subagents.length
					? {
							name: "task",
							label: "调用助手",
							description: `Delegate only when the user explicitly requests another assistant or the task clearly matches an available subagent's description. Pass task_id to continue an earlier child session. background=true returns immediately and completion is injected automatically. Available subagents: ${JSON.stringify(runtime.subagents.map(({ id, name, description }) => ({ id, name, description })))}`,
							parameters: taskParameters,
							executionMode: "sequential" as const,
							async execute(toolCallId, args, signal) {
								const binding = runtime.subagents.find((candidate) => candidate.id === args.subagent_type);
								if (!binding) throw new Error(`不可调用的 Subagent：${args.subagent_type}`);
								await requestInteraction(
									{
										type: "confirmation",
										title: "调用助手",
										message: `${args.description}\n\n${args.prompt}`,
										metadata: {
											permission: "task",
											subagentType: args.subagent_type,
											taskId: args.task_id,
											background: args.background === true,
										},
									},
									signal,
								);
								return delegate(
									toolCallId,
									binding,
									args.description,
									args.prompt,
									{ taskId: args.task_id, background: args.background },
									signal,
								);
							},
						}
					: undefined;
			const communicationTools: AgentTool[] = [];
			if (communication) {
				const targets = JSON.stringify(
					communication.targets.map(({ assistantId, name, description }) => ({
						id: assistantId,
						name,
						description,
					})),
				);
				const messageParameters = {
					to: Type.String({
						minLength: 1,
						maxLength: 256,
						description: `Exact authorized assistant ID. Available targets: ${targets}. A reply_to may authorize a return reply to the original sender.`,
					}),
					content: Type.String({
						minLength: 1,
						maxLength: 16000,
						description: "Complete message for the target assistant.",
					}),
					kind: Type.Optional(
						Type.Union(
							[
								Type.Literal("request"),
								Type.Literal("question"),
								Type.Literal("reply"),
								Type.Literal("progress"),
								Type.Literal("result"),
							],
							{
								description:
									"Defaults to request for new work. Set result for a request's final outcome, including failure; progress for a substantive stage or blocker; reply for an answer to a question; question only for needed clarification. Use reply_to for these causal responses. Progress does not complete the request. Receiving reply, result or progress alone does not require an acknowledgement.",
							},
						),
					),
					session_id: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: 256,
							description: "An explicitly known target Session; do not guess another work's Session.",
						}),
					),
					reply_to: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: 256,
							description:
								"The received message's messageId: use the request ID for its progress or result, or the question ID for its answer. Return replies follow its trusted Session association, even without the sender in available targets.",
						}),
					),
					new_session: Type.Optional(
						Type.Boolean({
							description:
								"Create an independent target Session for a new request; cannot be combined with session_id or reply_to.",
						}),
					),
				};
				const waitOptions = Type.Object(
					{
						mode: Type.Optional(
							Type.Union([Type.Literal("sync"), Type.Literal("async")], {
								description: `Defaults to ${runtime.workerWaitMode ?? "async"}. sync returns control in this Turn on new messages or after about 30 seconds; async parks after your normal final answer and resumes in a later Turn.`,
							}),
						),
						timeout_ms: Type.Optional(
							Type.Integer({
								minimum: 1,
								maximum: 300000,
								description:
									"Optional user-requested timeout for this sync wait call. Omit unless the user requests a time limit. Sync also returns after about 30 seconds or on new messages with status waiting; that is not a timeout. A timeout leaves the original work running.",
							}),
						),
					},
					{ additionalProperties: false },
				);
				const communicateParameters = Type.Object(
					{
						...messageParameters,
						wait: Type.Optional(
							Type.Union([
								Type.Literal(false, { description: "Save the message and continue without waiting." }),
								waitOptions,
							]),
						),
					},
					{ additionalProperties: false },
				);
				const waitOnlyParameters = Type.Object(
					{
						message_id: Type.String({
							minLength: 1,
							maxLength: 256,
							description:
								"An already-sent message ID; use this to wait after a one-way send or continue a pending wait without resending the request.",
						}),
						mode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async")])),
						timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })),
						wait: Type.Optional(waitOptions),
					},
					{ additionalProperties: false },
				);
				const communicateSchema = Type.Union([communicateParameters, waitOnlyParameters]);
				const communicateTool: AgentTool<typeof communicateSchema> = {
					name: "communicate",
					label: "联系助手",
					description: `Send to an authorized assistant and, for a new request or question, wait in the same operation. Available targets: ${targets}. When you have non-overlapping work, send with wait=false and continue that work; when blocked, wait using the returned message_id. Set wait.mode to override the default ${runtime.workerWaitMode ?? "async"}. Sync returns on a response, failure, cancellation, new inbox messages or after about 30 seconds. A waiting status means the original work is still pending: read new messages, report useful progress, and continue waiting with the same message_id until the needed response arrives. Do not resend the request or finish the user's task just because a wait interval ended. Omit wait.timeout_ms unless the user explicitly requests a time limit for that wait call. Replies, results and progress default to one-way messages. During active collaboration, promptly tell the user substantive progress and aim to keep them informed about every 60 seconds; use actual findings, blockers or waiting state, without inventing progress or repeating tool heartbeats. Sending and waiting do not cancel the peer or confirm business completion. Sender identity, work ownership and the response message ID are managed by the current Session and Turn.`,
					parameters: communicateSchema,
					executionMode: "sequential",
					async execute(toolCallId, input, signal, onUpdate) {
						if ("message_id" in input) {
							const waitResult = await communication.wait(toolCallId, input.message_id, signal, {
								mode: input.wait?.mode ?? input.mode ?? runtime.workerWaitMode ?? "async",
								...((input.wait?.timeout_ms ?? input.timeout_ms) !== undefined
									? { timeoutMs: input.wait?.timeout_ms ?? input.timeout_ms }
									: {}),
							});
							return {
								content: [{ type: "text", text: JSON.stringify(waitResult) }],
								details: waitResult,
							};
						}
						const { wait: requestedWait, ...message } = input;
						const saved = await communication.send(toolCallId, message, signal);
						onUpdate?.({ content: [], details: { sent: saved } });
						const waitConfig = requestedWait === false ? undefined : requestedWait;
						const shouldWait =
							requestedWait !== false &&
							(requestedWait !== undefined ||
								message.kind === undefined ||
								message.kind === "request" ||
								message.kind === "question");
						const waitResult = shouldWait
							? await communication.wait(toolCallId, saved.message.messageId, signal, {
									mode: waitConfig?.mode ?? runtime.workerWaitMode ?? "async",
									...(waitConfig?.timeout_ms !== undefined ? { timeoutMs: waitConfig.timeout_ms } : {}),
								})
							: undefined;
						const details = waitResult ? { sent: saved, wait: waitResult } : { sent: saved };
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(details),
								},
							],
							details,
						};
					},
				};
				communicationTools.push(communicateTool);
			}
			const { models, headers, selected: defaultModel } = settings.current;
			const choice = selected ?? defaultModel;
			const realModel = choice ? models.getModel(choice.provider, choice.id) : undefined;
			if (mode === "real" && !realModel) throw new ModelSettingsError("请先配置并选择有效模型");
			const faux = fauxProvider({ tokensPerSecond: 45, tokenSize: { min: 1, max: 2 } });
			const localModels = createModels();
			localModels.setProvider(faux.provider);
			const modelHeaders = mode === "real" && realModel ? headers?.(realModel) : undefined;
			const selectedNativeTools = new Set(runtime.toolIds);
			const toolAvailable = (tool: Pick<AgentTool, "name">) => runtime.toolAvailability?.[tool.name] !== false;
			if (taskTool || selectedNativeTools.has("bash")) {
				selectedNativeTools.add("job_output");
				selectedNativeTools.add("job_kill");
			}
			let availableTools = [
				...tools.filter((tool) => selectedNativeTools.has(tool.name)),
				...skillTools.tools,
				...(runtime.skills.length ? [createSkillSearch(runtime)] : []),
				...(taskTool ? [taskTool] : []),
				...communicationTools,
			].filter(toolAvailable);
			const deferredToolNames = [
				...tools.filter((tool) => "exposure" in tool && tool.exposure === "deferred").map((tool) => tool.name),
			];
			let toolSearch = createToolSearch(availableTools, deferredToolNames);
			toolSearch.restoreLoaded(compaction?.current?.loadedToolNames);
			const automation =
				mode === "real" && realModel
					? runtime.compaction
						? resolveCompactionSettings({ compaction: runtime.compaction }, realModel)
						: (options.compactionSettings?.(realModel) ?? resolveCompactionSettings({}, realModel))
					: undefined;
			const compactContext =
				mode === "real" && realModel && compaction
					? createCompactionTransform({
							contextWindow: realModel.contextWindow,
							initial: compaction.current,
							settings: automation?.compaction,
							supportsImages: realModel.input.includes("image"),
							imageBudgetBytes: runtime.maxHistoryImageBytes,
							onCompacted: async (next, source, projected) => {
								next.loadedToolNames = toolSearch.loadedToolNames;
								await compaction.update(next, source, projected);
								sessionAgent.replaceMessages(projected);
								source.length = 0;
								for (const message of projected) source.push(message);
							},
							report: compaction.report,
							summarize: async ({ prompt, maxTokens, images }, signal) => {
								const response = await retryAssistantCall(
									() =>
										models.completeSimple(
											realModel,
											{
												systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
												messages: [
													{
														role: "user",
														content: images?.length
															? [{ type: "text", text: prompt }, ...images]
															: prompt,
														timestamp: Date.now(),
													},
												],
											},
											{
												signal,
												maxTokens: Math.min(maxTokens, realModel.maxTokens),
												cacheRetention: "none",
												sessionId: `compaction:${sessionId}`,
												headers: modelHeaders,
												onPayload: recordModelRequest(sessionId, "compaction"),
												maxRetries: 0,
											},
										),
									automation?.retry,
									signal,
									{
										onRetryScheduled: async (attempt, maxAttempts, delayMs, error) => {
											await compaction.report?.({
												type: "compaction.retry",
												attempt,
												maxAttempts,
												delayMs,
												error,
											});
										},
									},
								);
								if (response.stopReason === "aborted") throw new DOMException("上下文摘要已取消", "AbortError");
								if (response.stopReason !== "stop")
									throw new Error(response.errorMessage || `上下文摘要未完成：${response.stopReason}`);
								if (response.content.some((block) => block.type === "toolCall"))
									throw new Error("上下文摘要返回了工具调用");
								return { summary: contentText(response.content), usage: response.usage };
							},
						})
					: undefined;
			const realStream: StreamFn = async (model, context, options) => {
				// Compaction can remove the last published list before this provider request.
				context.messages = (await sessionAgent.transformContext!(
					context.messages,
					options?.signal,
				)) as typeof context.messages;
				return models.streamSimple(
					model,
					{
						...context,
						messages: projectImageHistory(
							context.messages,
							runtime.maxHistoryImageBytes,
						) as typeof context.messages,
					},
					{
						...options,
						headers: { ...options?.headers, ...modelHeaders },
						onPayload: recordModelRequest(sessionId, "turn", options?.onPayload),
					},
				);
			};
			const retryStream = createRetryStream(realStream, automation?.retry, report);
			const compactStream = compactContext
				? createCompactionStream(retryStream, compactContext, { enabled: automation?.compaction.enabled })
				: retryStream;
			const sessionAgent: Agent = new Agent({
				sessionId,
				afterToolCall: async (context) => {
					let skillResult = await skillTools.afterToolCall(context);
					const job: unknown = context.result.details?.durableJob;
					if (
						job &&
						typeof job === "object" &&
						["failed", "cancelled"].includes(String(Reflect.get(job, "status")))
					)
						skillResult = { ...skillResult, isError: true };
					const reminder = toolRepetitionReminder(context, runtime.language);
					if (reminder)
						skillResult = {
							...skillResult,
							content: [
								...(skillResult?.content ?? context.result.content ?? []),
								{ type: "text", text: reminder },
							],
						};
					return context.toolCall.name.startsWith("mcp__") && isMcpError(context.result.details)
						? { ...skillResult, isError: true }
						: skillResult;
				},
				transformContext: async (messages) => {
					toolSearch.restore(messages);
					const catalog = nextCapabilityCatalog(messages, composeCapabilityCatalog(runtime), runtime.language);
					if (catalog) {
						messages.push(catalog);
						if (messages !== sessionAgent.state.messages) sessionAgent.state.messages.push(catalog);
					}
					return messages;
				},
				initialState: {
					model: mode === "real" && realModel ? realModel : faux.getModel(),
					systemPrompt: composeSystemPrompt(runtime),
					tools: toolSearch.tools.filter(toolAvailable).map(withToolProgress),
					messages,
				},
				streamFn: (model, context, options) => {
					context = toolSearch.expose(context);
					if (mode === "real") return compactStream(model, context, options);
					const last = [...context.messages].reverse().find((message) => !isCapabilityCatalog(message));
					const availableTools = context.tools ?? [];
					if (last?.role === "toolResult") {
						faux.setResponses([
							fauxAssistantMessage(
								`**${last.isError ? "工具返回了错误" : "工具执行完成"}**\n\n${contentText(last.content)}\n\n` +
									"这条回复由假模型生成，工具由真实 Agent loop 执行。",
							),
						]);
					} else {
						const input =
							last?.role === "user"
								? typeof Reflect.get(last, "workerMessageId") === "string" && Array.isArray(last.content)
									? (last.content.filter((part) => part.type === "text").at(-1)?.text ?? "")
									: contentText(last.content)
								: "";
						const toolRequest = /^调用工具\s+(\S+)\s+([\s\S]+)$/.exec(input.trim());
						if (toolRequest) {
							try {
								const args: unknown = JSON.parse(toolRequest[2]);
								if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
								faux.setResponses([
									fauxAssistantMessage([fauxToolCall(toolRequest[1], args as Record<string, unknown>)], {
										stopReason: "toolUse",
									}),
								]);
							} catch {
								faux.setResponses([fauxAssistantMessage("工具参数需要有效 JSON 对象。")]);
							}
							return localModels.streamSimple(model, context, options);
						}
						const skillRequest = /^加载技能\s+(\S+)$/.exec(input.trim());
						if (skillRequest) {
							faux.setResponses([
								availableTools.some((tool) => tool.name === "skill")
									? fauxAssistantMessage([fauxToolCall("skill", { id: skillRequest[1] })], {
											stopReason: "toolUse",
										})
									: fauxAssistantMessage("当前会话未启用 skill。"),
							]);
							return localModels.streamSimple(model, context, options);
						}
						faux.setResponses([
							fauxAssistantMessage(
								availableTools.length
									? `假模型不会自行选择工具。请使用：调用工具 <ID> <JSON对象>。当前可用：${availableTools.map((tool) => tool.name).join(", ")}`
									: "当前助手未启用工具。这是假模型测试回复。",
							),
						]);
					}
					return localModels.streamSimple(model, context, options);
				},
			});
			let mcpLease: Awaited<ReturnType<typeof mcp.acquire>> | undefined;
			function refreshTools() {
				const loadedToolNames = toolSearch.loadedToolNames;
				toolSearch = createToolSearch(
					[...availableTools, ...(mcpLease?.tools ?? []).filter(toolAvailable)],
					[...deferredToolNames, ...(mcpLease?.tools ?? []).map((tool) => tool.name)],
					mcpLease?.instructions,
				);
				toolSearch.restoreLoaded(loadedToolNames);
				toolSearch.restore(sessionAgent.state.messages);
				sessionAgent.state.tools = toolSearch.tools.filter(toolAvailable).map(withToolProgress);
			}
			return Object.assign(sessionAgent, {
				refreshSkills(skills: RuntimeConfig["skills"], systemPrompt: string, capabilityCatalog?: string) {
					runtime.skills = structuredClone(skills);
					runtime.capabilityCatalog = capabilityCatalog;
					skillTools = options.skills(runtime, record);
					availableTools = [
						...availableTools.filter((tool) => tool.name !== "skill" && tool.name !== "skill_search"),
						...skillTools.tools,
						...(runtime.skills.length ? [createSkillSearch(runtime)] : []),
					].filter(toolAvailable);
					refreshTools();
					sessionAgent.state.systemPrompt = systemPrompt;
				},
				async prepareMcp(signal?: AbortSignal) {
					mcpLease = await mcp.acquire(runtime.mcp ?? {}, context.directory, requestInteraction, signal, [
						...availableTools.map((tool) => tool.name),
						"tool_search",
					]);
					refreshTools();
					return mcpLease.release;
				},
			});
		},
	};
}
