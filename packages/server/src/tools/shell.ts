import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { type ArtifactOutput, authorizeCommand, authorizePath, type ToolRuntime } from "./runtime.ts";
import { findBash, findPowerShell, MAX_BYTES, MAX_LINES, resolvePath, runProcess, truncateTail } from "./shared.ts";

const artifactRole = Type.Union([Type.Literal("final"), Type.Literal("intermediate"), Type.Literal("temporary")]);
const parameters = Type.Object(
	{
		command: Type.String({ description: "Shell command to execute" }),
		workdir: Type.Optional(Type.String({ description: "Working directory, relative to the session workspace" })),
		timeout: Type.Optional(
			Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483.647, description: "Timeout in seconds" }),
		),
		yieldMs: Type.Optional(
			Type.Integer({ minimum: 0, maximum: 300_000, description: "Move the command to background after this delay" }),
		),
		background: Type.Optional(Type.Boolean({ description: "Start in the background immediately" })),
		outputs: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({ description: "Expected output file path" }),
						artifactRole,
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

type ShellDetails = {
	output?: string;
	exit?: number | null;
	truncation?: ReturnType<typeof truncateTail>;
	fullOutputPath?: string;
	outputs: ArtifactOutput[];
	background?: boolean;
	jobId?: string;
	status?: "running" | "completed" | "failed" | "cancelled";
	workdir: string;
};

async function declaredOutputs(
	items: readonly { path: string; artifactRole: ArtifactOutput["artifactRole"] }[] | undefined,
	cwd: string,
	runtime: ToolRuntime,
	signal?: AbortSignal,
): Promise<ArtifactOutput[]> {
	const outputs: ArtifactOutput[] = [];
	for (const item of items ?? []) {
		const path = resolvePath(item.path, cwd);
		await authorizePath(runtime, path, "execute", signal);
		if (!(await stat(path)).isFile()) throw new Error(`声明的命令产物不是文件：${path}`);
		if (!outputs.some((output) => output.path === path)) outputs.push({ path, artifactRole: item.artifactRole });
	}
	return outputs;
}

function createShellTool(
	name: "bash" | "powershell",
	env: NodeJS.ProcessEnv,
	runtime: ToolRuntime,
): AgentTool<typeof parameters, ShellDetails> {
	return {
		name,
		label: name,
		description: `Execute a ${name === "bash" ? "Bash" : "PowerShell"} command. Supports workdir, permission confirmation, declared artifacts, automatic backgrounding, incremental job output, and cancellation. Foreground output keeps the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB.`,
		parameters,
		async execute(_id, { command, workdir, timeout, yieldMs, background, outputs }, signal, onUpdate) {
			const cwd = resolvePath(workdir ?? ".", runtime.directory);
			if (!(await stat(cwd)).isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
			await authorizeCommand(runtime, command, cwd, signal);
			const config = name === "bash" ? findBash(env) : findPowerShell(env);
			const actualCommand =
				name === "powershell"
					? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`
					: command;
			const chunks: Buffer[] = [];
			let updateTimer: NodeJS.Timeout | undefined;
			let detached = background === true;
			const publish = (callback: AgentToolUpdateCallback<ShellDetails> | undefined) => {
				if (!callback) return;
				const text = truncateTail(Buffer.concat(chunks).toString("utf8")).content;
				callback({ content: text ? [{ type: "text", text }] : [], details: { outputs: [], workdir: cwd } });
			};
			onUpdate?.({ content: [], details: { outputs: [], workdir: cwd } });
			const started = runtime.jobs.start({
				ownerSessionId: runtime.sessionId,
				type: "shell",
				title: command.slice(0, 120),
				async run(jobSignal, append) {
					const result = await runProcess(config.executable, [...config.args, actualCommand], {
						cwd,
						env: { ...process.env, ...env },
						signal: jobSignal,
						timeoutMs: timeout === undefined ? Number(env.PI_SHELL_TIMEOUT_MS ?? 120_000) : timeout * 1000,
						onData(chunk) {
							chunks.push(chunk);
							append(chunk.toString("utf8"));
							if (!updateTimer)
								updateTimer = setTimeout(() => {
									updateTimer = undefined;
									publish(onUpdate);
								}, 250);
						},
					});
					if (updateTimer) {
						clearTimeout(updateTimer);
						updateTimer = undefined;
					}
					if (result.code !== 0 && result.code !== null)
						throw new Error(`Command exited with code ${result.code}`);
					return {
						details: {
							exit: result.code,
							outputs: await declaredOutputs(outputs, cwd, runtime, jobSignal),
						},
					};
				},
				async onSettled(job) {
					if (!detached || !runtime.notifyBackground) return;
					const output = job.error ?? (job.output || "(no output)");
					await runtime.notifyBackground(
						`<background_job id="${job.id}" type="shell" state="${job.status}">\n${output}\n</background_job>`,
					);
				},
			});
			const abort = () => {
				if (!detached) runtime.jobs.cancel(started.id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				const wait = background ? 0 : (yieldMs ?? Number(env.PI_SHELL_YIELD_MS ?? 15_000));
				const job =
					wait === 0 && !background
						? await runtime.jobs.wait(started.id)
						: await runtime.jobs.wait(started.id, wait);
				if (!job) throw new Error("后台任务丢失");
				if (job.status === "running") {
					detached = true;
					return {
						content: [
							{
								type: "text",
								text: `命令仍在运行，已转入后台。job_id=${job.id}\n使用 job_output 增量读取，使用 job_kill 停止。`,
							},
						],
						details: { outputs: [], background: true, jobId: job.id, status: job.status, workdir: cwd },
					};
				}
				const raw = job.output;
				const truncation = truncateTail(raw);
				let fullOutputPath: string | undefined;
				if (truncation.truncated) {
					const directory = await mkdtemp(join(tmpdir(), `pie-${name}-`));
					fullOutputPath = join(directory, "output.log");
					await writeFile(fullOutputPath, raw);
				}
				let text = truncation.content || "(no output)";
				if (truncation.truncated) text += `\n\n[Output truncated. Full output: ${fullOutputPath}]`;
				if (job.status !== "completed") throw new Error(`${text}\n\n${job.error ?? `Command ${job.status}`}`);
				const jobDetails = job.details ?? {};
				return {
					content: [{ type: "text", text }],
					details: {
						output: truncation.content,
						exit: typeof jobDetails.exit === "number" || jobDetails.exit === null ? jobDetails.exit : undefined,
						truncation: truncation.truncated ? truncation : undefined,
						fullOutputPath,
						outputs: Array.isArray(jobDetails.outputs) ? (jobDetails.outputs as ArtifactOutput[]) : [],
						status: job.status,
						workdir: cwd,
					},
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				if (updateTimer) clearTimeout(updateTimer);
			}
		},
	};
}

export function shellTools(env: NodeJS.ProcessEnv, runtime: ToolRuntime): AgentTool[] {
	return [createShellTool("bash", env, runtime), createShellTool("powershell", env, runtime)];
}
