import { resolve, sep } from "node:path";
import type { InteractionRequest, PermissionPolicy } from "../protocol.ts";
import type { BackgroundJobs } from "./jobs.ts";

export type ArtifactRole = "final" | "intermediate" | "temporary";

export type ArtifactOutput = {
	path: string;
	artifactRole: ArtifactRole;
};

export type ToolAsk = (request: Omit<InteractionRequest, "id">, signal?: AbortSignal) => Promise<void>;

export type ToolRuntime = {
	sessionId: string;
	directory: string;
	ask: ToolAsk;
	jobs: BackgroundJobs;
	notifyBackground?: (message: string) => Promise<void>;
};

export function applyPermissionPolicy(policy: PermissionPolicy | undefined, ask: ToolAsk): ToolAsk {
	return async (request, signal) => {
		const permission = request.metadata?.permission;
		if (typeof permission === "string" && (policy?.[permission] ?? policy?.["*"]) === "allow") return;
		await ask(request, signal);
	};
}

export function containsPath(root: string, target: string): boolean {
	const base = resolve(root);
	const candidate = resolve(target);
	if (process.platform === "win32") {
		const normalizedBase = base.toLowerCase();
		const normalizedCandidate = candidate.toLowerCase();
		return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(normalizedBase + sep);
	}
	return candidate === base || candidate.startsWith(base + sep);
}

export async function authorizePath(
	runtime: ToolRuntime,
	target: string,
	operation: "read" | "edit" | "execute",
	signal?: AbortSignal,
): Promise<void> {
	if (!containsPath(runtime.directory, target)) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "访问工作区外路径",
				message: `${operation} 需要访问工作区外路径：\n${target}`,
				metadata: { permission: "external_directory", operation, path: target },
			},
			signal,
		);
	}
}

export async function authorizeCommand(
	runtime: ToolRuntime,
	command: string,
	workdir: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!containsPath(runtime.directory, workdir)) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "在工作区外执行命令",
				message: `命令将在工作区外目录执行：\n${workdir}\n\n${command}`,
				metadata: { permission: "external_directory", command, workdir },
			},
			signal,
		);
	}
	const externalPaths = new Set<string>();
	for (const segment of command.split(/(?:&&|\|\||[;|])/)) {
		const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		for (const raw of tokens.slice(1)) {
			const token = raw.replace(/^["']|["',)]+$/g, "");
			if (/^[a-z]+:\/\//i.test(token)) continue;
			const pathLike =
				/^[a-z]:[\\/]/i.test(token) || /^\\\\/.test(token) || /^\//.test(token) || /^\.\.[\\/]/.test(token);
			if (!pathLike) continue;
			const candidate = resolve(workdir, token);
			if (!containsPath(runtime.directory, candidate)) externalPaths.add(candidate);
		}
	}
	if (externalPaths.size) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "命令访问工作区外路径",
				message: `命令参数包含工作区外路径：\n${[...externalPaths].join("\n")}\n\n${command}`,
				metadata: { permission: "external_directory", command, workdir, paths: [...externalPaths] },
			},
			signal,
		);
	}
	const risk =
		/(^|[;&|]\s*)(rm|rmdir|del|erase|remove-item|format|mkfs|shutdown|reboot)\b|git\s+(reset\s+--hard|clean\s+-[a-z]*f)|\b(sudo|runas)\b/i.exec(
			command,
		);
	if (!risk) return;
	await runtime.ask(
		{
			type: "confirmation",
			title: "执行高风险命令",
			message: `检测到高风险命令片段 ${risk[0].trim()}：\n\n${command}`,
			metadata: { permission: "shell", command, workdir, risk: risk[0].trim() },
		},
		signal,
	);
}
