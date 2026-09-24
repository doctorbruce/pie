import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { MAX_BYTES, resolvePath, runProcess, truncateHead } from "./shared.ts";

const grepParameters = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before and after each match" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matches (default: 100)" })),
});

function createGrepTool(
	cwd: string,
	env: NodeJS.ProcessEnv,
): AgentTool<typeof grepParameters, { matchLimitReached?: number; truncated?: boolean } | undefined> {
	return {
		name: "grep",
		label: "grep",
		description: "Search file contents with ripgrep. Returns paths and line numbers and respects .gitignore.",
		parameters: grepParameters,
		async execute(_id, { pattern, path, glob, ignoreCase, literal, context, limit }, signal) {
			const searchPath = resolvePath(path ?? ".", cwd);
			const searchStat = await stat(searchPath);
			const processCwd = searchStat.isDirectory() ? searchPath : dirname(searchPath);
			const processPath = searchStat.isDirectory() ? "." : basename(searchPath);
			const args = ["--line-number", "--color=never", "--hidden"];
			if (ignoreCase) args.push("--ignore-case");
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			if (context) args.push("--context", String(context));
			args.push("--", pattern, processPath);
			const result = await runProcess(env.PI_RG || "rg", args, {
				cwd: processCwd,
				env: { ...process.env, ...env },
				signal,
			});
			if (result.code !== 0 && result.code !== 1)
				throw new Error(result.output || `ripgrep exited with code ${result.code}`);
			if (!result.output.trim())
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			const maximum = limit ?? 100;
			const lines = result.output.trimEnd().split(/\r?\n/);
			const selected = lines
				.slice(0, maximum)
				.map((line) => (line.length > 500 ? `${line.slice(0, 500)}... [truncated]` : line))
				.join("\n");
			const truncation = truncateHead(selected, Number.MAX_SAFE_INTEGER);
			const limited = lines.length > maximum;
			const notices = [
				...(limited ? [`${maximum} matches limit reached`] : []),
				...(truncation.truncated ? [`${MAX_BYTES / 1024}KB limit reached`] : []),
			];
			return {
				content: [
					{ type: "text", text: truncation.content + (notices.length ? `\n\n[${notices.join(". ")}]` : "") },
				],
				details:
					limited || truncation.truncated
						? {
								...(limited ? { matchLimitReached: maximum } : {}),
								...(truncation.truncated ? { truncated: true } : {}),
							}
						: undefined,
			};
		},
	};
}

const findParameters = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum results (default: 1000)" })),
});

function createFindTool(
	cwd: string,
	env: NodeJS.ProcessEnv,
): AgentTool<typeof findParameters, { resultLimitReached?: number; truncated?: boolean } | undefined> {
	return {
		name: "find",
		label: "find",
		description:
			"Find files by glob pattern with ripgrep. Results are relative to the search directory and respect .gitignore.",
		parameters: findParameters,
		async execute(_id, { pattern, path, limit }, signal) {
			const searchPath = resolvePath(path ?? ".", cwd);
			if (!(await stat(searchPath)).isDirectory()) throw new Error(`Not a directory: ${searchPath}`);
			const result = await runProcess(env.PI_RG || "rg", ["--files", "--hidden", "--glob", pattern], {
				cwd: searchPath,
				env: { ...process.env, ...env },
				signal,
			});
			if (result.code !== 0 && result.code !== 1)
				throw new Error(result.output || `ripgrep exited with code ${result.code}`);
			const lines = result.output.trim()
				? result.output
						.trimEnd()
						.split(/\r?\n/)
						.map((line) => line.replaceAll("\\", "/"))
				: [];
			if (!lines.length)
				return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
			const maximum = limit ?? 1000;
			const limited = lines.length > maximum;
			const truncation = truncateHead(lines.slice(0, maximum).join("\n"), Number.MAX_SAFE_INTEGER);
			const notices = [
				...(limited ? [`${maximum} results limit reached`] : []),
				...(truncation.truncated ? [`${MAX_BYTES / 1024}KB limit reached`] : []),
			];
			return {
				content: [
					{ type: "text", text: truncation.content + (notices.length ? `\n\n[${notices.join(". ")}]` : "") },
				],
				details:
					limited || truncation.truncated
						? {
								...(limited ? { resultLimitReached: maximum } : {}),
								...(truncation.truncated ? { truncated: true } : {}),
							}
						: undefined,
			};
		},
	};
}

export function searchTools(cwd: string, env: NodeJS.ProcessEnv): AgentTool[] {
	return [createGrepTool(cwd, env), createFindTool(cwd, env)];
}
