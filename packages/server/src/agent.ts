import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { createCompactionTransform } from "./compaction.ts";
import { loadExternalTools, parseToolIds } from "./external-tools.ts";
import { resolveConfiguredModelHeaders } from "./models/provider-composer.ts";
import { createModelSettings, ModelSettingsError } from "./models/settings.ts";
import type {
	ContextCompaction,
	InteractionRequest,
	Mode,
	ModelSelection,
	RuntimeConfig,
	ServerInfo,
	SubagentBinding,
	ToolActivity,
} from "./protocol.ts";
import { createSkillTools } from "./skills.ts";
import { BackgroundJobs } from "./tools/jobs.ts";
import { applyPermissionPolicy, type ToolRuntime } from "./tools/runtime.ts";
import { systemTools } from "./tools.ts";

export function createAgentFactory(env: NodeJS.ProcessEnv = process.env) {
	env = Object.freeze({ ...env });
	const settings = createModelSettings(env);
	const catalogTools = systemTools(env);
	const external = loadExternalTools(env, [...catalogTools.map((tool) => tool.name), "load_skill", "task"]);
	const toolIds = [...catalogTools.map((tool) => tool.name), ...external.keys()];
	const composeSystemPrompt = (runtime: RuntimeConfig, systemPrompt = runtime.systemPrompt) =>
		systemPrompt +
		(runtime.skills.length
			? `\n\nAvailable skills (load_skill before use; do not assume missing host dependencies are installed):\n${JSON.stringify(runtime.skills.map(({ id, description, source }) => ({ id, description, source: source?.pluginName })))}`
			: "");

	return {
		settings,
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
			if (taskTool || runtime.toolIds.some((id) => id === "bash" || id === "powershell")) {
				selectedNativeTools.add("job_output");
				selectedNativeTools.add("job_kill");
			}
			return new Agent({
				sessionId,
				afterToolCall: skillTools.afterToolCall,
				transformContext:
					mode === "real" && realModel && compaction
						? createCompactionTransform({
								contextWindow: realModel.contextWindow,
								initial: compaction.current,
								onCompacted: compaction.update,
								summarize: async ({ prompt, maxTokens }, signal) => {
									const response = await models.completeSimple(
										realModel,
										{
											systemPrompt:
												"Summarize the supplied conversation into a context checkpoint. Output only the requested summary.",
											messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
										},
										{
											signal,
											maxTokens: Math.min(maxTokens, realModel.maxTokens),
											cacheRetention: "none",
											sessionId: `compaction:${sessionId}`,
											headers: modelHeaders,
										},
									);
									if (response.stopReason !== "stop")
										throw new Error(response.errorMessage || `上下文摘要未完成：${response.stopReason}`);
									if (response.content.some((block) => block.type === "toolCall"))
										throw new Error("上下文摘要返回了工具调用");
									return contentText(response.content);
								},
							})
						: undefined,
				initialState: {
					model: mode === "real" && realModel ? realModel : faux.getModel(),
					systemPrompt: composeSystemPrompt(runtime),
					tools: [
						...tools.filter((tool) => selectedNativeTools.has(tool.name)),
						...externalTools,
						...skillTools.tools,
						...(taskTool ? [taskTool] : []),
					],
					messages,
				},
				streamFn: (model, context, options) => {
					if (mode === "real")
						return models.streamSimple(model, context, {
							...options,
							headers: {
								...options?.headers,
								...modelHeaders,
							},
						});
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
								availableTools.some((tool) => tool.name === "load_skill")
									? fauxAssistantMessage([fauxToolCall("load_skill", { id: skillRequest[1] })], {
											stopReason: "toolUse",
										})
									: fauxAssistantMessage("当前会话未启用 load_skill。"),
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
		},
	};
}
