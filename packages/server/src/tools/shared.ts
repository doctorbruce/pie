import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

export function findBash(env: NodeJS.ProcessEnv): { executable: string; args: string[] } {
	if (env.PI_BASH) return { executable: env.PI_BASH, args: ["-c"] };
	if (process.platform !== "win32")
		return existsSync("/bin/bash") ? { executable: "/bin/bash", args: ["-c"] } : { executable: "sh", args: ["-c"] };
	for (const path of [
		env.ProgramFiles ? join(env.ProgramFiles, "Git", "bin", "bash.exe") : "",
		env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe") : "",
	])
		if (path && existsSync(path)) return { executable: path, args: ["-c"] };
	return { executable: "bash.exe", args: ["-c"] };
}

export function findPowerShell(env: NodeJS.ProcessEnv): { executable: string; args: string[] } {
	const executable = env.PI_POWERSHELL || (process.platform === "win32" ? "powershell.exe" : "pwsh");
	return {
		executable,
		args:
			process.platform === "win32" || /powershell/i.test(executable)
				? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
				: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
	};
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
			options.timeoutMs === undefined ? undefined : setTimeout(() => stop("Command timed out"), options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const collect = (chunk: Buffer) => {
			chunks.push(chunk);
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
