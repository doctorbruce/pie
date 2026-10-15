import type { Api, Model } from "@earendil-works/pi-ai";
import { type AgentFactoryOptions, createAgentFactory as createRuntimeAgentFactory } from "@pie/runtime";
import type { ToolFactory } from "@pie/runtime/tools";
import { readCompactionSettings } from "./compaction-settings.ts";
import { loadExternalTools } from "./external-tools.ts";
import { McpManager } from "./mcp.ts";
import { createModelRequestRecorder } from "./model-requests.ts";
import { resolveConfiguredModelHeaders } from "./models/provider-composer.ts";
import { createModelSettings } from "./models/settings.ts";
import { createSkillTools } from "./skills.ts";
import { systemTools } from "./tools.ts";

export type LocalAgentFactoryOptions = Partial<Omit<AgentFactoryOptions, "env" | "models">> & {
	models?: Pick<ReturnType<typeof createModelSettings>, "current">;
};

export function createAgentFactory(
	environment: NodeJS.ProcessEnv = process.env,
	options: LocalAgentFactoryOptions = {},
) {
	const env = Object.freeze({ ...environment });
	const settings = options.models ?? createModelSettings(env);
	const nativeTools = options.tools ? [] : systemTools(env);
	const external = options.tools
		? new Map<string, ToolFactory>()
		: loadExternalTools(env, [...nativeTools.map((tool) => tool.name), "skill", "task", "tool_search"]);
	const agents = createRuntimeAgentFactory({
		env,
		models: {
			get current() {
				const snapshot = settings.current;
				return {
					models: snapshot.models,
					selected: snapshot.selected,
					headers: (model: Model<Api>) =>
						resolveConfiguredModelHeaders(model, snapshot.config.providers[model.provider], snapshot.env),
				};
			},
		},
		tools: options.tools ?? {
			catalog: [
				...nativeTools.map((tool) => ({ id: tool.name, label: tool.label })),
				...[...external.keys()].map((id) => ({ id, label: id })),
			],
			create: (context, toolIds) => [
				...systemTools(env, context.directory, context),
				...toolIds.flatMap((id) => {
					const create = external.get(id);
					const tool = create?.(context);
					return tool ? [{ ...tool, exposure: tool.exposure ?? "deferred" }] : [];
				}),
			],
		},
		skills: options.skills ?? createSkillTools,
		mcp: options.mcp ?? new McpManager(env),
		recordModelRequest: options.recordModelRequest ?? createModelRequestRecorder(env),
		compactionSettings: options.compactionSettings ?? ((model) => readCompactionSettings(env, model)),
	});
	return Object.assign(agents, { settings });
}
