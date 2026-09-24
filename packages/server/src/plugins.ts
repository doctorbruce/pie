import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { Assistant, Plugin, RuntimeConfig, Skill } from "./protocol.ts";

export class PluginError extends Error {}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginError("插件配置需要 JSON 对象");
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit)
		throw new PluginError(`${label} 需要 1–${limit} 个字符`);
	return value.trim();
}

function pluginPath(root: string, value: unknown): string {
	const path = text(value, "Skill path", 1024).replaceAll("\\", "/");
	if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes(".."))
		throw new PluginError("Skill path 必须位于插件目录内");
	const target = realpathSync(resolve(root, path));
	const rel = relative(realpathSync(root), target);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new PluginError("Skill path 必须位于插件目录内");
	return target;
}

function inspect(root: string): Plugin {
	const manifestPath = join(root, "plugin.json");
	if (lstatSync(manifestPath).size > 65536) throw new PluginError("plugin.json 超过 64 KiB");
	const manifest = object(JSON.parse(readFileSync(manifestPath, "utf8")));
	if (manifest.schemaVersion !== 1) throw new PluginError("仅支持 schemaVersion: 1 的 plugin.json");
	const id = text(manifest.id, "插件 ID", 100);
	const pluginName = text(manifest.name, "插件名称", 200);
	const pluginVersion = manifest.version === undefined ? undefined : text(manifest.version, "插件版本", 100);
	if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(id))
		throw new PluginError("插件 ID 只能包含字母、数字、点、下划线和连字符");
	const skills: Skill[] = [];
	const collect = (value: unknown) => {
		if (value === undefined) return;
		for (const metadata of Object.values(object(value))) {
			const entry = object(metadata);
			if (entry.enabled === false) continue;
			const directory = pluginPath(root, entry.path);
			const file = pluginPath(root, relative(root, join(directory, "SKILL.md")));
			if (lstatSync(file).size > 65536) throw new PluginError("SKILL.md 超过 64 KiB");
			const source = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
			if (!frontmatter) throw new PluginError(`${relative(root, file)} 缺少 YAML frontmatter`);
			const header = object(parse(frontmatter[1], { maxAliasCount: 0 }));
			const name = text(header.name, "Skill name", 100);
			if (!/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u.test(name))
				throw new PluginError("Skill name 需要小写字母、数字或中文，以连字符分隔");
			if (skills.some((skill) => skill.name === name)) throw new PluginError(`插件内 Skill name 重复：${name}`);
			skills.push({
				id: `${id}/${name}`,
				name,
				description: text(header.description, "Skill description", 4096),
				path: relative(root, directory).replaceAll("\\", "/"),
				source: {
					pluginId: id,
					pluginName,
					pluginVersion,
				},
			});
		}
	};
	collect(manifest.skills);
	// These groups are manifest containers only; Pie does not interpret their runtimes.
	for (const group of ["apps", "apa"]) {
		if (manifest[group] === undefined) continue;
		for (const metadata of Object.values(object(manifest[group]))) {
			const entry = object(metadata);
			if (entry.enabled !== false) collect(entry.skills);
		}
	}
	if (!skills.length) throw new PluginError("插件没有可挂载的已启用 Skill；MCP/RPA 暂不支持");
	if (skills.length > 128) throw new PluginError("每个插件最多 128 个 Skill");
	return { id, name: text(manifest.name, "插件名称", 200), summary: text(manifest.summary, "插件简介", 4096), skills };
}

export function createPlugins(env: NodeJS.ProcessEnv) {
	const directory = resolve(env.PI_DATA_DIR || ".pie", "plugins");
	mkdirSync(directory, { recursive: true });
	const plugins = new Map<string, Plugin>();
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".import-")) continue;
		const plugin = inspect(join(directory, entry.name));
		if (plugin.id !== entry.name) throw new PluginError("已安装插件 ID 与目录不一致");
		plugins.set(plugin.id, plugin);
	}
	return {
		list: () => [...plugins.values()],
		runtime(assistant: Assistant): RuntimeConfig {
			return {
				systemPrompt: assistant.systemPrompt,
				toolIds: [...assistant.toolIds],
				subagents: [],
				skills: assistant.pluginIds.flatMap((id) => {
					const plugin = plugins.get(id);
					if (!plugin) throw new PluginError(`插件不存在：${id}`);
					return plugin.skills.map(({ id: bindingId, name, description, path, source }) => ({
						id: bindingId,
						name,
						description,
						directory: join(directory, id, path),
						resourceRoot: join(directory, id),
						source: structuredClone(source),
					}));
				}),
			};
		},
		resolve(ids: unknown): Plugin[] {
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
				throw new PluginError("pluginIds 需要不重复的插件 ID 列表");
			return ids.map((id) => {
				const plugin = plugins.get(id);
				if (!plugin) throw new PluginError(`插件不存在：${id}`);
				return plugin;
			});
		},
		root(id: string) {
			if (!plugins.has(id)) throw new PluginError(`插件不存在：${id}`);
			return join(directory, id);
		},
		import(source: unknown): Plugin {
			const root = realpathSync(text(source, "插件目录", 4096));
			if (!lstatSync(root).isDirectory()) throw new PluginError("请指定含 plugin.json 的目录，ZIP 请先解压");
			const rel = relative(root, directory);
			if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
				throw new PluginError("不能导入包含 Pie 插件存储的目录");
			if (plugins.size >= 32) throw new PluginError("最多安装 32 个插件");
			// Reject unsupported manifests before copying potentially large packages.
			inspect(root);
			const staging = join(directory, `.import-${randomUUID()}`);
			let bytes = 0;
			let files = 0;
			// ponytail: bounded synchronous import keeps filesystem publication atomic; move copying off-thread for large packages.
			const copy = (from: string, to: string) => {
				const stat = lstatSync(from);
				files++;
				bytes += stat.isFile() ? stat.size : 0;
				if (files > 10000 || bytes > 50 * 1024 * 1024)
					throw new PluginError("插件超过 10000 项或 50 MiB；请移除依赖、缓存和构建产物");
				if (stat.isSymbolicLink()) throw new PluginError("插件包不接受符号链接或目录联接");
				if (stat.isDirectory()) {
					mkdirSync(to);
					for (const name of readdirSync(from)) {
						if ([".git", ".venv", "venv", "node_modules", "__pycache__", ".DS_Store"].includes(name)) continue;
						copy(join(from, name), join(to, name));
					}
				} else if (stat.isFile()) copyFileSync(from, to);
				else throw new PluginError(`不支持的插件文件：${basename(from)}`);
			};
			try {
				copy(root, staging);
				const plugin = inspect(staging);
				if (plugins.has(plugin.id) || existsSync(join(directory, plugin.id)))
					throw new PluginError("插件已安装，请先解除引用并卸载后重新导入");
				renameSync(staging, join(directory, plugin.id));
				plugins.set(plugin.id, plugin);
				return plugin;
			} catch (error) {
				throw new PluginError(error instanceof Error ? error.message : String(error));
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		},
		remove(id: string) {
			if (!plugins.has(id)) throw new PluginError("插件不存在");
			rmSync(join(directory, id), { recursive: true });
			plugins.delete(id);
		},
	};
}
