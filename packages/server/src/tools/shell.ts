import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { type ArtifactOutput, authorizeCommand, authorizePath, type ToolRuntime } from "./runtime.ts";
import { findShell, MAX_BYTES, MAX_LINES, resolvePath, runProcess, truncateTail } from "./shared.ts";

const SPOOL_LIMIT_BYTES = 1024 * 1024 * 1024;
const artifactRole = Type.Union([Type.Literal("final"), Type.Literal("intermediate"), Type.Literal("temporary")]);
const parameters = Type.Object(
	{
		command: Type.String({ description: "The command to execute" }),
		description: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 80,
				description:
					"Short user-visible activity title describing why the command is being run. Use the user's language and an action phrase. Do not repeat the raw command, URLs, credentials, or file paths.",
			}),
		),
		timeout: Type.Optional(
			Type.Integer({
				exclusiveMinimum: 0,
				maximum: 2_147_483_647,
				description:
					"Timeout in milliseconds while the command is in the foreground. It stops applying after the command moves to the background.",
			}),
		),
		yieldMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 300_000,
				description: "Wait this many milliseconds before moving the command to the background. Use 0 immediately.",
			}),
		),
		workdir: Type.Optional(
			Type.String({ description: "Working directory, relative to the session workspace. Prefer this over cd." }),
		),
		outputs: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({ description: "Expected output file path, relative to workdir" }),
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
	truncated?: boolean;
	outputPath?: string;
	outputs: ArtifactOutput[];
	background?: boolean;
	jobId?: string;
	status?: "running" | "completed" | "failed" | "cancelled";
	wallTimeMs?: number;
	workdir: string;
	shell: string;
};

type DeclaredOutput = {
	path: string;
	artifactRole: ArtifactOutput["artifactRole"];
};

async function resolveDeclaredOutputs(
	items: readonly { path: string; artifactRole: ArtifactOutput["artifactRole"] }[] | undefined,
	cwd: string,
	runtime: ToolRuntime,
	signal?: AbortSignal,
): Promise<DeclaredOutput[]> {
	const outputs: DeclaredOutput[] = [];
	for (const item of items ?? []) {
		const path = resolvePath(item.path, cwd);
		await authorizePath(runtime, path, "execute", signal);
		if (!outputs.some((output) => output.path === path)) outputs.push({ path, artifactRole: item.artifactRole });
	}
	return outputs;
}

async function collectDeclaredOutputs(items: readonly DeclaredOutput[]): Promise<{
	outputs: ArtifactOutput[];
	warnings: string[];
}> {
	const outputs: ArtifactOutput[] = [];
	const warnings: string[] = [];
	for (const item of items) {
		try {
			if (!(await stat(item.path)).isFile()) {
				warnings.push(`Declared output is not a file: ${item.path}`);
				continue;
			}
			outputs.push(item);
		} catch {
			warnings.push(`Declared output was not created: ${item.path}`);
		}
	}
	return { outputs, warnings };
}

export function shellTools(env: NodeJS.ProcessEnv, runtime: ToolRuntime): AgentTool[] {
	const shell = findShell(env);
	const numberSetting = (value: string | undefined, fallback: number) => {
		const parsed = Number(value ?? fallback);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
	};
	const defaultTimeoutMs = numberSetting(env.PI_BASH_TIMEOUT_MS, 120_000);
	const defaultYieldMs = numberSetting(env.PI_BASH_YIELD_MS, 15_000);
	const tool: AgentTool<typeof parameters, ShellDetails> = {
		name: "bash",
		label: "Bash",
		description: `Execute a command using ${shell.name} on ${process.platform}. This is the only native command tool. Always set description to a short user-visible action phrase in the user's language. Supports workdir, permission confirmation, declared artifacts, a ${defaultTimeoutMs}ms foreground timeout, automatic backgrounding after ${defaultYieldMs}ms, incremental job output, and cancellation. timeout and yieldMs use milliseconds. Foreground output keeps the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB.`,
		parameters,
		async execute(_id, { command, description, workdir, timeout, yieldMs, outputs }, signal, onUpdate) {
			const cwd = resolvePath(workdir ?? ".", runtime.directory);
			await authorizeCommand(runtime, command, cwd, signal);
			if (!(await stat(cwd)).isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
			const declared = await resolveDeclaredOutputs(outputs, cwd, runtime, signal);
			const outputDirectory = await mkdtemp(join(tmpdir(), "pie-bash-"));
			const outputPath = join(outputDirectory, "output.log");
			const spool = createWriteStream(outputPath);
			let spoolError: Error | undefined;
			spool.on("error", (error) => {
				spoolError = error;
			});
			let spoolBytes = 0;
			let spoolTruncated = false;
			let spoolMarkerWritten = false;
			let preview = "";
			let totalBytes = 0;
			let totalLines = 0;
			let updateTimer: NodeJS.Timeout | undefined;
			const waitMs = yieldMs ?? defaultYieldMs;
			let detached = waitMs === 0;
			const startedAt = Date.now();
			const publish = (callback: AgentToolUpdateCallback<ShellDetails> | undefined) => {
				if (!callback) return;
				const text = truncateTail(preview).content;
				callback({
					content: text ? [{ type: "text", text }] : [],
					details: { outputs: [], status: "running", workdir: cwd, shell: shell.name },
				});
			};
			const closeSpool = async () => {
				if (!spool.closed && !spool.destroyed)
					await new Promise<void>((resolve) => {
						spool.end(resolve);
					});
				if (spoolError) throw spoolError;
			};
			onUpdate?.({
				content: [],
				details: { outputs: [], status: "running", workdir: cwd, shell: shell.name },
			});
			const started = runtime.jobs.start({
				ownerSessionId: runtime.sessionId,
				type: "shell",
				title: description?.trim() || command.slice(0, 120),
				details: { outputPath, command, workdir: cwd, shell: shell.name },
				async run(jobSignal, append) {
					try {
						const result = await runProcess(shell.executable, shell.args(command), {
							cwd,
							env: { ...process.env, ...env },
							signal: jobSignal,
							timeoutMs: timeout ?? defaultTimeoutMs,
							isDetached: () => detached,
							captureOutput: false,
							onData(chunk) {
								const text = chunk.toString("utf8");
								if (text) {
									if (totalBytes === 0) totalLines = 1;
									totalBytes += Buffer.byteLength(text);
									totalLines += text.split("\n").length - 1;
									preview = truncateTail(preview + text, MAX_LINES * 2, MAX_BYTES * 2).content;
									append(text);
								}
								if (spoolBytes < SPOOL_LIMIT_BYTES) {
									const writable = chunk.subarray(0, SPOOL_LIMIT_BYTES - spoolBytes);
									spool.write(writable);
									spoolBytes += writable.length;
									if (writable.length < chunk.length) spoolTruncated = true;
								} else spoolTruncated = true;
								if (spoolTruncated && !spoolMarkerWritten) {
									spoolMarkerWritten = true;
									spool.write(
										`\n[output spool truncated at ${SPOOL_LIMIT_BYTES} bytes; the command keeps running]\n`,
									);
								}
								if (!updateTimer)
									updateTimer = setTimeout(() => {
										updateTimer = undefined;
										publish(onUpdate);
									}, 250);
							},
						});
						const artifacts =
							result.code === 0 ? await collectDeclaredOutputs(declared) : { outputs: [], warnings: [] };
						return {
							details: {
								exit: result.code,
								outputs: artifacts.outputs,
								warnings: artifacts.warnings,
							},
						};
					} finally {
						if (updateTimer) {
							clearTimeout(updateTimer);
							updateTimer = undefined;
						}
						await closeSpool();
					}
				},
				async onSettled(job) {
					if (!detached || !runtime.notifyBackground) return;
					const tail = truncateTail(job.output).content || "(no output)";
					const exit = job.details?.exit;
					await runtime.notifyBackground(
						`<background_job id="${job.id}" type="bash" state="${job.status}">\n${tail}\n\nexit=${typeof exit === "number" || exit === null ? exit : "unknown"}\noutput=${outputPath}\n</background_job>`,
					);
				},
			});
			const abort = () => {
				if (!detached) runtime.jobs.cancel(started.id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				const job = await runtime.jobs.wait(started.id, waitMs);
				if (!job) throw new Error("后台任务丢失");
				if (job.status === "running") {
					detached = true;
					const text = [
						preview || "(no output yet)",
						"",
						`Background job ${job.id}: the command is still running after ${Date.now() - startedAt}ms.`,
						`Full output: ${outputPath}`,
						"Use job_output to read new output or wait, and job_kill to stop it. Completion is reported automatically.",
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: {
							outputs: [],
							background: true,
							jobId: job.id,
							status: job.status,
							output: truncateTail(preview).content,
							outputPath,
							wallTimeMs: Date.now() - startedAt,
							workdir: cwd,
							shell: shell.name,
						},
					};
				}
				const limited = truncateTail(preview);
				const truncated = spoolTruncated || totalBytes > limited.outputBytes || totalLines > limited.outputLines;
				const jobDetails = job.details ?? {};
				const warnings = Array.isArray(jobDetails.warnings)
					? jobDetails.warnings.filter((item): item is string => typeof item === "string")
					: [];
				let text = limited.content || "(no output)";
				if (truncated) text = `...output truncated...\n\nFull output saved to: ${outputPath}\n\n${text}`;
				if (warnings.length) text += `\n\nArtifact warnings:\n${warnings.join("\n")}`;
				const exit = typeof jobDetails.exit === "number" || jobDetails.exit === null ? jobDetails.exit : undefined;
				if (exit !== undefined && exit !== 0)
					text += `\n\n<shell_metadata>Command exited with code ${exit}</shell_metadata>`;
				if (job.status !== "completed") {
					if (!truncated) await rm(outputDirectory, { recursive: true, force: true });
					throw new Error(
						`${text}\n\n${job.error ?? `Command ${job.status}`}${truncated ? `\nFull output: ${outputPath}` : ""}`,
					);
				}
				if (!truncated) await rm(outputDirectory, { recursive: true, force: true });
				return {
					content: [{ type: "text", text }],
					details: {
						output: limited.content,
						exit,
						truncated,
						outputPath: truncated ? outputPath : undefined,
						outputs: Array.isArray(jobDetails.outputs) ? (jobDetails.outputs as ArtifactOutput[]) : [],
						status: job.status,
						wallTimeMs: (job.finishedAt ?? Date.now()) - job.startedAt,
						workdir: cwd,
						shell: shell.name,
					},
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				if (updateTimer) clearTimeout(updateTimer);
			}
		},
	};
	return [tool];
}
