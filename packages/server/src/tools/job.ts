import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "./runtime.ts";

const parameters = Type.Object(
	{
		job_id: Type.String({ description: "Background job ID returned by bash, powershell, or task" }),
		wait_ms: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 300_000,
				description: "Wait up to this many milliseconds before reading",
			}),
		),
	},
	{ additionalProperties: false },
);

type JobDetails = {
	jobId: string;
	status: "running" | "completed" | "failed" | "cancelled";
	wallTimeMs: number;
};

function status(job: ReturnType<ToolRuntime["jobs"]["get"]>): string {
	if (!job) return "";
	const wallTimeMs = (job.finishedAt ?? Date.now()) - job.startedAt;
	return `[status: ${job.status}] [wall time: ${wallTimeMs}ms]${job.error ? `\n[error: ${job.error}]` : ""}`;
}

function details(job: NonNullable<ReturnType<ToolRuntime["jobs"]["get"]>>): JobDetails {
	return {
		jobId: job.id,
		status: job.status,
		wallTimeMs: (job.finishedAt ?? Date.now()) - job.startedAt,
	};
}

export function jobTools(runtime: ToolRuntime): AgentTool[] {
	const output: AgentTool<typeof parameters, JobDetails> = {
		name: "job_output",
		label: "后台任务输出",
		description:
			"Read only new output from a background shell or task job. Pass wait_ms to wait without polling in a tight loop.",
		parameters,
		async execute(_id, { job_id, wait_ms }, signal) {
			signal?.throwIfAborted();
			const initial = runtime.jobs.get(job_id);
			if (!initial) throw new Error(`未知后台任务：${job_id}`);
			if (initial.ownerSessionId !== runtime.sessionId) throw new Error("后台任务属于其他会话");
			if (wait_ms) await runtime.jobs.wait(job_id, wait_ms);
			signal?.throwIfAborted();
			const read = runtime.jobs.read(job_id);
			if (!read) throw new Error(`未知后台任务：${job_id}`);
			const text = `${read.delta || "(no new output)"}\n${status(read.job)}`;
			return { content: [{ type: "text", text }], details: details(read.job) };
		},
	};
	const kill: AgentTool<typeof parameters, JobDetails> = {
		name: "job_kill",
		label: "停止后台任务",
		description: "Cancel a running background shell or task job owned by this session.",
		parameters,
		async execute(_id, { job_id }) {
			const current = runtime.jobs.get(job_id);
			if (!current) throw new Error(`未知后台任务：${job_id}`);
			if (current.ownerSessionId !== runtime.sessionId) throw new Error("后台任务属于其他会话");
			runtime.jobs.cancel(job_id);
			const job = (await runtime.jobs.wait(job_id, 5_000))!;
			return {
				content: [{ type: "text", text: `已请求停止后台任务 ${job.id}\n${status(job)}` }],
				details: details(job),
			};
		},
	};
	return [output, kill];
}
