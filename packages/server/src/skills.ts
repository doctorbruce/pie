import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AfterToolCallContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { parseToolIds } from "./external-tools.ts";
import type {
	AgentRuntimeConfig,
	HostRuntimeDefinition,
	HostSubagentBinding,
	PermissionPolicy,
	RuntimeConfig,
	SkillBinding,
	ToolActivity,
} from "./protocol.ts";
import { readText } from "./tools.ts";

export class SkillConfigError extends Error {}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillConfigError("运行配置需要对象");
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 1024): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
		throw new SkillConfigError(`${label} 无效`);
	return value.trim();
}

function absolutePath(value: unknown, label: string): string {
	const path = text(value, label, 4096);
	if (!isAbsolute(path)) throw new SkillConfigError(`${label} 需要绝对路径`);
	return resolve(path);
}

function parsePermissionPolicy(value: unknown): PermissionPolicy {
	if (value === undefined) return {};
	const entries = Object.entries(object(value));
	if (
		entries.length > 128 ||
		entries.some(
			([permission, decision]) =>
				(permission !== "*" && !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(permission)) ||
				(decision !== "allow" && decision !== "ask"),
		)
	)
		throw new SkillConfigError("permissions 必须是最多 128 项的 allow/ask 映射");
	return Object.fromEntries(entries) as PermissionPolicy;
}

function parseAgentRuntimeConfig(
	input: Record<string, unknown>,
	availableToolIds: readonly string[],
): AgentRuntimeConfig {
	if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > 16000)
		throw new SkillConfigError("systemPrompt 需要字符串，最多 16000 字符");
	const toolIds = parseToolIds(input.toolIds, availableToolIds);
	if (!Array.isArray(input.skills) || input.skills.length > 128)
		throw new SkillConfigError("skills 需要数组，最多 128 项");
	const skills: SkillBinding[] = input.skills.map((value) => {
		const entry = object(value);
		const binding: SkillBinding = {
			id: text(entry.id, "绑定 ID", 256),
			name: text(entry.name, "Skill 名称", 100),
			description: text(entry.description, "Skill 说明", 4096),
			directory: absolutePath(entry.directory, "Skill 目录"),
		};
		if (entry.resourceRoot !== undefined) binding.resourceRoot = absolutePath(entry.resourceRoot, "资源根目录");
		if (entry.source !== undefined) {
			const source = object(entry.source);
			binding.source = {
				pluginId: text(source.pluginId, "插件 ID", 100),
				pluginName: text(source.pluginName, "插件名称", 200),
			};
			if (source.pluginVersion !== undefined)
				binding.source.pluginVersion = text(source.pluginVersion, "插件版本", 100);
		}
		return binding;
	});
	if (new Set(skills.map((skill) => skill.id)).size !== skills.length) throw new SkillConfigError("绑定 ID 不可重复");
	return { systemPrompt: input.systemPrompt, toolIds, skills, permissions: parsePermissionPolicy(input.permissions) };
}

// Host configuration only. Model tool arguments cannot register or modify bindings.
export function parseHostRuntimeDefinition(value: unknown, availableToolIds: readonly string[]): HostRuntimeDefinition {
	const definition = object(value);
	const assistantId = text(definition.assistantId, "Assistant ID", 256);
	const assistantRevision = text(definition.assistantRevision, "Assistant 版本", 256);
	const input = object(definition.runtime);
	const runtime = parseAgentRuntimeConfig(input, availableToolIds);
	const rawSubagents = input.subagents ?? [];
	if (!Array.isArray(rawSubagents) || rawSubagents.length > 32)
		throw new SkillConfigError("subagents 需要数组，最多 32 项");
	const subagents: HostSubagentBinding[] = rawSubagents.map((value) => {
		const entry = object(value);
		const binding: HostSubagentBinding = {
			id: text(entry.id, "Subagent ID", 256),
			name: text(entry.name, "Subagent 名称", 200),
			description: text(entry.description, "Subagent 说明", 4096),
			assistantId: text(entry.assistantId, "Subagent Assistant ID", 256),
		};
		if (entry.model !== undefined) {
			const model = object(entry.model);
			binding.model = {
				provider: text(model.provider, "Subagent 模型提供商", 256),
				id: text(model.id, "Subagent 模型 ID", 256),
			};
		}
		return binding;
	});
	if (new Set(subagents.map((subagent) => subagent.id)).size !== subagents.length)
		throw new SkillConfigError("Subagent ID 不可重复");
	return { assistantId, assistantRevision, runtime: { ...runtime, subagents } };
}

export function hydrateHostRuntime(
	definition: HostRuntimeDefinition,
	registry: ReadonlyMap<string, HostRuntimeDefinition>,
): RuntimeConfig {
	return {
		...structuredClone(definition.runtime),
		subagents: definition.runtime.subagents.map((binding) => {
			const target = registry.get(binding.assistantId);
			if (!target) throw new SkillConfigError(`Subagent Assistant 不存在：${binding.assistantId}`);
			return {
				...structuredClone(binding),
				assistantRevision: target.assistantRevision,
				runtime: {
					systemPrompt: target.runtime.systemPrompt,
					toolIds: structuredClone(target.runtime.toolIds),
					skills: structuredClone(target.runtime.skills),
					permissions: structuredClone(target.runtime.permissions),
				},
			};
		}),
	};
}

async function sampleSkillFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const pending = [directory];
	while (pending.length && files.length < 10) {
		const current = pending.shift()!;
		const entries = await readdir(current, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			signal?.throwIfAborted();
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && !(current === directory && entry.name.toLowerCase() === "skill.md"))
				files.push(path);
			if (files.length >= 10) break;
		}
	}
	return files;
}

export function createSkillTools(runtime: RuntimeConfig, record: (activity: ToolActivity) => void) {
	type SkillDetails = { activity: ToolActivity; files: string[]; directory: string };
	const completed = new Map<string, SkillDetails>();
	const loadParameters = Type.Object(
		{ id: Type.String({ description: "Exact binding ID from the available skills catalog" }) },
		{ additionalProperties: false },
	);
	const load: AgentTool<typeof loadParameters, SkillDetails> = {
		name: "load_skill",
		label: "加载技能",
		description:
			"Load a mounted skill by its exact binding ID and record its plugin source. Use read for references and bash or powershell for commands described in the loaded skill.",
		parameters: loadParameters,
		async execute(toolCallId, { id }, signal) {
			const binding = runtime.skills.find((skill) => skill.id === id);
			if (!binding) throw new Error("此 Skill 未挂载到当前会话");
			let activity: ToolActivity = {
				id: randomUUID(),
				toolCallId,
				kind: "skill_load",
				binding: structuredClone(binding),
				status: "running",
				startedAt: Date.now(),
			};
			try {
				signal?.throwIfAborted();
				// Persist admission before reading the skill.
				record(structuredClone(activity));
				const body = await readText(join(binding.directory, "SKILL.md"), signal, false);
				const files = await sampleSkillFiles(binding.directory, signal);
				activity.contentHash = createHash("sha256").update(body).digest("hex");
				const output = [
					`<skill_content name="${binding.name}">`,
					body.trim(),
					"",
					...(binding.resourceRoot ? [`Resource root: ${binding.resourceRoot}`] : []),
					`Skill directory: ${binding.directory}`,
					"Relative paths in this skill are relative to the skill directory. File list is sampled.",
					"<skill_files>",
					...files.map((path) => `<file>${path}</file>`),
					"</skill_files>",
					"</skill_content>",
				].join("\n");
				activity = { ...activity, status: "succeeded", finishedAt: Date.now() };
				const details = { activity, files, directory: binding.directory };
				completed.set(toolCallId, details);
				record(structuredClone(activity));
				return { content: [{ type: "text" as const, text: output }], details };
			} catch (error) {
				activity = {
					...activity,
					status: signal?.aborted ? "cancelled" : "failed",
					finishedAt: Date.now(),
					error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
				};
				completed.set(toolCallId, { activity, files: [], directory: binding.directory });
				record(structuredClone(activity));
				throw error;
			}
		},
	};
	return {
		tools: runtime.skills.length ? [load] : [],
		async afterToolCall({ toolCall }: AfterToolCallContext) {
			const details = completed.get(toolCall.id);
			completed.delete(toolCall.id);
			return details ? { details } : undefined;
		},
	};
}
