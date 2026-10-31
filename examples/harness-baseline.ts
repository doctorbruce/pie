import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createLocalHost } from "@pie/local";
import type { ExecutionBaseline } from "@pie/runtime";

// Fixed local workload; no credentials or environment configuration reach the host.
const directory = await mkdtemp(join(tmpdir(), "pie-harness-baseline-"));
const environment = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0", PI_MODEL_REQUEST_RECORDING: "0" };

async function sample(operation: () => Promise<unknown>) {
	const durations: number[] = [];
	for (let attempt = 0; attempt < 10; attempt++) {
		const start = performance.now();
		await operation();
		durations.push(performance.now() - start);
	}
	durations.sort((left, right) => left - right);
	return { samples: durations.length, p50Ms: durations[4], p95Ms: durations[9] };
}

async function diskBytes(path: string): Promise<number> {
	const entry = await stat(path);
	if (!entry.isDirectory()) return entry.size;
	const sizes = await Promise.all((await readdir(path)).map((name) => diskBytes(join(path, name))));
	return sizes.reduce((total, size) => total + size, 0);
}

try {
	const started = performance.now();
	let runtime = await createLocalHost(environment).ready;
	const startupMs = performance.now() - started;
	try {
		const histories = [];
		const sessions: string[] = [];
		for (const depth of [100, 10000]) {
			const session = await runtime.createSession({ mode: "faux", title: `history-${depth}` });
			sessions.push(session.id);
			await runtime.importSession(session.id, {
				schemaVersion: 1,
				source: { astronSessionId: `baseline-${depth}`, coreId: "fixture", sessionId: `baseline-${depth}` },
				transcript: Array.from({ length: depth }, (_, index) => ({
					id: `message-${index}`,
					role: "user",
					createdAt: index + 1,
					content: [{ type: "text", text: "x".repeat(512) }],
				})),
			});
			const page = await runtime.getSession(session.id, { limit: 50 });
			assert.equal(page.messages.length, 50);
			assert(page.history?.nextBeforeSeq);
			histories.push({
				depth,
				pageMessages: page.messages.length,
				pageBytes: Buffer.byteLength(JSON.stringify(page)),
				read: await sample(() => runtime.getSession(session.id, { limit: 50 })),
			});
		}
		const longSessionId = sessions[1];
		const fullStarted = performance.now();
		const full = await runtime.getSession(longSessionId);
		const fullReadMs = performance.now() - fullStarted;
		assert.equal(full.messages.length, 10000);
		const fullBytes = Buffer.byteLength(JSON.stringify(full));

		const concurrent = await Promise.all(
			Array.from({ length: 16 }, () => runtime.createSession({ mode: "faux", title: "concurrent" })),
		);
		const turnsStarted = performance.now();
		await Promise.all(concurrent.map((session) => runtime.submitTurn(session.id, { text: "ping" })));
		const settled = await Promise.all(concurrent.map((session) => runtime.waitForTurn(session.id)));
		const turnsMs = performance.now() - turnsStarted;
		assert(settled.every((session) => session.turn?.status === "completed"));
		sessions.push(...concurrent.map((session) => session.id));
		let baseline: ExecutionBaseline | undefined;
		const unsubscribe = await runtime.subscribeExecutions(sessions, (packet) => {
			if (packet.type === "execution.baseline") baseline = packet;
		});
		unsubscribe();
		assert(baseline);
		assert.equal(baseline.sessions.length, 18);
		const jobs = await runtime.listBackgroundJobs(longSessionId);
		assert.deepEqual(jobs.jobs, []);
		globalThis.gc?.();
		const rssBytes = process.memoryUsage().rss;
		const databaseBytes = await diskBytes(directory);
		await runtime.close();
		const restartStarted = performance.now();
		runtime = await createLocalHost(environment).ready;
		const restartMs = performance.now() - restartStarted;
		const restored = await runtime.getSession(longSessionId, { limit: 50 });
		assert.equal(restored.messages.length, 50);
		console.log(
			JSON.stringify(
				{
					schemaVersion: 1,
					node: process.version,
					platform: process.platform,
					gcAvailable: typeof globalThis.gc === "function",
					startupMs,
					restartMs,
					histories,
					explicitFullSnapshot: { messages: full.messages.length, bytes: fullBytes, readMs: fullReadMs },
					concurrent: { sessions: concurrent.length, turnsMs },
					executionBaseline: {
						sessions: baseline.sessions.length,
						bytes: Buffer.byteLength(JSON.stringify(baseline)),
					},
					jobsObservationBytes: Buffer.byteLength(JSON.stringify(jobs)),
					rssAfterWorkloadBytes: rssBytes,
					databaseBytes,
				},
				null,
				2,
			),
		);
	} finally {
		await runtime.close();
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
