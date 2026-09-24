// Adapted from pi coding-agent at b2602be (MIT). See README.md for extraction boundaries.
import { type Api, type AuthResult, lazyStream, type Model, type Provider } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import { getConfigValueEnvVarNames, resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./resolve-config-value.ts";

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function findModelDefaults(models: readonly Model<Api>[], modelId: string, api?: Api): Model<Api> | undefined {
	return (
		models.find((model) => model.id === modelId) ??
		(api ? models.find((model) => model.api === api) : undefined) ??
		models.find((model) => model.api === "openai-completions") ??
		models[0]
	);
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly Model<Api>[],
	config: ModelsJsonProvider | undefined,
): Model<Api>[] {
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: Model<Api>[] = baseModels.map((model) => ({
		...model,
		baseUrl: config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl),
		compat: mergeCompat(model.compat, config.compat),
	}));
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => model.id === definition.id);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

/** Compose the built-in catalog and models.json; no extension or OAuth login orchestration. */
export function composeModelProvider(
	id: string,
	base: Provider | undefined,
	config: ModelsJsonProvider,
	env: Record<string, string>,
): Provider {
	if (config.auth === "none" && (config.apiKey !== undefined || config.oauth !== undefined || config.authHeader)) {
		throw new Error(`Provider ${id}: auth "none" cannot be combined with apiKey, oauth, or authHeader.`);
	}
	const catalog = applyModelsJson(id, base?.getModels() ?? [], config).map((model) =>
		config.modelOverrides?.[model.id] ? applyModelOverride(model, config.modelOverrides[model.id]) : model,
	);
	for (const model of catalog) {
		if (!getApiProvider(model.api)) throw new Error(`Unsupported api: ${model.api}`);
		if (model.contextWindow <= 0 || model.maxTokens <= 0) throw new Error("Invalid model token limits");
	}
	return {
		id,
		name: config.name ?? base?.name ?? id,
		auth: {
			apiKey: {
				name: "API key",
				async check(input) {
					if (config.auth === "none") return { type: "api_key", source: "models.json" };
					if (config.apiKey !== undefined) {
						const names = getConfigValueEnvVarNames(config.apiKey);
						return names.every((name) => !!env[name]) ? { type: "api_key", source: "models.json" } : undefined;
					}
					return base?.auth.apiKey?.check?.(input);
				},
				async resolve(input) {
					if (config.auth === "none") {
						return {
							auth: {
								apiKey: "unused",
								headers: resolveHeadersOrThrow(config.headers, "Provider", env),
							},
							source: "models.json",
						};
					}
					let result: AuthResult | undefined;
					if (config.apiKey !== undefined) {
						const key = resolveConfigValueOrThrow(config.apiKey, "API key", env);
						result = base?.auth.apiKey
							? await base.auth.apiKey.resolve({ ...input, credential: { type: "api_key", key } })
							: { auth: { apiKey: key } };
					} else result = await base?.auth.apiKey?.resolve(input);
					if (!result) return undefined;
					const headers = { ...result.auth.headers, ...resolveHeadersOrThrow(config.headers, "Provider", env) };
					if (config.authHeader) {
						if (!result.auth.apiKey) throw new Error("authHeader requires an API key");
						headers.Authorization = `Bearer ${result.auth.apiKey}`;
					}
					return { ...result, auth: { ...result.auth, headers } };
				},
			},
		},
		getModels: () => catalog,
		stream: (model, context, options) =>
			lazyStream(model, async () => {
				if (base?.getModels().some((entry) => entry.api === model.api)) return base.stream(model, context, options);
				const api = getApiProvider(model.api);
				if (!api) throw new Error("Unsupported model API");
				return api.stream(model, context, options);
			}),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => {
				if (base?.getModels().some((entry) => entry.api === model.api))
					return base.streamSimple(model, context, options);
				const api = getApiProvider(model.api);
				if (!api) throw new Error("Unsupported model API");
				return api.streamSimple(model, context, options);
			}),
	};
}
export function resolveConfiguredModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	env: Record<string, string>,
) {
	return resolveHeadersOrThrow(
		{
			...config?.modelOverrides?.[model.id]?.headers,
			...config?.models?.find((entry) => entry.id === model.id)?.headers,
		},
		"Model",
		env,
	);
}
