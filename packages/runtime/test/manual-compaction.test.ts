import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { createAgentFactory } from "../src/agent.ts";
import { WorkerCoordinationService } from "../src/coordination.ts";
import type { SessionEvent } from "../src/protocol.ts";
import { createRuntime } from "../src/runtime.ts";
import { WorkerScheduler } from "../src/worker-scheduler.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext, sessionRetention?: "release-after-turn") {
	const directory = await mkdtemp(join(tmpdir(), "pie-manual-compaction-"));
	const provider = fauxProvider({ models: [{ id: "test", contextWindow: 100000, maxTokens: 100 }] });
	const models = createModels();
	models.setProvider(provider.provider);
	const agents = createAgentFactory({
		env: {},
		models: { current: { models, selected: { provider: provider.getModel().provider, id: "test" } } },
		skills: () => ({ tools: [], afterToolCall: async () => undefined }),
		tools: { catalog: [], create: () => [] },
		recordModelRequest: () => async () => undefined,
		compactionSettings: () => ({
			compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 20000 },
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, maxAgentDelayMs: 1 },
		}),
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			acquire: async () => ({ tools: [], instructions: [], release() {} }),
			async close() {},
		},
	});
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const hooks: {
		readWorking?: () => Promise<void>;
		readPathIds?: () => Promise<void>;
		save?: () => Promise<void>;
		cleanup?: () => void | Promise<void>;
	} = {};
	let closed = false;
	const runtime = await createRuntime({
		agents,
		sessionRetention,
		store: {
			...store,
			async readWorkingPath(...args) {
				await hooks.readWorking?.();
				return store.readWorkingPath(...args);
			},
			async readPathIds(...args) {
				await hooks.readPathIds?.();
				return store.readPathIds(...args);
			},
			async saveSession(...args) {
				await hooks.save?.();
				return store.saveSession(...args);
			},
			async close() {
				closed = true;
				await store.close();
			},
		},
		hostRuntimes: [
			{
				assistantId: "manual",
				assistantRevision: "1",
				runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
			},
		],
	});
	t.after(async () => {
		await hooks.cleanup?.();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "manual", mode: "real" });
	await runtime.importSession(session.id, {
		schemaVersion: 1,
		source: { astronSessionId: "source", coreId: "test", sessionId: "source" },
		transcript: [
			{ role: "user", createdAt: 1, content: [{ type: "text", text: "old question" }] },
			{ role: "assistant", createdAt: 2, content: [{ type: "text", text: "old answer" }] },
			{ role: "user", createdAt: 3, content: [{ type: "text", text: "latest question" }] },
			{ role: "assistant", createdAt: 4, content: [{ type: "text", text: "latest answer" }] },
		],
	});
	return { runtime, session, provider, agents, hooks, store, isClosed: () => closed };
}

function holdSummary(provider: ReturnType<typeof fauxProvider>) {
	const started = deferred();
	provider.setResponses([
		async (_context, options) => {
			assert(options?.signal);
			const signal = options.signal;
			started.resolve();
			return await new Promise<never>((_resolve, reject) => {
				signal.throwIfAborted();
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	]);
	return started.promise;
}

test("manual compaction persists a checkpoint without a Turn and subsequent input uses the compacted context", async (t) => {
	const { runtime, session, provider } = await fixture(t);
	const before = await runtime.getSession(session.id);
	const events: SessionEvent[] = [];
	await runtime.subscribe(session.id, (event) => events.push(event));
	provider.setResponses([fauxAssistantMessage("checkpoint")]);
	const result = await runtime.compactSession(session.id);
	assert.equal(result.completed, true);
	assert.equal(result.compacted, true);
	assert.equal(result.compaction?.generation, 1);
	const after = await runtime.getSession(session.id);
	assert.deepEqual(after.messages, before.messages);
	assert.equal(after.turn, undefined);
	assert.equal(after.execution.actions.submit.available, true);
	assert.deepEqual(
		events.filter((event) => event.type.startsWith("compaction.")).map((event) => [event.type, event.event?.reason]),
		[
			["compaction.started", "manual"],
			["compaction.updated", undefined],
			["compaction.finished", "manual"],
		],
	);
	assert(!events.some((event) => event.type === "agent.event" || event.type === "turn.settled"));
	assert.deepEqual(await runtime.compactSession(session.id), { completed: true, compacted: false });
	assert.equal(provider.state.callCount, 1);
	provider.setResponses([
		(context) => {
			assert(JSON.stringify(context.messages).includes("checkpoint"));
			assert(!JSON.stringify(context.messages).includes("old question"));
			return fauxAssistantMessage("next answer");
		},
	]);
	await runtime.submitTurn(session.id, { text: "next question" });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
});

test("manual summary rejects concurrent session writes, permits other sessions and unlocks after request cancellation", async (t) => {
	const { runtime, session, provider } = await fixture(t);
	const started = holdSummary(provider);
	const controller = new AbortController();
	const pending = runtime.compactSession(session.id, {}, { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await started;
	await assert.rejects(runtime.compactSession(session.id), { status: 409 });
	await assert.rejects(runtime.submitTurn(session.id, { text: "conflict" }), { status: 409 });
	await assert.rejects(runtime.renameSession(session.id, { title: "conflict" }), { status: 409 });
	await assert.rejects(runtime.selectTree(session.id, { messageId: "anything" }), { status: 409 });
	await assert.rejects(runtime.importSession(session.id, {}), { status: 409 });
	await assert.rejects(runtime.forkSession(session.id, { messageIndex: 0 }), { status: 409 });
	await assert.rejects(
		runtime.setSessionWorkspace(session.id, { workspacePath: join(tmpdir(), "manual-compaction-conflict") }),
		{ status: 409 },
	);
	await assert.rejects(runtime.deleteSession(session.id), { status: 409 });
	const other = await runtime.createSession({ assistantId: "manual", mode: "real" });
	assert.notEqual(other.id, session.id);
	controller.abort(new Error("request disconnected"));
	await rejected;
	assert.equal((await runtime.getSession(session.id)).compaction, undefined);
	assert.equal((await runtime.renameSession(session.id, { title: "unlocked" })).title, "unlocked");
});

test("manual compaction reserves history during preparation and rejects already queued writes", async (t) => {
	const { runtime, session, provider, hooks } = await fixture(t, "release-after-turn");
	const reading = deferred();
	const releaseRead = deferred();
	hooks.readWorking = async () => {
		reading.resolve();
		await releaseRead.promise;
	};
	hooks.cleanup = () => releaseRead.resolve();
	const controller = new AbortController();
	const pending = runtime.compactSession(session.id, {}, { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await reading.promise;
	await assert.rejects(runtime.submitTurn(session.id, { text: "conflict" }), { status: 409 });
	await assert.rejects(runtime.renameSession(session.id, { title: "conflict" }), { status: 409 });
	controller.abort();
	releaseRead.resolve();
	await rejected;
	assert.equal(provider.state.callCount, 0);
	hooks.readWorking = undefined;
	const saving = deferred();
	const releaseSave = deferred();
	hooks.save = async () => {
		saving.resolve();
		await releaseSave.promise;
	};
	hooks.cleanup = () => releaseSave.resolve();
	const write = runtime.renameSession(session.id, { title: "queued writer" });
	await assert.rejects(runtime.compactSession(session.id), { status: 409 });
	await saving.promise;
	await assert.rejects(runtime.compactSession(session.id), { status: 409 });
	releaseSave.resolve();
	await write;
	assert.equal((await runtime.getSession(session.id)).compaction, undefined);
});

test("request cancellation after summarization but before persistence leaves history and storage available", async (t) => {
	const { runtime, session, provider, hooks } = await fixture(t);
	const resolvingIds = deferred();
	const releaseIds = deferred();
	hooks.readPathIds = async () => {
		resolvingIds.resolve();
		await releaseIds.promise;
	};
	hooks.cleanup = () => releaseIds.resolve();
	provider.setResponses([fauxAssistantMessage("checkpoint")]);
	const controller = new AbortController();
	const pending = runtime.compactSession(session.id, {}, { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await resolvingIds.promise;
	controller.abort();
	releaseIds.resolve();
	await rejected;
	assert.equal((await runtime.getSession(session.id)).compaction, undefined);
	assert.equal(runtime.storageAvailable, true);
	assert.equal((await runtime.renameSession(session.id, { title: "still writable" })).title, "still writable");
});

test("close aborts a summary and waits for cancellation before closing storage", async (t) => {
	const { runtime, session, provider, isClosed } = await fixture(t);
	const started = holdSummary(provider);
	const pending = runtime.compactSession(session.id);
	const rejected = assert.rejects(pending);
	await started;
	await runtime.close();
	await rejected;
	assert.equal(isClosed(), true);
});

test("close aborts preparation and waits for its cleanup before closing storage", async (t) => {
	const { runtime, session, provider, hooks, isClosed } = await fixture(t, "release-after-turn");
	const reading = deferred();
	const releaseRead = deferred();
	hooks.readWorking = async () => {
		reading.resolve();
		await releaseRead.promise;
	};
	hooks.cleanup = () => releaseRead.resolve();
	const pending = runtime.compactSession(session.id);
	const rejected = assert.rejects(pending);
	await reading.promise;
	const closed = runtime.close();
	assert.equal(isClosed(), false);
	releaseRead.resolve();
	await closed;
	await rejected;
	assert.equal(provider.state.callCount, 0);
});

test("close waits for a started checkpoint transaction and preserves its successful outcome", async (t) => {
	const { runtime, session, provider, hooks, isClosed } = await fixture(t);
	const saving = deferred();
	const releaseSave = deferred();
	hooks.save = async () => {
		saving.resolve();
		await releaseSave.promise;
	};
	hooks.cleanup = () => releaseSave.resolve();
	provider.setResponses([fauxAssistantMessage("checkpoint")]);
	const pending = runtime.compactSession(session.id);
	await saving.promise;
	const closed = runtime.close();
	assert.equal(isClosed(), false);
	releaseSave.resolve();
	assert.equal((await pending).compacted, true);
	await closed;
	assert.equal(isClosed(), true);
});

for (const raceAfterFailedTurn of [false, true]) {
	test(
		raceAfterFailedTurn
			? "Worker admission retries a compaction race without treating the old failed Turn as a new failure"
			: "Worker admission waits for manual compaction without repeatedly submitting or writing deliveries",
		{ timeout: 10000 },
		async (t) => {
			const { runtime, session, provider, hooks, store } = await fixture(t);
			const controller = new AbortController();
			const waiting = deferred();
			let waitCalls = 0;
			let submitCalls = 0;
			let compacting: Promise<unknown> | undefined;
			let cancelled: Promise<void> | undefined;
			let summaryStarted: Promise<void>;
			const scheduler = new WorkerScheduler({
				store,
				runtime: {
					createSession: (input) => runtime.createSession(input),
					async waitForTurn(...args) {
						waitCalls++;
						const expectedWaits = raceAfterFailedTurn ? 2 : 1;
						if (waitCalls === expectedWaits) waiting.resolve();
						if (!controller.signal.aborted && waitCalls > expectedWaits)
							throw new Error("Worker admission repeated its wait while manual compaction was still running");
						return runtime.waitForTurn(...args);
					},
					async submitTurn(...args) {
						submitCalls++;
						if (raceAfterFailedTurn && !compacting) {
							compacting = runtime.compactSession(session.id, {}, { signal: controller.signal });
							cancelled = assert.rejects(compacting);
							await summaryStarted;
						}
						return runtime.submitTurn(...args);
					},
				},
			});
			hooks.cleanup = async () => {
				scheduler.stop();
				controller.abort();
				await cancelled;
				await scheduler.drain();
			};
			await scheduler.syncHostRuntimes([
				{
					assistantId: "manual",
					assistantRevision: "1",
					runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
				},
			]);
			const coordination = new WorkerCoordinationService(store);
			await coordination.createWorkItem({ workId: "manual-work", title: "Manual compaction worker test" });
			await coordination.createAssignment({ workId: "manual-work", workerId: "manual", sessionId: session.id });
			if (raceAfterFailedTurn) {
				provider.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "previous failure" }),
				]);
				await runtime.submitTurn(session.id, { text: "previous failed input" });
				assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "failed");
			}
			summaryStarted = holdSummary(provider);
			if (!raceAfterFailedTurn) {
				compacting = runtime.compactSession(session.id, {}, { signal: controller.signal });
				cancelled = assert.rejects(compacting);
				await summaryStarted;
			}
			const receipt = await scheduler.enqueueWorkerMessage({
				workerId: "manual",
				sourceWorkerId: "manual",
				targetSessionId: session.id,
				content: "worker input after compaction",
				mode: "real",
			});
			const entered = await Promise.race([
				waiting.promise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
			]);
			assert.equal(entered, true, JSON.stringify(await scheduler.getWorkerDelivery(receipt.delivery.deliveryId)));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(submitCalls, raceAfterFailedTurn ? 1 : 0);
			assert.equal(waitCalls, raceAfterFailedTurn ? 2 : 1);
			assert.equal((await scheduler.getWorkerDelivery(receipt.delivery.deliveryId)).status, "resolved");
			provider.appendResponses([fauxAssistantMessage("worker answer")]);
			controller.abort();
			await cancelled;
			const delivery = await scheduler.waitWorkerDelivery(receipt.delivery.deliveryId);
			assert.equal(delivery.status, "consumed");
			assert.equal(delivery.error, undefined);
			assert.equal(submitCalls, raceAfterFailedTurn ? 2 : 1);
			const result = await runtime.getSession(session.id);
			assert.equal(result.turn?.status, "completed");
			assert.equal(
				result.messages.filter(
					(message) =>
						message.role === "user" && JSON.stringify(message.content).includes("worker input after compaction"),
				).length,
				1,
			);
		},
	);
}
