import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Type } from "@earendil-works/pi-ai";
import type { InteractionRequest } from "./protocol.ts";

export class ToolConfigError extends Error {}

export type ToolContext = {
	readonly sessionId: string;
	readonly directory: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly Type: typeof Type;
	readonly ask: (request: Omit<InteractionRequest, "id">, signal?: AbortSignal) => Promise<void>;
};
export type ToolFactory = (context: ToolContext) => AgentTool;

export function parseToolIds(value: unknown, available: readonly string[]): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		value.some((id) => typeof id !== "string" || !available.includes(id)) ||
		new Set(value).size !== value.length
	)
		throw new ToolConfigError("toolIds 必须为不重复的已注册工具 ID，最多 128 项");
	return [...value] as string[];
}

// Modules are trusted host code. Native require supports synchronous ESM and strip-only TS.
const requireTool = createRequire(process.execPath);

export function loadExternalTools(env: NodeJS.ProcessEnv, reservedIds: readonly string[]) {
	const directory = resolve(env.PI_TOOLS_DIR || join(env.PI_DATA_DIR || ".pie", "tools"));
	const factories = new Map<string, ToolFactory>();
	if (!existsSync(directory) && !env.PI_TOOLS_DIR) return factories;
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || entry.name.startsWith("_") || entry.name.endsWith(".d.ts")) continue;
		const extension = extname(entry.name);
		if (![".ts", ".js", ".mjs"].includes(extension)) continue;
		const id = basename(entry.name, extension);
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new ToolConfigError(`工具文件名无效：${entry.name}`);
		if (reservedIds.includes(id) || factories.has(id)) throw new ToolConfigError(`工具 ID 重复：${id}`);
		const module: unknown = requireTool(join(directory, entry.name));
		if (!module || typeof module !== "object" || !("default" in module) || typeof module.default !== "function")
			throw new ToolConfigError(`${entry.name} 需要默认导出 ToolFactory`);
		const create = module.default as ToolFactory;
		factories.set(id, (context) => {
			const tool = create(context);
			if (
				!tool ||
				tool.name !== id ||
				typeof tool.label !== "string" ||
				!tool.label.trim() ||
				typeof tool.description !== "string" ||
				!tool.description.trim() ||
				!tool.parameters ||
				typeof tool.parameters !== "object" ||
				!("type" in tool.parameters) ||
				tool.parameters.type !== "object" ||
				typeof tool.execute !== "function"
			)
				throw new ToolConfigError(`${entry.name} 必须同步返回 name=${id} 的有效 AgentTool`);
			return tool;
		});
	}
	return factories;
}
