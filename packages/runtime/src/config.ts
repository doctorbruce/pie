import { isAbsolute, resolve } from "node:path";
import { parseMcpServers } from "./mcp.ts";
import type {
	AgentRuntimeConfig,
	HostRuntimeDefinition,
	HostSubagentBinding,
	PermissionPolicy,
	RuntimeConfig,
	SkillBinding,
} from "./protocol.ts";
import { parseToolIds } from "./tools.ts";

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

function parseLocalizedDescriptions(value: unknown): Record<string, string> {
	const entries = Object.entries(object(value));
	if (entries.length === 0 || entries.length > 32) throw new SkillConfigError("Skill 多语言说明需要 1-32 项语言映射");
	return Object.fromEntries(
		entries.map(([locale, description]) => [
			text(locale, "Skill 多语言说明语言", 32),
			text(description, "Skill 多语言说明", 4096),
		]),
	);
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
		if (entry.descriptions !== undefined) binding.descriptions = parseLocalizedDescriptions(entry.descriptions);
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
	const language = input.language === undefined ? undefined : text(input.language, "语言", 32);
	let compaction: AgentRuntimeConfig["compaction"];
	if (input.compaction !== undefined) {
		const threshold = object(input.compaction).thresholdTokens;
		if (
			threshold !== undefined &&
			(typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0)
		)
			throw new SkillConfigError("compaction.thresholdTokens 必须是正整数");
		compaction = threshold === undefined ? {} : { thresholdTokens: threshold };
	}
	return {
		systemPrompt: input.systemPrompt,
		...(language ? { language } : {}),
		toolIds,
		skills,
		permissions: parsePermissionPolicy(input.permissions),
		...(input.mcp !== undefined ? { mcp: parseMcpServers(input.mcp) } : {}),
		...(compaction !== undefined ? { compaction } : {}),
	};
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
					language: target.runtime.language,
					toolIds: structuredClone(target.runtime.toolIds),
					skills: structuredClone(target.runtime.skills),
					permissions: structuredClone(target.runtime.permissions),
					...(target.runtime.mcp ? { mcp: structuredClone(target.runtime.mcp) } : {}),
					...(target.runtime.compaction ? { compaction: structuredClone(target.runtime.compaction) } : {}),
				},
			};
		}),
	};
}
