import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export type Truncation = {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
};

export function resolvePath(path: string, cwd: string): string {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	const expanded =
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function truncateHead(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
	const lines = content.split("\n");
	const totalLines = content ? lines.length : 0;
	const totalBytes = Buffer.byteLength(content);
	if (totalLines <= maxLines && totalBytes <= maxBytes)
		return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
	const output: string[] = [];
	for (const line of lines) {
		if (output.length >= maxLines) break;
		const candidate = [...output, line].join("\n");
		if (Buffer.byteLength(candidate) > maxBytes) break;
		output.push(line);
	}
	const result = output.join("\n");
	return {
		content: result,
		truncated: true,
		totalLines,
		totalBytes,
		outputLines: output.length,
		outputBytes: Buffer.byteLength(result),
	};
}

export function truncateTail(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
	const lines = content.split("\n");
	const totalLines = content ? lines.length : 0;
	const totalBytes = Buffer.byteLength(content);
	if (totalLines <= maxLines && totalBytes <= maxBytes)
		return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
	const output: string[] = [];
	for (let index = lines.length - 1; index >= 0; index--) {
		if (output.length >= maxLines) break;
		const candidate = [lines[index], ...output].join("\n");
		if (Buffer.byteLength(candidate) > maxBytes) break;
		output.unshift(lines[index]);
	}
	let result = output.join("\n");
	if (!result && content) {
		const buffer = Buffer.from(content);
		result = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
	}
	return {
		content: result,
		truncated: true,
		totalLines,
		totalBytes,
		outputLines: output.length,
		outputBytes: Buffer.byteLength(result),
	};
}

const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(path: string, mutate: () => Promise<T>): Promise<T> {
	let key = resolve(path);
	try {
		key = await realpath(key);
	} catch {}
	const previous = fileMutationQueues.get(key) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolveQueue) => {
		release = resolveQueue;
	});
	const queued = previous.then(() => current);
	fileMutationQueues.set(key, queued);
	await previous;
	try {
		return await mutate();
	} finally {
		release();
		if (fileMutationQueues.get(key) === queued) fileMutationQueues.delete(key);
	}
}

export type ShellConfig = {
	executable: string;
	name: string;
	args: (command: string) => string[];
};

function shellName(executable: string): string {
	return basename(executable)
		.replace(/\.exe$/i, "")
		.toLowerCase();
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
	const pathValue = pathKey ? env[pathKey] : undefined;
	if (!pathValue) return undefined;
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const directory of pathValue.split(delimiter))
		for (const extension of extensions) {
			const candidate = join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
			if (existsSync(candidate)) return candidate;
		}
	return undefined;
}

/** Resolve the platform shell behind the single public `bash` tool id. */
export function findShell(env: NodeJS.ProcessEnv): ShellConfig {
	const executable =
		env.PI_SHELL ||
		(process.platform === "win32"
			? env.PI_POWERSHELL || findOnPath("pwsh", env) || findOnPath("powershell", env) || "powershell.exe"
			: env.PI_BASH || env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "sh"));
	const name = shellName(executable);
	if (name === "powershell" || name === "pwsh") {
		const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive"];
		if (name === "powershell") prefix.push("-ExecutionPolicy", "Bypass");
		return {
			executable,
			name,
			args: (command) => [
				...prefix,
				"-Command",
				`try { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding } catch {}\n${command}`,
			],
		};
	}
	if (name === "cmd") return { executable, name, args: (command) => ["/d", "/s", "/c", command] };
	return { executable, name, args: (command) => ["-c", command] };
}

export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export function runProcess(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeoutMs?: number;
		isDetached?: () => boolean;
		captureOutput?: boolean;
		onData?: (chunk: Buffer) => void;
	},
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolveRun, reject) => {
		options.signal?.throwIfAborted();
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stopped = "";
		const stop = (reason: string) => {
			if (stopped) return;
			stopped = reason;
			if (child.pid) killProcessTree(child.pid);
		};
		const onAbort = () => stop("Operation aborted");
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						if (!options.isDetached?.()) stop(`Command timed out after ${options.timeoutMs}ms`);
					}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const collect = (chunk: Buffer) => {
			if (options.captureOutput !== false) chunks.push(chunk);
			options.onData?.(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (error) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const output = Buffer.concat(chunks).toString("utf8");
			if (stopped) reject(new Error(`${output}${output ? "\n\n" : ""}${stopped}`));
			else resolveRun({ code, output });
		});
	});
}
