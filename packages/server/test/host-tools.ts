import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pie has no built-in command tool: the host ships one and `loadExternalTools`
 * rejects an external tool that reuses a reserved id. Suites that exercise a
 * command tool therefore install this minimal host fixture, matching the
 * production wiring where Astron supplies the only command tool.
 *
 * Like the removed built-in shell, a foreground command that outlives
 * `yieldMs` returns immediately so a turn can be cancelled while it runs.
 */
export const hostCommandToolName = process.platform === "win32" ? "powershell" : "bash";

const source = `
import { spawn } from "node:child_process";

const shell =
	process.platform === "win32"
		? { executable: "powershell.exe", args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
		: { executable: "/bin/sh", args: (command) => ["-c", command] };

const YIELD_MS = 1000;

function killTree(pid) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
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

export default ({ Type }) => ({
	name: ${JSON.stringify(hostCommandToolName)},
	label: ${JSON.stringify(hostCommandToolName)},
	description: "Execute one shell command for the session workspace.",
	parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }, { additionalProperties: false }),
	async execute(_id, params, signal, onUpdate) {
		return await new Promise((resolve, reject) => {
			const child = spawn(shell.executable, shell.args(params.command), {
				cwd: process.cwd(),
				env: process.env,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let settled = false;
			const timer = setTimeout(() => killTree(child.pid), (params.timeout ?? 120) * 1000);
			// Stream partial output so a running turn stays observable and cancellable.
			const publish = setInterval(() => {
				if (settled) return;
				onUpdate?.({ content: [{ type: "text", text: output }], details: { outputs: [], status: "running" } });
			}, 200);
			const yieldTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearInterval(publish);
				child.stdout?.removeAllListeners();
				child.stderr?.removeAllListeners();
				child.unref();
				resolve({ content: [{ type: "text", text: "命令仍在运行，已转入后台。" }], details: { outputs: [], status: "running" } });
			}, YIELD_MS);
			const stop = () => {
				clearTimeout(timer);
				clearInterval(publish);
				clearTimeout(yieldTimer);
			};
			const abort = () => {
				killTree(child.pid);
				if (settled) return;
				settled = true;
				stop();
				reject(new Error("Command aborted"));
			};
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout?.on("data", (chunk) => { output += String(chunk); });
			child.stderr?.on("data", (chunk) => { output += String(chunk); });
			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				stop();
				reject(error);
			});
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				stop();
				signal?.removeEventListener("abort", abort);
				if (code && code !== 0) {
					reject(new Error(output.trim() || \`Command exited with code \${code}\`));
					return;
				}
				resolve({
					content: [{ type: "text", text: output.trim() || "(no output)" }],
					details: { exit: code, outputs: [] },
				});
			});
		});
	},
});
`;

/** Install the host command tool fixture into `toolsDirectory` and return that path. */
export async function installHostCommandTool(toolsDirectory: string) {
	await mkdir(toolsDirectory, { recursive: true });
	await writeFile(join(toolsDirectory, `${hostCommandToolName}.mjs`), source);
	return toolsDirectory;
}

export const waitCommand = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
export const failCommand =
	process.platform === "win32" ? "Write-Error 'test failure'; exit 7" : "printf 'test failure\\n' >&2; exit 7";
