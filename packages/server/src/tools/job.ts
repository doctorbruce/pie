import { type FileHandle, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundJobInfo } from "./jobs.ts";
import type { ToolRuntime } from "./runtime.ts";

const parameters = Type.Object(
	{
		job_id: Type.String({ description: "Background job ID returned by bash or task" }),
		wait_ms: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 300_000,
				description: "Wait up to this many milliseconds before reading new output",
			}),
		),
	},
	{ additionalProperties: false },
);

type JobDetails = {
	jobId: string;
	status: BackgroundJobInfo["status"];
	wallTimeMs: number;
};

const fileOffsets = new Map<string, number>();
const fileDecoders = new Map<string, StringDecoder>();
const delivered = new Set<string>();

function outputPath(job: BackgroundJobInfo): string | undefined {
	const value = job.details?.outputPath;
	return typeof value === "string" && value ? value : undefined;
}

async function readFileDelta(path: string, settled: boolean): Promise<string | undefined> {
	let file: FileHandle;
	try {
		file = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const offset = fileOffsets.get(path) ?? 0;
		const size = (await file.stat()).size;
		if (size <= offset) return "";
		const buffer = Buffer.alloc(Math.min(16_000, size - offset));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
		fileOffsets.set(path, offset + bytesRead);
		const decoder = fileDecoders.get(path) ?? new StringDecoder("utf8");
		fileDecoders.set(path, decoder);
		let text = decoder.write(buffer.subarray(0, bytesRead));
		if (settled && offset + bytesRead >= size) {
			text += decoder.end();
			fileDecoders.delete(path);
		}
		return text;
	} finally {
		await file.close();
	}
}

function status(job: BackgroundJobInfo): string {
	const wallTimeMs = (job.finishedAt ?? Date.now()) - job.startedAt;
	return `[status: ${job.status}] [wall time: ${wallTimeMs}ms]${job.error ? `\n[error: ${job.error}]` : ""}`;
}

function details(job: BackgroundJobInfo): JobDetails {
	return {
		jobId: job.id,
		status: job.status,
		wallTimeMs: (job.finishedAt ?? Date.now()) - job.startedAt,
	};
}

function unknownJob(runtime: ToolRuntime, id: string): Error {
	const running = runtime.jobs.list(runtime.sessionId).filter((job) => job.status === "running");
	return new Error(
		running.length
			? `未知后台任务：${id}。当前运行任务：${running.map((job) => job.id).join(", ")}`
			: `未知后台任务：${id}`,
	);
}

export function jobTools(runtime: ToolRuntime): AgentTool[] {
	const output: AgentTool<typeof parameters, JobDetails> = {
		name: "job_output",
		label: "后台任务输出",
		description:
			"Read new output from a background bash or task job. Reads are incremental. Use wait_ms to wait without polling in a tight loop; completion is also reported automatically.",
		parameters,
		async execute(_id, { job_id, wait_ms }, signal) {
			signal?.throwIfAborted();
			const initial = runtime.jobs.get(job_id);
			if (!initial) throw unknownJob(runtime, job_id);
			if (initial.ownerSessionId !== runtime.sessionId) throw new Error("后台任务属于其他会话");
			if (wait_ms) await runtime.jobs.wait(job_id, wait_ms);
			signal?.throwIfAborted();
			const job = runtime.jobs.get(job_id);
			if (!job) throw unknownJob(runtime, job_id);
			const path = outputPath(job);
			const fileDelta = path ? await readFileDelta(path, job.status !== "running") : undefined;
			if (fileDelta !== undefined) {
				if (fileDelta)
					return {
						content: [{ type: "text", text: `${fileDelta}\n${status(job)}` }],
						details: details(job),
					};
				if (job.status !== "running" && !delivered.has(job.id)) {
					delivered.add(job.id);
					return {
						content: [{ type: "text", text: `${job.output || "(no output)"}\n${status(job)}` }],
						details: details(job),
					};
				}
				return {
					content: [{ type: "text", text: `(no new output)\n${status(job)}` }],
					details: details(job),
				};
			}
			const read = runtime.jobs.read(job_id);
			if (!read) throw unknownJob(runtime, job_id);
			return {
				content: [{ type: "text", text: `${read.delta || "(no new output)"}\n${status(read.job)}` }],
				details: details(read.job),
			};
		},
	};
	const kill: AgentTool<typeof parameters, JobDetails> = {
		name: "job_kill",
		label: "停止后台任务",
		description: "Cancel a running background bash or task job owned by this session.",
		parameters,
		async execute(_id, { job_id }) {
			const current = runtime.jobs.get(job_id);
			if (!current) throw unknownJob(runtime, job_id);
			if (current.ownerSessionId !== runtime.sessionId) throw new Error("后台任务属于其他会话");
			if (current.status !== "running")
				return {
					content: [{ type: "text", text: `后台任务 ${current.id} 已经是 ${current.status}\n${status(current)}` }],
					details: details(current),
				};
			runtime.jobs.cancel(job_id);
			const job = (await runtime.jobs.wait(job_id, 5_000)) ?? current;
			return {
				content: [{ type: "text", text: `已请求停止后台任务 ${job.id}\n${status(job)}` }],
				details: details(job),
			};
		},
	};
	return [output, kill];
}
