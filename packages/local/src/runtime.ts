import { randomUUID } from "node:crypto";
import { createRuntime, type PieRuntime, RuntimeError } from "@pie/runtime";
import type { Assistant } from "@pie/runtime/protocol";
import { parseToolIds } from "@pie/runtime/tools";
import { createAgentFactory } from "./agent.ts";
import { createModelSettings } from "./models/settings.ts";
import { createPlugins, PluginError } from "./plugins.ts";
import { createSqliteRuntimeStore, openStore } from "./store.ts";

export function createLocalHost(environment: NodeJS.ProcessEnv = process.env) {
	const env = Object.freeze({ ...environment });
	const settings = createModelSettings(env);
	const agents = createAgentFactory(env, { models: settings });
	const plugins = createPlugins(env);
	const store = openStore(env);
	return { settings, agents, ready: createLocalRuntime({ agents, plugins, store }) };
}

async function createLocalRuntime(options: {
	agents: ReturnType<typeof createAgentFactory>;
	plugins: ReturnType<typeof createPlugins>;
	store: ReturnType<typeof openStore>;
}) {
	const { agents: factory, plugins, store } = options;
	const assistants = new Map(store.assistants.map((assistant) => [assistant.id, structuredClone(assistant)]));
	function localRuntime(assistant: Assistant) {
		if (!plugins) throw new RuntimeError(405, "当前宿主未启用本地助手配置");
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

	const runtime = await createRuntime({
		agents: factory,
		store: createSqliteRuntimeStore(store),
		hostRuntimes: store.hostRuntimes,
		saveHostRuntimes: async (definitions) => store.replaceHostRuntimes(definitions),
		assistants: { list: () => [...assistants.values()], runtime: localRuntime },
	});
	let commands = Promise.resolve();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	function execute<Result>(operation: () => Promise<Result>, mutating: boolean): Promise<Result> {
		const result = commands.then(() => {
			if (closing) throw new RuntimeError(503, "运行时正在关闭");
			if (mutating && !runtime.storageAvailable) throw new RuntimeError(503, "存储不可用，请检查后重启运行时");
			return operation();
		});
		commands = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	return {
		get info() {
			return runtime.info;
		},
		get storageAvailable() {
			return runtime.storageAvailable;
		},
		get tools() {
			return runtime.tools;
		},
		listAssistants() {
			return execute(async () => {
				return structuredClone([...assistants.values()]);
			}, false);
		},
		listPlugins() {
			return execute(async () => {
				if (!plugins) throw new RuntimeError(405, "当前宿主未启用本地插件");
				return plugins.list();
			}, false);
		},
		importPlugin(body: Record<string, unknown>) {
			return execute(async () => {
				if (!plugins) throw new RuntimeError(405, "当前宿主未启用本地插件");
				try {
					return plugins.import(body.path);
				} catch (error) {
					throw new PluginError(error instanceof Error ? error.message : String(error));
				}
			}, true);
		},
		deletePlugin(id: string) {
			return execute(async () => {
				if (!plugins) throw new RuntimeError(405, "当前宿主未启用本地插件");

				if (!plugins.list().some((plugin) => plugin.id === id)) throw new RuntimeError(404, "插件不存在");
				const sessions = await runtime.listSessionMetadata();
				if (
					[...assistants.values()].some((assistant) => assistant.pluginIds.includes(id)) ||
					sessions.some((session) => session.assistant?.pluginIds.includes(id)) ||
					sessions.some((session) => session.runtime?.skills.some((skill) => skill.source?.pluginId === id))
				)
					throw new RuntimeError(409, "插件仍被助手或会话引用，请先解除助手挂载并删除相关会话");
				plugins.remove(id);
				return { deleted: true };
			}, true);
		},
		saveAssistant(body: Record<string, unknown>, id?: string) {
			return execute(async () => {
				if (!plugins) throw new RuntimeError(405, "当前宿主未启用本地助手");
				const existing = id ? assistants.get(id) : undefined;
				if (id && !existing) throw new RuntimeError(404, "助手不存在");
				if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)
					throw new RuntimeError(400, "助手名称需要 1–100 个字符");
				if (typeof body.systemPrompt !== "string" || body.systemPrompt.length > 16000)
					throw new RuntimeError(400, "提示词需要字符串，最多 16000 个字符");
				const toolIds = parseToolIds(body.toolIds, factory.toolIds);
				const pluginIds = plugins.resolve(body.pluginIds ?? []).map((plugin) => plugin.id);
				const requestedSubagentIds = body.subagentIds ?? [];
				if (
					!Array.isArray(requestedSubagentIds) ||
					requestedSubagentIds.length > 32 ||
					requestedSubagentIds.some((id) => typeof id !== "string" || !assistants.has(id)) ||
					new Set(requestedSubagentIds).size !== requestedSubagentIds.length
				)
					throw new RuntimeError(400, "subagentIds 需要不重复的有效助手 ID，最多 32 项");
				const subagentIds = [...requestedSubagentIds] as string[];
				if (existing && subagentIds.includes(existing.id)) throw new RuntimeError(400, "助手不能调用自己");
				if (!existing && assistants.size >= 32) throw new RuntimeError(409, "最多 32 个助手");
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
				await store.saveAssistant(assistant);
				assistants.set(assistant.id, assistant);
				return assistant;
			}, true);
		},
		deleteAssistant(id: string) {
			return execute(async () => {
				if (!assistants.has(id)) throw new RuntimeError(404, "助手不存在");
				if (assistants.size === 1) throw new RuntimeError(409, "至少保留一个助手");
				if ([...assistants.values()].some((assistant) => assistant.subagentIds.includes(id)))
					throw new RuntimeError(409, "请先从其他助手的可调用助手中移除该助手");
				if ((await runtime.listSessionMetadata()).some((session) => session.assistantId === id))
					throw new RuntimeError(409, "请先删除该助手的会话");
				await store.deleteAssistant(id);
				assistants.delete(id);
				return { deleted: true };
			}, true);
		},

		listSessionMetadata: (...args: Parameters<PieRuntime["listSessionMetadata"]>) =>
			execute(() => runtime.listSessionMetadata(...args), false),
		listSessions: (...args: Parameters<PieRuntime["listSessions"]>) =>
			execute(() => runtime.listSessions(...args), false),
		registerHostRuntimes: (...args: Parameters<PieRuntime["registerHostRuntimes"]>) =>
			execute(() => runtime.registerHostRuntimes(...args), true),
		createSession: (...args: Parameters<PieRuntime["createSession"]>) =>
			execute(() => runtime.createSession(...args), true),
		getSession: (...args: Parameters<PieRuntime["getSession"]>) => execute(() => runtime.getSession(...args), false),
		exportSession: (...args: Parameters<PieRuntime["exportSession"]>) =>
			execute(() => runtime.exportSession(...args), false),
		forkSession: (...args: Parameters<PieRuntime["forkSession"]>) =>
			execute(() => runtime.forkSession(...args), true),
		getTree: (...args: Parameters<PieRuntime["getTree"]>) => execute(() => runtime.getTree(...args), false),
		readHistory: (...args: Parameters<PieRuntime["readHistory"]>) =>
			execute(() => runtime.readHistory(...args), false),
		selectTree: (...args: Parameters<PieRuntime["selectTree"]>) => execute(() => runtime.selectTree(...args), true),
		importSession: (...args: Parameters<PieRuntime["importSession"]>) =>
			execute(() => runtime.importSession(...args), true),
		setModelOverride: (...args: Parameters<PieRuntime["setModelOverride"]>) =>
			execute(() => runtime.setModelOverride(...args), true),
		renameSession: (...args: Parameters<PieRuntime["renameSession"]>) =>
			execute(() => runtime.renameSession(...args), true),
		cancelTurn: (...args: Parameters<PieRuntime["cancelTurn"]>) => execute(() => runtime.cancelTurn(...args), true),
		steer: (...args: Parameters<PieRuntime["steer"]>) => execute(() => runtime.steer(...args), true),
		replyInteraction: (...args: Parameters<PieRuntime["replyInteraction"]>) =>
			execute(() => runtime.replyInteraction(...args), true),
		submitTurn: (...args: Parameters<PieRuntime["submitTurn"]>) => execute(() => runtime.submitTurn(...args), true),
		deleteSession: (...args: Parameters<PieRuntime["deleteSession"]>) =>
			execute(() => runtime.deleteSession(...args), true),
		subscribe: runtime.subscribe,
		subscribeAll: runtime.subscribeAll,
		waitForTurn: runtime.waitForTurn,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = commands.then(() => runtime.close());
			return closePromise;
		},
	};
}
