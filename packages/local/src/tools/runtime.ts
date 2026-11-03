import { basename, resolve, sep } from "node:path";
import type { PermissionGrant } from "@pie/runtime/protocol";
import type { ToolRuntime } from "@pie/runtime/tools";

export type ArtifactRole = "final" | "intermediate" | "temporary";

export type ArtifactOutput = {
	path: string;
	artifactRole: ArtifactRole;
};

function normalizedPath(path: string): string {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function containsPath(root: string, target: string): boolean {
	const base = normalizedPath(root);
	const candidate = normalizedPath(target);
	return candidate === base || candidate.startsWith(base + sep);
}

function commandPattern(command: string, workdir: string): string {
	const source = command.trim().replace(/^&\s*/, "");
	const tokens = source.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const words = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
	const executable = words[0] ?? "";
	const name = basename(executable.replaceAll("\\", "/"))
		.replace(/\.(exe|cmd|bat)$/i, "")
		.toLowerCase();
	const simple =
		/^(?:"[^"]*"|'[^']*'|[^\s"']+)(?:[ \t]+(?:"[^"]*"|'[^']*'|[^\s"']+))*$/.test(source) &&
		tokens.length > 0 &&
		tokens.every((token) => /^"[^"$`]*"$|^'[^']*'$|^[^"';&|<>$`(){}]+$/.test(token)) &&
		!words.includes("--%") &&
		!words.some((word) =>
			/^(?:--(?:prefix|workspace[s]?|cwd|git-dir|work-tree|exec-path|config-env)(?:=|$)|-[Cw]$)/.test(word),
		);
	let entry: string[] | undefined;
	if (simple && words[1] && !words[1].startsWith("-")) {
		const program =
			executable.includes("/") || executable.includes("\\")
				? normalizedPath(resolve(workdir, executable))
				: executable;
		if (/^(python(?:\d+(?:\.\d+)?)?|node)$/.test(name) || (name === "bun" && /[./\\]/.test(words[1]))) {
			entry = [program, normalizedPath(resolve(workdir, words[1]))];
		} else if (name === "git") {
			entry = [program, words[1]];
			if (["stash", "remote", "worktree", "submodule"].includes(words[1])) {
				entry = words[2] && !words[2].startsWith("-") ? [...entry, words[2]] : undefined;
			}
		} else if (
			["npm", "pnpm", "yarn", "bun"].includes(name) &&
			words[1] === "run" &&
			words[2] &&
			!words[2].startsWith("-")
		) {
			entry = [program, words[1], words[2]];
		}
	}
	// shortcut: complex or unknown shell syntax keeps an exact-command grant; broaden only with a shell parser.
	return JSON.stringify([normalizedPath(workdir), entry ? "entry" : "exact", entry ?? command]);
}

function permissionGrant(permission: PermissionGrant["permission"], patterns: string[]): PermissionGrant | undefined {
	return patterns.length > 0 && patterns.length <= 128 && patterns.every((pattern) => pattern.length <= 16384)
		? { permission, patterns: [...new Set(patterns)] }
		: undefined;
}

function containsAllowedPath(runtime: ToolRuntime, target: string): boolean {
	return [runtime.directory, ...(runtime.allowedDirectories ?? [])].some((root) => containsPath(root, target));
}

export async function authorizePath(
	runtime: ToolRuntime,
	target: string,
	operation: "read" | "edit" | "execute",
	signal?: AbortSignal,
): Promise<void> {
	if (!containsAllowedPath(runtime, target)) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "访问工作区外路径",
				message: `${operation} 需要访问工作区外路径：\n${target}`,
				metadata: { permission: "external_directory", operation, path: target },
				remember: permissionGrant("external_directory", [JSON.stringify([operation, normalizedPath(target)])]),
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
	const pattern = commandPattern(command, workdir);
	if (!containsAllowedPath(runtime, workdir)) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "在工作区外执行命令",
				message: `命令将在工作区外目录执行：\n${workdir}\n\n${command}`,
				metadata: { permission: "external_directory", command, workdir },
				remember: permissionGrant("external_directory", [
					JSON.stringify(["workdir", normalizedPath(workdir), pattern]),
				]),
			},
			signal,
		);
	}
	const externalPaths = new Set<string>();
	// shortcut: keep --% literal for the remaining command; parse PowerShell if later lines need recovery.
	let stopParsing = false;
	for (const segment of command.split(/(?:&&|\|\||[;|])/)) {
		const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		for (const [index, raw] of tokens.entries()) {
			if (raw === "--%") stopParsing = true;
			if (index === 0 || (!stopParsing && tokens[index - 1] === "&")) continue;
			const token = raw.replace(/^["']|["',)]+$/g, "");
			if (/^[a-z]+:\/\//i.test(token)) continue;
			const pathLike =
				/^[a-z]:[\\/]/i.test(token) || /^\\\\/.test(token) || /^\//.test(token) || /^\.\.[\\/]/.test(token);
			if (!pathLike) continue;
			const candidate = resolve(workdir, token);
			if (!containsAllowedPath(runtime, candidate)) externalPaths.add(candidate);
		}
	}
	if (externalPaths.size) {
		await runtime.ask(
			{
				type: "confirmation",
				title: "命令访问工作区外路径",
				message: `命令参数包含工作区外路径：\n${[...externalPaths].join("\n")}\n\n${command}`,
				metadata: { permission: "external_directory", command, workdir, paths: [...externalPaths] },
				remember: permissionGrant(
					"external_directory",
					[...externalPaths].map((path) => JSON.stringify(["argument", normalizedPath(path), pattern])),
				),
			},
			signal,
		);
	}
	const risk =
		/(^|[;&|]\s*)(rm|rmdir|del|erase|remove-item|format|mkfs|shutdown|reboot)\b|git\s+(reset\s+--hard|clean\s+-[a-z]*f)|\b(sudo|runas)\b/i.exec(
			command,
		);
	await runtime.ask(
		{
			type: "confirmation",
			title: risk ? "执行高风险命令" : "执行命令",
			message: risk ? `检测到高风险命令片段 ${risk[0].trim()}：\n\n${command}` : command,
			metadata: { permission: "bash", command, workdir, ...(risk ? { risk: risk[0].trim() } : {}) },
			remember: permissionGrant("bash", [JSON.stringify([pattern, risk?.[0].trim() ?? ""])]),
		},
		signal,
	);
}
