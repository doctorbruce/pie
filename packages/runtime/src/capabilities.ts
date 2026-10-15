import type { AfterToolCallContext, AfterToolCallResult, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, ProviderRequestOptions } from "@earendil-works/pi-ai";
import type { CompactionModel, resolveCompactionSettings } from "./compaction-settings.ts";
import type { McpRuntime } from "./mcp.ts";
import type { Assistant, ModelSelection, RuntimeConfig, ToolActivity, ToolInfo } from "./protocol.ts";
import type { ExternalTool, ToolContext, ToolRuntime } from "./tools.ts";

export class ModelSettingsError extends Error {}

export type ModelSource = {
	readonly current: {
		models: Models;
		selected?: ModelSelection;
		headers?: (model: Model<Api>) => Record<string, string> | undefined;
	};
};

export type SkillToolsFactory = (
	runtime: RuntimeConfig,
	record: (activity: ToolActivity) => unknown,
) => {
	tools: AgentTool[];
	afterToolCall: (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
};

export type PayloadHook = NonNullable<ProviderRequestOptions["onPayload"]>;
export type ModelRequestRecorder = (
	sessionId: string,
	purpose: "turn" | "compaction",
	previous?: PayloadHook,
) => PayloadHook;

export type AgentFactoryOptions = {
	env?: Readonly<NodeJS.ProcessEnv>;
	models: ModelSource;
	tools: {
		catalog: readonly ToolInfo[];
		create: (context: ToolContext & ToolRuntime, enabledToolIds: readonly string[]) => ExternalTool[];
	};
	skills: SkillToolsFactory;
	mcp: McpRuntime;
	recordModelRequest: ModelRequestRecorder;
	compactionSettings?: (model: CompactionModel) => ReturnType<typeof resolveCompactionSettings>;
};

export type AssistantSource = {
	list(): readonly Assistant[];
	runtime(assistant: Assistant): RuntimeConfig;
};
