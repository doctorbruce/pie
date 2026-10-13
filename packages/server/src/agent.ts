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
import { retryAssistantCall } from "./compaction/retry.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction/utils.ts";
import { type CompactionEvent, createCompactionStream, createCompactionTransform } from "./compaction.ts";
import { readCompactionSettings } from "./compaction-settings.ts";
import { loadExternalTools, parseToolIds } from "./external-tools.ts";
import { isMcpError, McpManager } from "./mcp.ts";
import { resolveConfiguredModelHeaders } from "./models/provider-composer.ts";
import { createModelSettings, ModelSettingsError } from "./models/settings.ts";
import type {
	ContextCompaction,
	InteractionRequest,
	Mode,
	ModelSelection,
	RuntimeConfig,
	ServerInfo,
	SkillBinding,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import { createSkillTools } from "./skills.ts";
import { withToolProgress } from "./tool-progress.ts";
import { createToolSearch } from "./tool-search.ts";
import { BackgroundJobs } from "./tools/jobs.ts";
import { applyPermissionPolicy, type ToolRuntime } from "./tools/runtime.ts";
import { systemTools } from "./tools.ts";

const SKILL_DESCRIPTION_LIMIT = 160;

// Mirror of the OpenCode skill index: the host language selects the localized
// summary, and a missing entry falls back to the binding description.
function skillDescription(binding: SkillBinding, language: string | undefined) {
	if (!language) return binding.description;
	const requested = language.trim().toLowerCase();
	const locale = requested.startsWith("zh") ? "zh-CN" : requested.startsWith("en") ? "en-US" : requested;
	return binding.descriptions?.[locale] ?? binding.description;
}

function oneLineDescription(description: string, fallback: string) {
	const summary =
		description
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	if (summary.length > SKILL_DESCRIPTION_LIMIT) return `${summary.slice(0, SKILL_DESCRIPTION_LIMIT - 3)}...`;
	return summary || fallback;
}

export function createAgentFactory(env: NodeJS.ProcessEnv = process.env) {
	env = Object.freeze({ ...env });
	const settings = createModelSettings(env);
	const mcp = new McpManager(env);
	const catalogTools = systemTools(env);
	const external = loadExternalTools(env, [...catalogTools.map((tool) => tool.name), "skill", "task", "tool_search"]);
	const toolIds = [...catalogTools.map((tool) => tool.name), ...external.keys()];
	const composeSystemPrompt = (runtime: RuntimeConfig, turnSystemPrompt?: string) => {
		const systemPrompt = [
			...(turnSystemPrompt?.trim() && turnSystemPrompt !== runtime.systemPrompt ? [turnSystemPrompt] : []),
			runtime.systemPrompt,
		]
			.filter((prompt) => prompt.trim().length > 0)
			.join("\n\n");
		const chinese = runtime.language?.trim().toLowerCase().startsWith("zh") ?? false;
		const skills = [...runtime.skills]
			.sort((first, second) => first.id.localeCompare(second.id))
			.map(
				(binding) =>
					`- ${binding.id}: ${oneLineDescription(skillDescription(binding, runtime.language), chinese ? "未提供描述。" : "No description provided.")}`,
			);
		const guidance = chinese
			? "## 可用技能\n以下列出技能 ID 和一句简短说明；完整指引仅在调用 skill 工具后加载。\n不要默认认为技能所需的程序或依赖已安装。"
			: "## Available Skills\nSkill IDs and one-line descriptions; full instructions are loaded only after calling the skill tool; do not assume missing host dependencies are installed.";
		return systemPrompt + (skills.length ? `\n\n${guidance}\n${skills.join("\n")}` : "");
	};

	return {
		settings,
		mcp,
		toolIds,
		composeSystemPrompt,
		toolCatalog: [
			...catalogTools.map((tool) => ({ id: tool.name, label: tool.label })),
			...[...external.keys()].map((id) => ({ id, label: id })),
		],
		get info(): ServerInfo {
			return {
				protocolVersion: 1,
				coreId: "pie",
				persistence: "sqlite",
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
			record: (activity: ToolActivity) => void = () => {},
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
				update: (next: ContextCompaction) => void;
				report?: (event: CompactionEvent) => void;
			},
			native?: Pick<ToolRuntime, "directory" | "jobs" | "notifyBackground">,
		) {
			const runtime = structuredClone(configInput);
			parseToolIds(runtime.toolIds, toolIds);
			const requestInteraction = applyPermissionPolicy(runtime.permissions, ask);
			const context = Object.freeze({
				sessionId,
				directory: native?.directory ?? process.cwd(),
				env,
				Type,
				ask: requestInteraction,
				jobs: native?.jobs ?? new BackgroundJobs(),
				notifyBackground: native?.notifyBackground,
			});
			const tools = systemTools(env, context.directory, context);
			const externalTools = runtime.toolIds.flatMap((id) => {
				const create = external.get(id);
				return create ? [create(context)] : [];
			});
			const skillTools = createSkillTools(runtime, record);
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
				delegate && runtime.subagents.length
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
			const { models, config, env: modelEnv, selected: defaultModel } = settings.current;
			const choice = selected ?? defaultModel;
			const realModel = choice ? models.getModel(choice.provider, choice.id) : undefined;
			if (mode === "real" && !realModel) throw new ModelSettingsError("请先配置并选择有效模型");
			const faux = fauxProvider({ tokensPerSecond: 45, tokenSize: { min: 1, max: 2 } });
			const localModels = createModels();
			localModels.setProvider(faux.provider);
			const modelHeaders =
				mode === "real" && realModel
					? resolveConfiguredModelHeaders(realModel, config.providers[realModel.provider], modelEnv)
					: undefined;
			const selectedNativeTools = new Set(runtime.toolIds);
			if (taskTool || selectedNativeTools.has("bash")) {
				selectedNativeTools.add("job_output");
				selectedNativeTools.add("job_kill");
			}
			const availableTools = [
				...tools.filter((tool) => selectedNativeTools.has(tool.name)),
				...externalTools,
				...skillTools.tools,
				...(taskTool ? [taskTool] : []),
			];
			let toolSearch = createToolSearch(
				availableTools,
				externalTools.map((tool) => tool.name),
			);
			const automation = mode === "real" && realModel ? readCompactionSettings(env, realModel) : undefined;
			const compactContext =
				mode === "real" && realModel && compaction
					? createCompactionTransform({
							contextWindow: realModel.contextWindow,
							initial: compaction.current,
							settings: automation?.compaction,
							onCompacted: compaction.update,
							report: compaction.report,
							summarize: async ({ prompt, maxTokens }, signal) => {
								const response = await retryAssistantCall(
									() =>
										models.completeSimple(
											realModel,
											{
												systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
												messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
											},
											{
												signal,
												maxTokens: Math.min(maxTokens, realModel.maxTokens),
												cacheRetention: "none",
												sessionId: `compaction:${sessionId}`,
												headers: modelHeaders,
												maxRetries: 0,
											},
										),
									automation?.retry,
									signal,
									{
										onRetryScheduled: (attempt, maxAttempts, delayMs, error) =>
											compaction.report?.({
												type: "compaction.retry",
												attempt,
												maxAttempts,
												delayMs,
												error,
											}),
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
			const realStream: StreamFn = (model, context, options) =>
				models.streamSimple(model, context, {
					...options,
					headers: { ...options?.headers, ...modelHeaders },
				});
			const compactStream = compactContext
				? createCompactionStream(realStream, compactContext, { enabled: automation?.compaction.enabled })
				: realStream;
			const sessionAgent = new Agent({
				sessionId,
				afterToolCall: async (context) => {
					const skillResult = await skillTools.afterToolCall(context);
					return context.toolCall.name.startsWith("mcp__") && isMcpError(context.result.details)
						? { ...skillResult, isError: true }
						: skillResult;
				},
				transformContext: async (messages) => {
					toolSearch.restore(messages);
					return messages;
				},
				initialState: {
					model: mode === "real" && realModel ? realModel : faux.getModel(),
					systemPrompt: composeSystemPrompt(runtime),
					tools: toolSearch.tools.map(withToolProgress),
					messages,
				},
				streamFn: (model, context, options) => {
					context = toolSearch.expose(context, runtime.language);
					if (mode === "real") return compactStream(model, context, options);
					const last = context.messages.at(-1);
					const availableTools = context.tools ?? [];
					if (last?.role === "toolResult") {
						faux.setResponses([
							fauxAssistantMessage(
								`**${last.isError ? "工具返回了错误" : "工具执行完成"}**\n\n${contentText(last.content)}\n\n` +
									"这条回复由假模型生成，工具由真实 Agent loop 执行。",
							),
						]);
					} else {
						const input = last?.role === "user" ? contentText(last.content) : "";
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
			return Object.assign(sessionAgent, {
				async prepareMcp(signal?: AbortSignal) {
					const lease = await mcp.acquire(runtime.mcp ?? {}, context.directory, requestInteraction, signal, [
						...availableTools.map((tool) => tool.name),
						"tool_search",
					]);
					toolSearch = createToolSearch(
						[...availableTools, ...lease.tools],
						[...externalTools.map((tool) => tool.name), ...lease.tools.map((tool) => tool.name)],
						lease.instructions,
					);
					toolSearch.restore(sessionAgent.state.messages);
					sessionAgent.state.tools = toolSearch.tools.map(withToolProgress);
					return lease.release;
				},
			});
		},
	};
}
