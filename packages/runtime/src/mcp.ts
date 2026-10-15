import type { McpServerConfig } from "./protocol.ts";
import type { ExternalTool, ToolAsk } from "./tools.ts";

export class McpConfigError extends Error {}

export type McpServerInstructions = { server: string; content: string; toolNames: string[] };

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpConfigError("MCP 配置需要对象");
	return value as Record<string, unknown>;
}

function strings(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	const entries = Object.entries(record(value));
	if (entries.length > 128 || entries.some(([name, item]) => !name || typeof item !== "string"))
		throw new McpConfigError("MCP environment/headers 需要字符串映射，最多 128 项");
	return Object.fromEntries(entries) as Record<string, string>;
}

export function parseMcpServers(value: unknown): Record<string, McpServerConfig> {
	if (value === undefined) return {};
	const entries = Object.entries(record(value));
	if (entries.length > 128) throw new McpConfigError("最多配置 128 个 MCP 服务");
	return Object.fromEntries(
		entries.map(([name, raw]) => {
			if (!name.trim() || name.length > 256) throw new McpConfigError("MCP 名称需要 1–256 个字符");
			const input = record(raw);
			if (input.enabled != null && typeof input.enabled !== "boolean")
				throw new McpConfigError("MCP enabled 需要布尔值");
			if (
				input.timeout != null &&
				(!Number.isSafeInteger(input.timeout) || Number(input.timeout) <= 0 || Number(input.timeout) > 86400000)
			)
				throw new McpConfigError("MCP timeout 需要 1–86400000 毫秒");
			const common = {
				enabled: (input.enabled ?? undefined) as boolean | undefined,
				timeout: (input.timeout ?? undefined) as number | undefined,
			};
			if (input.type === "local") {
				if (
					!Array.isArray(input.command) ||
					!input.command.length ||
					input.command.length > 128 ||
					input.command.some((item) => typeof item !== "string" || !item || item.length > 4096)
				)
					throw new McpConfigError("本地 MCP command 需要命令及参数数组");
				if (input.cwd != null && (typeof input.cwd !== "string" || !input.cwd))
					throw new McpConfigError("MCP cwd 需要非空字符串");
				return [
					name,
					{
						...common,
						type: "local",
						command: input.command as string[],
						environment: strings(input.environment),
						...(input.cwd ? { cwd: input.cwd as string } : {}),
					} satisfies McpServerConfig,
				];
			}
			if (
				input.type !== "remote" ||
				typeof input.url !== "string" ||
				!URL.canParse(input.url) ||
				!["http:", "https:"].includes(new URL(input.url).protocol)
			)
				throw new McpConfigError("远程 MCP 需要 remote 类型和 HTTP(S) URL；不支持 legacy SSE transport");
			let oauth: Extract<McpServerConfig, { type: "remote" }>["oauth"];
			if (input.oauth === false) oauth = false;
			else if (input.oauth != null) {
				const settings = record(input.oauth);
				for (const key of ["clientId", "clientSecret", "scope"])
					if (settings[key] != null && typeof settings[key] !== "string")
						throw new McpConfigError("MCP OAuth 字段需要字符串");
				oauth = {
					clientId: (settings.clientId ?? undefined) as string | undefined,
					clientSecret: (settings.clientSecret ?? undefined) as string | undefined,
					scope: (settings.scope ?? undefined) as string | undefined,
				};
			}
			return [
				name,
				{
					...common,
					type: "remote",
					url: input.url,
					headers: strings(input.headers),
					oauth,
				} satisfies McpServerConfig,
			];
		}),
	);
}

export function isMcpError(details: unknown): boolean {
	return Boolean(
		details &&
			typeof details === "object" &&
			"mcp" in details &&
			details.mcp &&
			typeof details.mcp === "object" &&
			"isError" in details.mcp &&
			details.mcp.isError === true,
	);
}

export interface McpRuntime {
	configure(configs: readonly Record<string, McpServerConfig>[]): void;
	status(): { servers: Record<string, Record<string, unknown>> };
	acquire(
		configs: Record<string, McpServerConfig>,
		directory: string,
		ask: ToolAsk,
		signal?: AbortSignal,
		reservedNames?: readonly string[],
	): Promise<{ tools: ExternalTool[]; instructions: McpServerInstructions[]; release: () => void }>;
	close(): Promise<void>;
}
