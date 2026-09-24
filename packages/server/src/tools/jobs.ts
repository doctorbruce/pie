import { randomUUID } from "node:crypto";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export type BackgroundJobInfo = {
	id: string;
	ownerSessionId: string;
	type: "shell" | "task";
	title: string;
	status: BackgroundJobStatus;
	startedAt: number;
	finishedAt?: number;
	output: string;
	error?: string;
	details?: Record<string, unknown>;
};

type MutableJob = BackgroundJobInfo & {
	controller: AbortController;
	readOffset: number;
	settled: Promise<void>;
	resolveSettled: () => void;
};

const MAX_OUTPUT_BYTES = 1024 * 1024;

export class BackgroundJobs {
	readonly #jobs = new Map<string, MutableJob>();

	start(input: {
		id?: string;
		ownerSessionId: string;
		type: BackgroundJobInfo["type"];
		title: string;
		run: (
			signal: AbortSignal,
			append: (text: string) => void,
		) => Promise<{
			output?: string;
			details?: Record<string, unknown>;
		}>;
		onSettled?: (job: BackgroundJobInfo) => Promise<void> | void;
	}): BackgroundJobInfo {
		const id = input.id ?? randomUUID();
		const previous = this.#jobs.get(id);
		if (previous?.status === "running") throw new Error(`后台任务正在运行：${id}`);
		const controller = new AbortController();
		let resolveSettled = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const job: MutableJob = {
			id,
			ownerSessionId: input.ownerSessionId,
			type: input.type,
			title: input.title,
			status: "running",
			startedAt: Date.now(),
			output: "",
			controller,
			readOffset: 0,
			settled,
			resolveSettled,
		};
		this.#jobs.set(id, job);
		const append = (text: string) => {
			job.output += text;
			if (Buffer.byteLength(job.output) > MAX_OUTPUT_BYTES) {
				const buffer = Buffer.from(job.output);
				job.output = `[Earlier output discarded after ${MAX_OUTPUT_BYTES} bytes]\n${buffer.subarray(-MAX_OUTPUT_BYTES).toString("utf8")}`;
				job.readOffset = Math.min(job.readOffset, job.output.length);
			}
		};
		void input
			.run(controller.signal, append)
			.then((result) => {
				if (result.output && !job.output.endsWith(result.output)) append(result.output);
				job.details = result.details;
				job.status = controller.signal.aborted ? "cancelled" : "completed";
			})
			.catch((error: unknown) => {
				job.error = error instanceof Error ? error.message : String(error);
				job.status = controller.signal.aborted ? "cancelled" : "failed";
			})
			.finally(() => {
				job.finishedAt = Date.now();
				job.resolveSettled();
				void Promise.resolve(input.onSettled?.(this.snapshot(job))).catch(() => {});
			});
		return this.snapshot(job);
	}

	get(id: string): BackgroundJobInfo | undefined {
		const job = this.#jobs.get(id);
		return job ? this.snapshot(job) : undefined;
	}

	async wait(id: string, waitMs?: number): Promise<BackgroundJobInfo | undefined> {
		const job = this.#jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running") {
			if (waitMs === undefined) await job.settled;
			else if (waitMs > 0)
				await Promise.race([job.settled, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
		}
		return this.snapshot(job);
	}

	read(id: string): { job: BackgroundJobInfo; delta: string } | undefined {
		const job = this.#jobs.get(id);
		if (!job) return undefined;
		const delta = job.output.slice(job.readOffset, job.readOffset + 16_000);
		job.readOffset += delta.length;
		return { job: this.snapshot(job), delta };
	}

	cancel(id: string): BackgroundJobInfo | undefined {
		const job = this.#jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running") job.controller.abort();
		return this.snapshot(job);
	}

	list(ownerSessionId?: string): BackgroundJobInfo[] {
		return [...this.#jobs.values()]
			.filter((job) => ownerSessionId === undefined || job.ownerSessionId === ownerSessionId)
			.map((job) => this.snapshot(job));
	}

	close(): void {
		for (const job of this.#jobs.values()) if (job.status === "running") job.controller.abort();
	}

	private snapshot(job: MutableJob): BackgroundJobInfo {
		return {
			id: job.id,
			ownerSessionId: job.ownerSessionId,
			type: job.type,
			title: job.title,
			status: job.status,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			output: job.output,
			error: job.error,
			details: job.details,
		};
	}
}
