import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fileTools, readText } from "./tools/files.ts";
import { jobTools } from "./tools/job.ts";
import { BackgroundJobs } from "./tools/jobs.ts";
import type { ToolRuntime } from "./tools/runtime.ts";
import { searchTools } from "./tools/search.ts";
import { shellTools } from "./tools/shell.ts";

export { readText };

/**
 * Pie Core native tools. They are registered at startup without an Astron tool directory.
 *
 * The public command surface has one `bash` id. It selects the platform shell internally
 * and shares the session's background job registry with task delegation.
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
	const tools = [
		...fileTools(runtime),
		...shellTools(env, runtime),
		...searchTools(runtime.directory, env),
		...jobTools(runtime),
	];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	return ["read", "bash", "edit", "write", "grep", "find", "ls", "job_output", "job_kill"].map((name) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`缺少内置工具：${name}`);
		return tool;
	});
}
