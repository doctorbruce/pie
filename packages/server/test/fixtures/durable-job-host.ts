import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
	createAgentFactory,
	type DurableJobExecutor,
	type DurableJobReference,
	type DurableJobSnapshot,
} from "@pie/runtime";

export function persistentJobs(directory: string) {
	const db = new DatabaseSync(join(directory, "jobs.sqlite"));
	db.exec(
		"CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS submissions (id TEXT NOT NULL)",
	);
	const executor: DurableJobExecutor = {
		pollIntervalMs: 5,
		async submit(request) {
			db.prepare("INSERT INTO submissions VALUES (?)").run(request.id);
			db.prepare("INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(
				request.id,
				JSON.stringify({ ...request, status: "running" }),
			);
		},
		async get(reference) {
			const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(reference.id);
			return row ? (JSON.parse(String(row.payload)) as DurableJobSnapshot) : undefined;
		},
		async cancel(reference) {
			const current = await executor.get(reference);
			if (current?.status === "running") update(reference, { status: "cancelled", error: "executor cancelled" });
		},
	};
	function update(reference: DurableJobReference, fields: Partial<DurableJobSnapshot>) {
		db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(
			JSON.stringify({ ...reference, ...fields }),
			reference.id,
		);
	}
	return {
		executor,
		update,
		get submissions() {
			return Number(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()!.count);
		},
		close() {
			db.close();
		},
	};
}

export function jobAgents(onCreate: () => void = () => {}, forwardSignal = true) {
	const factory = createAgentFactory({
		models: { current: { models: createModels() } },
		tools: {
			catalog: [{ id: "remote", label: "Remote task" }],
			create: (context) => [
				{
					name: "remote",
					label: "Remote task",
					description: "Execute a durable external job",
					toolExecutionMode: "durable" as const,
					parameters: Type.Object({ value: Type.String() }),
					async execute(toolCallId, _input, signal) {
						assert(context.runJob);
						return context.runJob(toolCallId, forwardSignal ? signal : undefined);
					},
				},
			],
		},
		skills: () => ({ tools: [], afterToolCall: async () => undefined }),
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			async acquire() {
				return { tools: [], instructions: [], release() {} };
			},
			async close() {},
		},
		recordModelRequest: () => async () => undefined,
	});
	return {
		...factory,
		create(...args: Parameters<typeof factory.create>) {
			onCreate();
			return factory.create(...args);
		},
	};
}

export const jobDefinition = {
	assistantId: "assistant",
	assistantRevision: "original",
	runtime: { systemPrompt: "original prompt", toolIds: ["remote"], skills: [], subagents: [] },
};
