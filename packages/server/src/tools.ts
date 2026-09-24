import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fileTools, readText } from "./tools/files.ts";
import { BackgroundJobs } from "./tools/jobs.ts";
import type { ToolRuntime } from "./tools/runtime.ts";
import { searchTools } from "./tools/search.ts";

export { readText };

/**
 * Pie Core native tools. They are registered at startup without an Astron tool directory.
 *
 * Command execution is deliberately absent: the host ships its own command tool and
 * `loadExternalTools` rejects an external tool that reuses a reserved id. Pie also has
 * no background observation surface, so `job_output`/`job_kill` are not registered.
 */
export function systemTools(env: NodeJS.ProcessEnv, cwd = process.cwd(), context?: ToolRuntime): AgentTool[] {
	const runtime: ToolRuntime =
		context ??
		Object.freeze({
			sessionId: "standalone",
			directory: cwd,
			jobs: new BackgroundJobs(),
			ask: async () => {},
		});
	const tools = [...fileTools(runtime), ...searchTools(runtime.directory, env)];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	return ["read", "edit", "write", "grep", "find", "ls"].map((name) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`缺少内置工具：${name}`);
		return tool;
	});
}
