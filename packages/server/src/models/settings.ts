import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelCatalog, ModelSelection, ProviderCatalog, ProviderSettings } from "../protocol.ts";
import { discoverModels, endpointUrl } from "./discovery.ts";
import { stripJsonComments } from "./json.ts";
import { type ModelsJson, parseModelConfig } from "./model-config.ts";
import { composeModelProvider } from "./provider-composer.ts";
import { getConfigValueEnvVarNames } from "./resolve-config-value.ts";

export class ModelSettingsError extends Error {}

function selection(value: unknown): ModelSelection {
	if (
		!value ||
		typeof value !== "object" ||
		!("provider" in value) ||
		!("id" in value) ||
		typeof value.provider !== "string" ||
		!value.provider ||
		typeof value.id !== "string" ||
		!value.id
	)
		throw new ModelSettingsError("模型需要 provider 和 id");
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.provider) ||
		["__proto__", "constructor", "prototype"].includes(value.provider)
	)
		throw new ModelSettingsError("Provider ID 无效");
	return { provider: value.provider, id: value.id };
}

/** One service owns one models.json. Existing sessions retain their immutable runtime snapshot. */
export function createModelSettings(environment: NodeJS.ProcessEnv) {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
	const path = resolve(env.PI_DATA_DIR ?? ".pie", "models.json");
	const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	let lastContent: string | undefined;
	function read() {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new ModelSettingsError("无法读取 models.json");
		}
	}
	function prepare(value: unknown) {
		try {
			const config = parseModelConfig(value);
			const selectedValue =
				value && typeof value === "object" && "defaultModel" in value ? value.defaultModel : undefined;
			const selected =
				selectedValue === undefined
					? env.PI_PROVIDER && env.PI_MODEL
						? { provider: env.PI_PROVIDER, id: env.PI_MODEL }
						: undefined
					: selection(selectedValue);
			const models = createModels({
				authContext: { env: async (name) => env[name], fileExists: async () => false },
			});
			for (const provider of builtins.values()) models.setProvider(provider);
			for (const [id, provider] of Object.entries(config.providers)) {
				if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id))
					throw new Error("Provider ID 无效");
				if (provider.oauth) throw new Error("Core 尚未接入 OAuth 登录配置");
				const values = [
					provider.apiKey,
					...Object.values(provider.headers ?? {}),
					...(provider.models ?? []).flatMap((model) => Object.values(model.headers ?? {})),
					...Object.values(provider.modelOverrides ?? {}).flatMap((model) => Object.values(model.headers ?? {})),
				];
				for (const value of values) if (value !== undefined) getConfigValueEnvVarNames(value);
				models.setProvider(composeModelProvider(id, builtins.get(id), provider, env));
			}
			for (const address of Object.values(config.providers).flatMap((provider) => [
				provider.baseUrl,
				...(provider.models ?? []).map((model) => model.baseUrl),
			])) {
				if (address === undefined) continue;
				const url = new URL(address);
				if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
					throw new Error("模型 Base URL 必须为不含凭据、查询参数的 HTTP(S) 地址");
			}
			if (selected && !models.getModel(selected.provider, selected.id)) throw new Error("选择的模型不存在");
			return { config, selected, models, env };
		} catch (error) {
			throw new ModelSettingsError(error instanceof Error ? error.message : "模型配置无效");
		}
	}
	function load() {
		const content = read();
		let value: unknown = { providers: {} };
		if (content !== undefined) {
			try {
				value = JSON.parse(stripJsonComments(content.replace(/^\uFEFF/, "")));
			} catch {
				throw new ModelSettingsError("models.json JSON 格式无效");
			}
		}
		const next = prepare(value);
		lastContent = content;
		return next;
	}
	let current = load();
	function persist(document: ModelsJson & { defaultModel?: ModelSelection }) {
		const next = prepare(document);
		if (read() !== lastContent) throw new ModelSettingsError("models.json 已被外部修改，请先重新加载配置");
		const content = `${JSON.stringify(document, null, 2)}\n`;
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} catch {
			throw new ModelSettingsError("保存 models.json 失败，原配置仍然有效");
		} finally {
			rmSync(temporary, { force: true });
		}
		lastContent = content;
		current = next;
	}
	function providerDraft(body: Record<string, unknown>) {
		selection({ provider: body.id, id: "validation" });
		if (
			Object.keys(body).some(
				(key) => !["id", "name", "api", "baseUrl", "apiKey", "models", "defaultModel"].includes(key),
			)
		)
			throw new ModelSettingsError("提供商配置字段无效");
		try {
			const parsed = parseModelConfig({
				providers: {
					[String(body.id)]: {
						name: body.name,
						api: body.api,
						baseUrl: body.baseUrl,
						apiKey: body.apiKey || undefined,
						models: body.models,
					},
				},
			});
			const config = parsed.providers[String(body.id)];
			if (!config.name?.trim() || !config.api || !config.baseUrl)
				throw new Error("请填写提供商名称、协议和 Base URL");
			endpointUrl(config.baseUrl);
			if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new Error("API key 必须为字符串");
			return { ...config, name: config.name.trim(), api: config.api, baseUrl: config.baseUrl, id: String(body.id) };
		} catch (error) {
			throw new ModelSettingsError(error instanceof Error ? error.message : "提供商配置无效");
		}
	}
	return {
		get current() {
			return current;
		},
		catalog(): ModelCatalog {
			return {
				selected: current.selected,
				models: current.models.getModels().map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					api: model.api,
					baseUrl: model.baseUrl,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					keyConfigured: !!current.config.providers[model.provider]?.apiKey,
				})),
			};
		},
		reload() {
			current = load();
		},
		providers(): ProviderCatalog {
			const providers: ProviderSettings[] = Object.entries(current.config.providers).map(([id, config]) => {
				const catalog = current.models.getModels().filter((model) => model.provider === id);
				const definitions = config.models ?? catalog;
				return {
					id,
					name: config.name ?? id,
					api: config.api ?? config.models?.[0]?.api ?? catalog[0]?.api ?? "openai-completions",
					baseUrl: config.baseUrl ?? config.models?.[0]?.baseUrl ?? catalog[0]?.baseUrl ?? "",
					keyConfigured: !!config.apiKey,
					models: definitions.map((definition) => {
						const model = catalog.find((model) => model.id === definition.id);
						return {
							id: definition.id,
							contextWindow: model?.contextWindow,
							maxTokens: model?.maxTokens,
							reasoning: model?.reasoning,
						};
					}),
				};
			});
			return { selected: current.selected, providers };
		},
		saveProvider(body: Record<string, unknown>) {
			const draft = providerDraft(body);
			if (!draft.models?.length || draft.models.length > 2000) throw new ModelSettingsError("请添加 1–2000 个模型");
			const ids = draft.models.map((model) => model.id);
			if (new Set(ids).size !== ids.length || ids.some((id) => id !== id.trim() || id.length > 256))
				throw new ModelSettingsError("模型 ID 不能为空、重复或超过 256 字符");
			const previous = current.config.providers[draft.id];
			const models = draft.models.map((model) => ({
				...(previous?.models?.find((entry) => entry.id === model.id) ??
					current.models.getModel(draft.id, model.id)),
				...model,
				api: draft.api,
				baseUrl: draft.baseUrl,
			}));
			const modelOverrides = Object.fromEntries(
				Object.entries(previous?.modelOverrides ?? {})
					.filter(([id]) => ids.includes(id))
					.map(([id, override]) => {
						const edit = draft.models?.find((model) => model.id === id);
						return [
							id,
							{
								...override,
								...Object.fromEntries(
									Object.entries(edit ?? {}).filter(([key]) => Object.hasOwn(override, key)),
								),
							},
						];
					}),
			);
			const config = {
				...previous,
				name: draft.name,
				api: draft.api,
				baseUrl: draft.baseUrl,
				apiKey: draft.apiKey ?? previous?.apiKey,
				models,
				modelOverrides,
			};
			let selected = current.selected;
			if (body.defaultModel !== undefined) {
				if (typeof body.defaultModel !== "string" || !ids.includes(body.defaultModel))
					throw new ModelSettingsError("默认模型必须在模型列表中");
				selected = { provider: draft.id, id: body.defaultModel };
			} else if (!selected || (selected.provider === draft.id && !ids.includes(selected.id)))
				selected = { provider: draft.id, id: ids[0] };
			persist({ providers: { ...current.config.providers, [draft.id]: config }, defaultModel: selected });
		},
		async discover(body: Record<string, unknown>) {
			const draft = providerDraft(body);
			const stored = current.config.providers[draft.id];
			const previousUrl = stored?.baseUrl ?? stored?.models?.[0]?.baseUrl;
			const sameEndpoint = previousUrl && endpointUrl(previousUrl).href === endpointUrl(draft.baseUrl).href;
			if (!draft.apiKey && stored?.apiKey && !sameEndpoint)
				throw new ModelSettingsError("地址已变化，请重新输入 API key 后获取模型");
			try {
				return await discoverModels(
					{
						...draft,
						apiKey: draft.apiKey ?? (sameEndpoint ? stored?.apiKey : undefined),
						headers: sameEndpoint ? stored?.headers : undefined,
					},
					env,
				);
			} catch (error) {
				throw new ModelSettingsError(
					error instanceof TypeError || error instanceof SyntaxError
						? "无法获取模型，请检查地址、网络和接口格式；也可手动添加"
						: error instanceof Error
							? error.message
							: "获取模型失败",
				);
			}
		},
		update(body: Record<string, unknown>) {
			const selected = selection(body);
			if (Object.keys(body).some((key) => !["provider", "id", "model", "apiKey"].includes(key)))
				throw new ModelSettingsError("只接受 provider、id、model、apiKey 字段");
			const providers: ModelsJson["providers"] = structuredClone(current.config.providers);
			if (body.apiKey !== undefined && typeof body.apiKey !== "string")
				throw new ModelSettingsError("apiKey 必须为字符串");
			if (body.model !== undefined || body.apiKey) {
				const provider = Object.hasOwn(providers, selected.provider) ? providers[selected.provider] : {};
				if (body.apiKey !== undefined) {
					// Empty means preserve; credentials are never returned to the browser.
					if (body.apiKey) provider.apiKey = body.apiKey;
				}
				if (body.model !== undefined) {
					if (!body.model || typeof body.model !== "object" || Array.isArray(body.model))
						throw new ModelSettingsError("model 必须为模型定义对象");
					const definitions = provider.models ?? [];
					const previous =
						definitions.find((model) => model.id === selected.id) ??
						current.models.getModel(selected.provider, selected.id);
					const candidate = { ...previous, ...body.model, id: selected.id };
					const checked = prepare({
						providers: { [selected.provider]: { ...provider, models: [candidate] } },
						defaultModel: selected,
					}).config;
					provider.models = [
						...definitions.filter((model) => model.id !== selected.id),
						...(checked.providers[selected.provider].models ?? []),
					];
					const override = provider.modelOverrides?.[selected.id];
					if (override) {
						// Explicit edits must also update the topmost upstream override layer.
						provider.modelOverrides = {
							...provider.modelOverrides,
							[selected.id]: {
								...override,
								...Object.fromEntries(
									Object.entries(body.model).filter(([key]) => Object.hasOwn(override, key)),
								),
							},
						};
					}
				}
				providers[selected.provider] = provider;
			}
			const document = { providers, defaultModel: selected };
			persist(document);
		},
	};
}
