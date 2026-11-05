import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRuntimeStore, openStore } from "@pie/local/store";
import { type CreateSessionInput, RuntimeError, type TurnInput } from "@pie/runtime";
import type { Turn, TurnReceipt } from "@pie/runtime/protocol";
import { WorkerScheduler } from "@pie/runtime/worker-scheduler";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function controlledRuntime() {
	const creations: { id: string; input: CreateSessionInput }[] = [];
	const submissions: { sessionId: string; input: TurnInput }[] = [];
	const turns = new Map<string, { turn: Turn; done: ReturnType<typeof deferred> }>();
	let active = 0;
	let maxActive = 0;
	const host = {
		async createSession(input: CreateSessionInput) {
			const existing = creations.find((entry) => entry.input.creationKey === input.creationKey);
			if (existing) return { id: existing.id };
			const id = `session-${creations.length + 1}`;
			creations.push({ id, input });
			return { id };
		},
		async submitTurn(sessionId: string, input: TurnInput): Promise<TurnReceipt> {
			assert.notEqual(turns.get(sessionId)?.turn.status, "running", "same Session executed concurrently");
			const turn: Turn = { id: `turn-${submissions.length + 1}`, status: "running" };
			turns.set(sessionId, { turn, done: deferred() });
			submissions.push({ sessionId, input });
			active++;
			maxActive = Math.max(maxActive, active);
			return { sessionId, turnId: turn.id, accepted: true, started: true, settled: false };
		},
		async waitForTurn(
			sessionId: string,
			options?: {
				onWait?(turn: Turn | undefined): void;
				onSettled?(turn: Turn | undefined): void;
			},
		) {
			const current = turns.get(sessionId);
			options?.onWait?.(current && structuredClone(current.turn));
			await current?.done.promise;
			options?.onSettled?.(current && structuredClone(current.turn));
			return { turn: current?.turn };
		},
	};
	return {
		host,
		creations,
		submissions,
		get maxActive() {
			return maxActive;
		},
		settle(sessionId: string, status: "completed" | "cancelled" = "completed") {
			const current = turns.get(sessionId);
			assert(current && current.turn.status === "running");
			current.turn.status = status;
			active--;
			current.done.resolve();
		},
	};
}

async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("scheduler did not reach expected state");
}

test("one assistant runs independent work Sessions while supplements serialize and cancellation stays local", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-scheduler-"));
	const local = openStore({ PI_DATA_DIR: directory });
	const storage = createSqliteRuntimeStore(local);
	const runtime = controlledRuntime();
	const scheduler = new WorkerScheduler({ runtime: runtime.host, store: storage });
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "contract",
			assistantRevision: "1",
			runtime: { systemPrompt: "Review contracts.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const a = await scheduler.enqueueWorkerMessage({
		messageId: "contract-a",
		workerId: "contract",
		sourceWorkerId: "contract",
		kind: "request",
		content: "审查甲",
		newSession: true,
		workspacePath: "/work/a",
		model: { provider: "faux", id: "model-a" },
		productBinding: { astronSessionId: "product-a" },
	});
	const b = await scheduler.enqueueWorkerMessage({
		messageId: "contract-b",
		workerId: "contract",
		sourceWorkerId: "contract",
		kind: "request",
		content: "审查乙",
		newSession: true,
		workspacePath: "/work/b",
	});
	await until(() => runtime.submissions.length === 2);
	assert.equal((await scheduler.listWorkers()).length, 1);
	assert.equal(runtime.maxActive, 2);
	const deliveryA = await scheduler.getWorkerDelivery(a.delivery.deliveryId);
	const deliveryB = await scheduler.getWorkerDelivery(b.delivery.deliveryId);
	assert(deliveryA?.sessionId && deliveryB?.sessionId);
	assert.notEqual(deliveryA.sessionId, deliveryB.sessionId);
	assert.equal(runtime.creations[0]?.input.workspacePath, "/work/a");
	assert.deepEqual(runtime.creations[0]?.input.model, { provider: "faux", id: "model-a" });
	assert.deepEqual(runtime.submissions[0]?.input.model, { provider: "faux", id: "model-a" });
	assert.equal(runtime.creations[0]?.input.astronSessionId, "product-a");
	const supplement = await scheduler.enqueueWorkerMessage({
		messageId: "contract-a-more",
		workerId: "contract",
		sourceWorkerId: "contract",
		kind: "request",
		content: "甲补充条款",
		workId: a.message.workId,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runtime.submissions.length, 2, "supplement must wait for its Session");
	runtime.settle(deliveryA.sessionId);
	await scheduler.waitWorkerDelivery(a.delivery.deliveryId);
	await until(() => runtime.submissions.length === 3);
	assert.equal(runtime.submissions[2]?.sessionId, deliveryA.sessionId);
	assert.equal(runtime.submissions[2]?.input.text, "甲补充条款");
	assert.equal((await scheduler.getWorkerDelivery(b.delivery.deliveryId))?.status, "accepted");
	const lateA = await scheduler.enqueueWorkerMessage({
		messageId: "contract-a-late",
		workerId: "contract",
		sourceWorkerId: "contract",
		kind: "request",
		content: "取消前排队的甲补充",
		workId: a.message.workId,
	});
	runtime.settle(deliveryA.sessionId, "cancelled");
	assert.equal((await scheduler.waitWorkerDelivery(lateA.delivery.deliveryId)).status, "failed");
	assert.equal(runtime.submissions.length, 3, "queued input must not restart a cancelled request");
	runtime.settle(deliveryB.sessionId);
	assert.equal((await scheduler.waitWorkerDelivery(supplement.delivery.deliveryId)).status, "consumed");
	assert.equal((await scheduler.waitWorkerDelivery(b.delivery.deliveryId)).status, "consumed");
	const duplicate = await scheduler.enqueueWorkerMessage({
		messageId: "contract-a",
		workerId: "contract",
		sourceWorkerId: "contract",
		kind: "request",
		content: "审查甲",
		newSession: true,
		workspacePath: "/work/a",
		model: { provider: "faux", id: "model-a" },
		productBinding: { astronSessionId: "product-a" },
	});
	assert.equal(duplicate.delivery.status, "consumed");
	assert.equal(runtime.submissions.length, 3, "idempotent retry must not execute a second Turn");
});

test("receipts persist before a blocked Session creation and concurrent messages share one work Session in order", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-inbox-"));
	const local = openStore({ PI_DATA_DIR: directory });
	const storage = createSqliteRuntimeStore(local);
	const runtime = controlledRuntime();
	const creationStarted = deferred();
	const createAllowed = deferred();
	const scheduler = new WorkerScheduler({
		store: storage,
		runtime: {
			...runtime.host,
			async createSession(input) {
				creationStarted.resolve();
				await createAllowed.promise;
				return runtime.host.createSession(input);
			},
		},
	});
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const [first, second] = await Promise.all([
		scheduler.enqueueWorkerMessage({
			messageId: "first",
			workerId: "worker",
			sourceWorkerId: "worker",
			workId: "shared-work",
			kind: "request",
			content: "第一条",
		}),
		scheduler.enqueueWorkerMessage({
			messageId: "second",
			workerId: "worker",
			sourceWorkerId: "worker",
			workId: "shared-work",
			kind: "request",
			content: "第二条",
		}),
	]);
	await creationStarted.promise;
	assert.equal((await scheduler.getWorkerMessage(first.message.messageId)).content, "第一条");
	assert.equal((await scheduler.getWorkerMessage(second.message.messageId)).content, "第二条");
	assert(first.message.sequence < second.message.sequence);
	assert.equal(runtime.submissions.length, 0, "saved inbox must not wait for Session creation");
	createAllowed.resolve();
	await until(() => runtime.submissions.length === 1);
	assert.equal(runtime.submissions[0]?.input.text, "第一条");
	const sessionId = runtime.submissions[0]!.sessionId;
	runtime.settle(sessionId);
	await scheduler.waitWorkerDelivery(first.delivery.deliveryId);
	await until(() => runtime.submissions.length === 2);
	assert.equal(runtime.submissions[1]?.input.text, "第二条");
	assert.equal(runtime.submissions[1]?.sessionId, sessionId);
	assert.equal(runtime.creations.length, 1);
	runtime.settle(sessionId);
	await scheduler.waitWorkerDelivery(second.delivery.deliveryId);
	await assert.rejects(scheduler.getWorkerMessage("missing"), { status: 404 });
	await assert.rejects(scheduler.getWorkerDelivery("missing"), { status: 404 });
});

test("failed dispatch persistence never starts a model and restart never replays an accepted delivery", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-restart-"));
	let local = openStore({ PI_DATA_DIR: directory });
	let storage = createSqliteRuntimeStore(local);
	const runtime = controlledRuntime();
	const scheduler = new WorkerScheduler({
		runtime: runtime.host,
		store: {
			...storage,
			async updateWorkerDelivery(id, update) {
				if (update.status === "dispatched") throw new Error("injected storage failure");
				return storage.updateWorkerDelivery(id, update);
			},
		},
	});
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const input = {
		messageId: "saved-once",
		workerId: "worker",
		sourceWorkerId: "worker",
		kind: "request" as const,
		content: "不可重复执行",
		newSession: true,
	};
	const received = await scheduler.enqueueWorkerMessage(input);
	const failed = await scheduler.waitWorkerDelivery(received.delivery.deliveryId);
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /storage failure/);
	assert.equal(runtime.submissions.length, 0);
	await storage.updateWorkerDelivery(failed.deliveryId, { status: "accepted", acceptedTurnId: "known-turn" });
	await storage.close();
	local = openStore({ PI_DATA_DIR: directory });
	storage = createSqliteRuntimeStore(local);
	const restarted = new WorkerScheduler({ store: storage, runtime: runtime.host });
	const duplicate = await restarted.enqueueWorkerMessage(input);
	assert.equal(duplicate.delivery.status, "accepted");
	assert.equal(duplicate.delivery.acceptedTurnId, "known-turn");
	await restarted.drain();
	assert.equal(runtime.submissions.length, 0, "unknown prior execution must be reconciled, never replayed");
});

test("a precreated work item can bind separate Workers without changing its source or Session identities", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-shared-work-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const scheduler = new WorkerScheduler({ store: storage, runtime: runtime.host });
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes(
		["contract", "search"].map((assistantId) => ({
			assistantId,
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		})),
	);
	await scheduler.createWorkItem({ workId: "shared", title: "Existing product work" });
	const first = await scheduler.enqueueWorkerMessage({
		messageId: "same-identity",
		workerId: "contract",
		sourceWorkerId: "contract",
		workId: "shared",
		content: "合同工作",
		newSession: true,
	});
	const second = await scheduler.enqueueWorkerMessage({
		workerId: "search",
		sourceWorkerId: "contract",
		workId: "shared",
		content: "检索工作",
	});
	// A message identity and a work identity live in different namespaces.
	const third = await scheduler.enqueueWorkerMessage({
		workerId: "contract",
		sourceWorkerId: "contract",
		workId: "same-identity",
		content: "另一项工作",
	});
	await until(() => runtime.submissions.length === 3);
	assert.equal(new Set(runtime.creations.map((creation) => creation.id)).size, 3);
	assert.equal(new Set(runtime.creations.map((creation) => creation.input.creationKey)).size, 3);
	assert.equal((await storage.readWorkItem("shared"))?.sourceWorkerId, undefined);
	assert.equal((await storage.findAssignmentByWork("shared")).length, 2);
	for (const creation of runtime.creations) runtime.settle(creation.id);
	await Promise.all(
		[first, second, third].map((received) => scheduler.waitWorkerDelivery(received.delivery.deliveryId)),
	);
});

test("dispatch rechecks stop intent after waiting and close drains without starting queued work", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-stop-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const waiting = deferred();
	const releaseWait = deferred();
	const scheduler = new WorkerScheduler({
		store: storage,
		runtime: {
			...runtime.host,
			async waitForTurn(sessionId) {
				waiting.resolve();
				await releaseWait.promise;
				return runtime.host.waitForTurn(sessionId);
			},
		},
	});
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const received = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "停止前收到",
	});
	await waiting.promise;
	const worker = await storage.readWorker("worker");
	assert(worker);
	await storage.registerWorker({ ...worker, status: "stopped" });
	releaseWait.resolve();
	assert.equal((await scheduler.waitWorkerDelivery(received.delivery.deliveryId)).status, "failed");
	assert.equal(runtime.submissions.length, 0, "stop intent saved during wait must prevent execution");
	await storage.registerWorker({ ...worker, status: "active" });
	const active = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "继续新请求",
	});
	await until(() => runtime.submissions.length === 1);
	const queued = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		workId: active.message.workId,
		content: "关闭前排队",
	});
	scheduler.stop();
	runtime.settle(runtime.submissions[0]!.sessionId);
	await scheduler.drain();
	assert.equal(runtime.submissions.length, 1);
	assert.notEqual((await scheduler.getWorkerDelivery(queued.delivery.deliveryId)).status, "consumed");
	await assert.rejects(
		scheduler.enqueueWorkerMessage({ workerId: "worker", sourceWorkerId: "worker", content: "关闭后" }),
		{ status: 503 },
	);
});

for (const ordinaryOutcome of ["completed", "cancelled"] as const) {
	test(`ordinary Turn admission racing dispatch is ${ordinaryOutcome === "completed" ? "retried after settlement" : "not revived after cancellation"}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-worker-admission-race-"));
		const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
		const runtime = controlledRuntime();
		const ordinaryStarted = deferred();
		let raced = false;
		let ordinaryRunning = false;
		let rejected = false;
		const scheduler = new WorkerScheduler({
			store: {
				...storage,
				async updateWorkerDelivery(id, update) {
					const saved = await storage.updateWorkerDelivery(id, update);
					if (update.status === "dispatched" && !raced) {
						raced = true;
						assert(saved.sessionId);
						ordinaryRunning = true;
						await runtime.host.submitTurn(saved.sessionId, { text: "ordinary host input" });
						ordinaryStarted.resolve();
					}
					return saved;
				},
			},
			runtime: {
				...runtime.host,
				async submitTurn(sessionId, input) {
					if (ordinaryRunning) {
						rejected = true;
						throw new RuntimeError(409, "当前会话正在执行", "turn_running");
					}
					return runtime.host.submitTurn(sessionId, input);
				},
			},
		});
		t.after(async () => {
			scheduler.stop();
			await storage.close();
			await rm(directory, { recursive: true, force: true });
		});
		await scheduler.syncHostRuntimes([
			{
				assistantId: "worker",
				assistantRevision: "1",
				runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
			},
		]);
		const received = await scheduler.enqueueWorkerMessage({
			workerId: "worker",
			sourceWorkerId: "worker",
			content: "queued worker input",
		});
		await ordinaryStarted.promise;
		await until(() => rejected);
		const sessionId = runtime.submissions[0]!.sessionId;
		ordinaryRunning = false;
		runtime.settle(sessionId, ordinaryOutcome);
		if (ordinaryOutcome === "completed") {
			await until(() => runtime.submissions.length === 2);
			assert.equal(runtime.submissions[1]?.input.text, "queued worker input");
			runtime.settle(sessionId);
			assert.equal((await scheduler.waitWorkerDelivery(received.delivery.deliveryId)).status, "consumed");
		} else {
			assert.equal((await scheduler.waitWorkerDelivery(received.delivery.deliveryId)).status, "failed");
			assert.equal(runtime.submissions.length, 1);
		}
	});
}

test("a supplement waiting on an ordinary Turn is not revived after cancellation, but a new request is allowed", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-wait-cancel-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const waiting = deferred();
	const observedSettlement = deferred();
	const releaseSnapshot = deferred();
	let observeOrdinary = false;
	const scheduler = new WorkerScheduler({
		store: storage,
		runtime: {
			...runtime.host,
			waitForTurn(sessionId, options) {
				const delaySnapshot = observeOrdinary;
				const settled = runtime.host.waitForTurn(sessionId, {
					onWait: options?.onWait,
					onSettled(turn) {
						options?.onSettled?.(turn);
						if (delaySnapshot) observedSettlement.resolve();
					},
				});
				if (!delaySnapshot) return settled;
				waiting.resolve();
				return settled.then(async (result) => {
					await releaseSnapshot.promise;
					return result;
				});
			},
		},
	});
	t.after(async () => {
		scheduler.stop();
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const initial = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "create binding",
	});
	await until(() => runtime.submissions.length === 1);
	const sessionId = runtime.submissions[0]!.sessionId;
	runtime.settle(sessionId);
	await scheduler.waitWorkerDelivery(initial.delivery.deliveryId);
	await runtime.host.submitTurn(sessionId, { text: "ordinary host input" });
	observeOrdinary = true;
	const supplement = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		targetSessionId: sessionId,
		content: "supplement queued before cancellation",
	});
	await waiting.promise;
	runtime.settle(sessionId, "cancelled");
	await observedSettlement.promise;
	observeOrdinary = false;
	assert.equal(runtime.submissions.length, 2, "cancelled ordinary Turn must not restart queued input");
	const next = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		targetSessionId: sessionId,
		content: "explicit request after cancellation",
	});
	// A full snapshot can be slow; later input is outside the cancellation cutoff.
	releaseSnapshot.resolve();
	assert.equal((await scheduler.waitWorkerDelivery(supplement.delivery.deliveryId)).status, "failed");
	await until(() => runtime.submissions.length === 3);
	assert.equal(runtime.submissions[2]?.input.text, "explicit request after cancellation");
	runtime.settle(sessionId);
	assert.equal((await scheduler.waitWorkerDelivery(next.delivery.deliveryId)).status, "consumed");
});

test("a delivery waits for its admitted Turn before saving acceptance, not a later ordinary Turn", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-accepted-race-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const waitedForLaterTurn = deferred();
	const scheduler = new WorkerScheduler({
		store: {
			...storage,
			async updateWorkerDelivery(id, update) {
				const saved = await storage.updateWorkerDelivery(id, update);
				if (update.status === "accepted") {
					assert(saved.sessionId);
					runtime.settle(saved.sessionId);
					await runtime.host.submitTurn(saved.sessionId, { text: "later ordinary host input" });
				}
				return saved;
			},
		},
		runtime: {
			...runtime.host,
			waitForTurn(sessionId, options) {
				const settled = runtime.host.waitForTurn(sessionId, options);
				if (runtime.submissions.length === 2) waitedForLaterTurn.resolve();
				return settled;
			},
		},
	});
	t.after(async () => {
		scheduler.stop();
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const received = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "worker input",
	});
	const delivery = await Promise.race([
		scheduler.waitWorkerDelivery(received.delivery.deliveryId),
		waitedForLaterTurn.promise.then(() => undefined),
	]);
	assert(delivery, "a settled worker Turn must not wait for a later ordinary Turn");
	assert.equal(delivery.status, "consumed");
	assert.equal(delivery.acceptedTurnId, "turn-1");
	assert.equal(runtime.submissions[1]?.input.text, "later ordinary host input");
	runtime.settle(runtime.submissions[1]!.sessionId, "cancelled");
});

test("a Turn replaced before wait registration is left accepted for reconciliation without waiting for its replacement", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-fast-turn-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const waitedForReplacement = deferred();
	const scheduler = new WorkerScheduler({
		store: storage,
		runtime: {
			...runtime.host,
			async submitTurn(sessionId, input) {
				const receipt = await runtime.host.submitTurn(sessionId, input);
				runtime.settle(sessionId);
				await runtime.host.submitTurn(sessionId, { text: "replacement ordinary Turn" });
				return receipt;
			},
			waitForTurn(sessionId, options) {
				return runtime.host.waitForTurn(sessionId, {
					onWait(turn) {
						options?.onWait?.(turn);
						if (turn?.id === "turn-2") waitedForReplacement.resolve();
					},
					onSettled: options?.onSettled,
				});
			},
		},
	});
	t.after(async () => {
		scheduler.stop();
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const received = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "fast worker input",
	});
	const delivery = await Promise.race([
		scheduler.waitWorkerDelivery(received.delivery.deliveryId),
		waitedForReplacement.promise.then(() => undefined),
	]);
	assert(delivery, "must not wait for an unrelated replacement Turn");
	assert.equal(delivery.status, "accepted");
	assert.equal(delivery.acceptedTurnId, "turn-1");
	assert.match(delivery.error ?? "", /对账/);
	assert.equal(runtime.submissions.length, 2);
	runtime.settle(runtime.submissions[1]!.sessionId);
});

test("shutdown after dispatch intent preserves an unsubmitted delivery as resolved", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-dispatch-stop-"));
	const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = controlledRuntime();
	const scheduler = new WorkerScheduler({
		runtime: runtime.host,
		store: {
			...storage,
			async updateWorkerDelivery(id, update) {
				const saved = await storage.updateWorkerDelivery(id, update);
				if (update.status === "dispatched") scheduler.stop();
				return saved;
			},
		},
	});
	t.after(async () => {
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes([
		{
			assistantId: "worker",
			assistantRevision: "1",
			runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
		},
	]);
	const received = await scheduler.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "shutdown before submit",
	});
	const delivery = await scheduler.waitWorkerDelivery(received.delivery.deliveryId);
	assert.equal(delivery.status, "resolved");
	assert.equal(delivery.acceptedTurnId, undefined);
	assert.equal(runtime.submissions.length, 0);
	await scheduler.drain();
});

for (const error of [
	new Error("lost dispatch response"),
	new RuntimeError(409, "request identity conflict", "turn_mismatch"),
]) {
	test(`an uncertain dispatch rejection is never retried: ${error.message}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-worker-dispatch-unknown-"));
		const storage = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
		const runtime = controlledRuntime();
		let attempts = 0;
		const scheduler = new WorkerScheduler({
			store: storage,
			runtime: {
				...runtime.host,
				async submitTurn() {
					attempts++;
					throw error;
				},
			},
		});
		t.after(async () => {
			await storage.close();
			await rm(directory, { recursive: true, force: true });
		});
		await scheduler.syncHostRuntimes([
			{
				assistantId: "worker",
				assistantRevision: "1",
				runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
			},
		]);
		const input = {
			messageId: "stable-request",
			workerId: "worker",
			sourceWorkerId: "worker",
			content: "unknown work",
		};
		const received = await scheduler.enqueueWorkerMessage(input);
		const delivery = await scheduler.waitWorkerDelivery(received.delivery.deliveryId);
		assert.equal(delivery.status, "dispatched");
		assert.equal(delivery.error, error.message);
		assert.equal((await scheduler.enqueueWorkerMessage(input)).delivery.status, "dispatched");
		await scheduler.drain();
		assert.equal(attempts, 1);
	});
}
