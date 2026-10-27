import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Type } from "@earendil-works/pi-ai";
import type { BackgroundJobs } from "./jobs.ts";
import type { InteractionRequest, PermissionPolicy } from "./protocol.ts";
import type { ToolExecutionMode } from "./tool-execution.ts";

export class ToolConfigError extends Error {}

export type ToolContext = {
	readonly sessionId: string;
	readonly directory: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly Type: typeof Type;
	readonly ask: (request: Omit<InteractionRequest, "id">, signal?: AbortSignal) => Promise<void>;
};
export type ExternalTool = AgentTool & {
	exposure?: "default" | "deferred";
	toolExecutionMode?: ToolExecutionMode;
};
export type ToolFactory = (context: ToolContext) => ExternalTool;

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

export type ToolAsk = (request: Omit<InteractionRequest, "id">, signal?: AbortSignal) => Promise<void>;

export type ToolRuntime = {
	sessionId: string;
	directory: string;
	allowedDirectories?: readonly string[];
	ask: ToolAsk;
	jobs: BackgroundJobs;
	notifyBackground?: (message: string) => Promise<void>;
	runJob?: (toolCallId: string, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
};

export function applyPermissionPolicy(policy: PermissionPolicy | undefined, ask: ToolAsk): ToolAsk {
	return async (request, signal) => {
		const permission = request.metadata?.permission;
		if (typeof permission === "string" && (policy?.[permission] ?? policy?.["*"]) === "allow") return;
		await ask(request, signal);
	};
}
