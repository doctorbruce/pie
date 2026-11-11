import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createSqliteRuntimeStore, openStore } from "@pie/local/store";
import { WorkerCoordinationService, type WorkerMessageKind } from "@pie/runtime/coordination";
import type { Turn, TurnReceipt } from "@pie/runtime/protocol";
import type { SavedSession } from "@pie/runtime/runtime-store";
import { syncMessageTree } from "@pie/runtime/session-tree";
import type { WorkerCallContext, WorkerWaitResult } from "@pie/runtime/worker-communication";
import { WorkerScheduler } from "@pie/runtime/worker-scheduler";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-sync-wait-"));
	let local = openStore({ PI_DATA_DIR: directory });
	let store = createSqliteRuntimeStore(local);
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const service = new WorkerCoordinationService(store);
	await service.createWorkItem({ workId: "work", title: "peer conversation" });
	for (const workerId of ["source", "target"]) {
		await service.registerWorker({ workerId, assistantId: workerId });
		await service.createAssignment({
			assignmentId: `${workerId}-assignment`,
			workerId,
			workId: "work",
			sessionId: `${workerId}-session`,
		});
		local.saveSession({
			id: `${workerId}-session`,
			assistantId: workerId,
			workerId,
			kind: "root",
			runtimeSource: "host",
			title: workerId,
			mode: "faux",
			model: "faux",
			createdAt: 1,
			updatedAt: 1,
			revision: 0,
			messages: [],
			turn: { id: `${workerId}-turn`, status: "running" },
		});
	}
	const requestInput = {
		messageId: "request",
		workerId: "target",
		sourceWorkerId: "source",
		sourceSessionId: "source-session",
		sourceTurnId: "source-turn",
		targetSessionId: "target-session",
		workId: "work",
		content: "implement an adder",
	};
	const request = await service.enqueueMessage(requestInput);
	const context: WorkerCallContext = {
		workerId: "source",
		sessionId: "source-session",
		turnId: "source-turn",
		toolCallId: "wait-call",
		targets: [],
		mode: "faux",
	};
	return {
		get local() {
			return local;
		},
		get store() {
			return store;
		},
		service,
		request,
		requestInput,
		context,
		replyInput(kind: WorkerMessageKind = "result", messageId = "response") {
			return {
				messageId,
				workerId: "source",
				sourceWorkerId: "target",
				sourceSessionId: "target-session",
				sourceTurnId: "target-turn",
				replyTo: "request",
				kind,
				content: kind,
			};
		},
		completion(result: WorkerWaitResult): SavedSession {
			const saved = local.readSession(context.sessionId)!;
			const tree = local.readPath(context.sessionId);
			const messages: AgentMessage[] = [
				...tree.nodes.map((node) => node.message),
				{
					role: "toolResult",
					toolCallId: result.wait.toolCallId,
					toolName: "communicate",
					content: [{ type: "text", text: result.messages.map((message) => message.content).join("\n") }],
					details: result,
					isError: false,
					timestamp: Date.now(),
				},
			];
			return { ...saved, messages, tree: syncMessageTree(tree, messages), revision: saved.revision + 1 };
		},
		async reopen() {
			await store.close();
			local = openStore({ PI_DATA_DIR: directory });
			store = createSqliteRuntimeStore(local);
		},
	};
}

test("sync replies are reserved exclusively and consumed with the matching tool result", async (t) => {
	const f = await fixture(t);
	const reply = await f.service.enqueueMessage(f.replyInput());
	const claimed = await f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" });
	assert.equal(claimed.wait.status, "ready");
	assert.deepEqual(claimed.receipts, [{ deliveryId: reply.delivery.deliveryId, messageId: "response" }]);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
	assert.deepEqual(await f.store.listWorkerInputs(f.context.sessionId), []);
	const another = await f.store.registerWorkerWait({ ...f.context, toolCallId: "other" }, "request", "other-wait", {
		mode: "sync",
	});
	assert.equal(another.wait.status, "waiting");
	const completion = {
		workerWait: { waitId: "wait", toolCallId: f.context.toolCallId, responses: claimed.receipts! },
	};
	const before = await f.store.readSession(f.context.sessionId);
	const withoutResult: SavedSession = { ...before!, messages: [], revision: 1 };
	await assert.rejects(f.store.saveSession(withoutResult, false, [], completion), /工具结果不匹配/);
	assert.deepEqual(await f.store.readSession(f.context.sessionId), before);
	await assert.rejects(
		f.store.saveSession(f.completion(claimed), false, [], {
			workerInputs: [{ deliveryId: "absent", messageId: "absent" }],
			...completion,
		}),
		/不存在/,
	);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
	await assert.rejects(
		f.store.saveSession(f.completion(claimed), false, [], {
			workerInputs: claimed.receipts,
		}),
		/同步等待占有/,
	);
	await f.store.saveSession(f.completion(claimed), false, [], completion);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "consumed");
	assert.equal(await f.store.isWorkerDeliveryClaimed(reply.delivery.deliveryId), false);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
	const ready = await f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" });
	assert.equal(ready.wait.status, "ready");
	assert.equal(ready.receipts, undefined);
	assert.equal(ready.messages[0]?.messageId, "response");
	const later = await f.service.enqueueMessage(f.replyInput("result", "later-result"));
	await assert.rejects(
		f.store.saveSession(f.completion(claimed), false, [], {
			workerWait: {
				waitId: "wait",
				toolCallId: f.context.toolCallId,
				responses: [{ deliveryId: later.delivery.deliveryId, messageId: later.message.messageId }],
			},
		}),
		/不能接纳其他回信/,
	);
	assert.equal((await f.store.readWorkerDelivery(later.delivery.deliveryId))?.status, "resolved");
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
});

test("progress returns control without completing the request; a later question resumes the same Turn once", async (t) => {
	const f = await fixture(t);
	let settleSource = () => {};
	const sourceDone = new Promise<void>((resolve) => {
		settleSource = resolve;
	});
	let submissions = 0;
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unexpected Session creation");
			},
			async submitTurn() {
				submissions++;
				throw new Error("duplicate Turn");
			},
			async waitForTurn() {
				await sourceDone;
				return {};
			},
		},
	});
	t.after(() => {
		scheduler.stop();
		settleSource();
	});
	const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs: 5_000 });
	const progress = await scheduler.enqueueWorkerMessage(f.replyInput("progress", "progress"));
	const update = await waiting;
	assert.equal(update.wait.status, "waiting");
	assert.equal(update.reason, "message");
	assert.deepEqual(update.messages, []);
	assert.equal(update.receipts, undefined);
	assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
	await f.store.saveSession(f.completion(update), false, [], {
		workerInputs: [{ deliveryId: progress.delivery.deliveryId, messageId: progress.message.messageId }],
	});
	let returned = false;
	const continued = scheduler
		.wait({ ...f.context, toolCallId: "continue-wait" }, "request", undefined, { mode: "sync" })
		.then((result) => {
			returned = true;
			return result;
		});
	await setImmediate();
	assert.equal(returned, false);
	const question = await scheduler.enqueueWorkerMessage(f.replyInput("question", "question"));
	const result = await continued;
	assert.equal(result.wait.status, "ready");
	assert.equal(result.messages[0]?.kind, "question");
	assert.equal((await f.store.readSession(f.context.sessionId))?.turn?.status, "running");
	await f.store.saveSession(f.completion(result), false, [], {
		workerWait: { waitId: result.wait.waitId, toolCallId: result.wait.toolCallId, responses: result.receipts! },
	});
	settleSource();
	assert.equal((await scheduler.waitWorkerDelivery(question.delivery.deliveryId)).status, "consumed");
	await scheduler.waitWorkerDelivery(progress.delivery.deliveryId);
	assert.equal(submissions, 0);
});

test("sync timeout keeps the request active and late results available to normal delivery", async (t) => {
	const f = await fixture(t);
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unused");
			},
			async submitTurn() {
				throw new Error("unused");
			},
			async waitForTurn() {
				return {};
			},
		},
	});
	t.after(() => scheduler.stop());
	const result = await scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs: 5 });
	assert.equal(result.wait.status, "timed_out");
	assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
	const reply = await f.service.enqueueMessage(f.replyInput());
	assert.deepEqual(
		(await f.store.listWorkerInputs(f.context.sessionId)).map((input) => input.message.messageId),
		[reply.message.messageId],
	);
});

for (const timeoutMs of [undefined, 90_000]) {
	test(`sync wait returns control after 30 seconds with ${timeoutMs === undefined ? "no deadline" : "a longer deadline"}`, async (t) => {
		const f = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
		let settleSource = () => {};
		const sourceDone = new Promise<void>((resolve) => {
			settleSource = resolve;
		});
		const scheduler = new WorkerScheduler({
			store: f.store,
			runtime: {
				async createSession() {
					throw new Error("unused");
				},
				async submitTurn() {
					throw new Error("duplicate Turn");
				},
				async waitForTurn() {
					await sourceDone;
					return {};
				},
			},
		});
		t.after(() => {
			scheduler.stop();
			settleSource();
		});
		let returned = false;
		const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs }).then((result) => {
			returned = true;
			return result;
		});
		await setImmediate();
		t.mock.timers.tick(29_999);
		await setImmediate();
		assert.equal(returned, false);
		t.mock.timers.tick(1);
		const pending = await waiting;
		assert.equal(pending.wait.status, "waiting");
		assert.equal(pending.wait.mode, "sync");
		assert.equal(pending.reason, "interval");
		assert.deepEqual(pending.messages, []);
		assert.equal(pending.receipts, undefined);
		assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
		await f.store.saveSession(f.completion(pending));
		const continued = scheduler.wait({ ...f.context, toolCallId: "continue-wait" }, "request", undefined, {
			mode: "sync",
		});
		const reply = await scheduler.enqueueWorkerMessage(f.replyInput());
		const result = await continued;
		assert.equal(result.messages[0]?.messageId, "response");
		assert.equal(result.wait.status, "ready");
		await f.store.saveSession(f.completion(result), false, [], {
			workerWait: { waitId: result.wait.waitId, toolCallId: result.wait.toolCallId, responses: result.receipts! },
		});
		settleSource();
		assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "consumed");
	});
}

for (const reason of ["message", "interval"] as const) {
	for (const cancel of [false, true]) {
		test(`a result racing with ${reason} return is ${cancel ? "released on abort" : "claimed as a response"}`, async (t) => {
			const f = await fixture(t);
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
			if (reason === "message") await f.service.enqueueMessage(f.replyInput("progress", "progress"));
			const controller = new AbortController();
			let registrations = 0;
			const scheduler = new WorkerScheduler({
				store: {
					...f.store,
					async listWorkerInputs(sessionId) {
						const inputs = await f.store.listWorkerInputs(sessionId);
						await f.service.enqueueMessage(f.replyInput());
						if (reason === "interval") t.mock.timers.tick(30_000);
						return inputs;
					},
					async registerWorkerWait(context, messageId, waitId, options) {
						const result = await f.store.registerWorkerWait(context, messageId, waitId, options);
						if (++registrations === 2 && cancel) controller.abort();
						return result;
					},
				},
				runtime: {
					async createSession() {
						throw new Error("unused");
					},
					async submitTurn() {
						throw new Error("unused");
					},
					async waitForTurn() {
						throw new Error("unused");
					},
				},
			});
			t.after(() => scheduler.stop());
			const waiting = scheduler.wait(f.context, "request", controller.signal, { mode: "sync" });
			if (cancel) {
				await assert.rejects(waiting, { name: "AbortError" });
				assert.equal(await f.store.isWorkerDeliveryClaimed("response:delivery"), false);
				assert.equal((await f.store.readWorkerDelivery("response:delivery"))?.status, "resolved");
				return;
			}
			const result = await waiting;
			assert.equal(result.wait.status, "ready");
			assert.equal(result.reason, undefined);
			assert.deepEqual(result.receipts, [{ deliveryId: "response:delivery", messageId: "response" }]);
			await f.store.saveSession(f.completion(result), false, [], {
				workerWait: { waitId: result.wait.waitId, toolCallId: result.wait.toolCallId, responses: result.receipts! },
			});
			assert.equal((await f.store.readWorkerDelivery("response:delivery"))?.status, "consumed");
		});
	}
}

test("cancelling after an interval return prevents late progress from restarting the source Turn", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
	let submissions = 0;
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unused");
			},
			async submitTurn() {
				submissions++;
				throw new Error("cancelled Turn must not resume");
			},
			async waitForTurn() {
				return {};
			},
		},
	});
	t.after(() => scheduler.stop());
	const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync" });
	await setImmediate();
	t.mock.timers.tick(30_000);
	assert.equal((await waiting).reason, "interval");
	await scheduler.cancel(f.context.sessionId, f.context.turnId);
	const progress = await scheduler.enqueueWorkerMessage(f.replyInput("progress", "late-progress"));
	const delivery = await scheduler.waitWorkerDelivery(progress.delivery.deliveryId);
	assert.equal(delivery.status, "failed");
	assert.match(delivery.error ?? "", /原请求 Turn 已取消/);
	assert.deepEqual(await scheduler.inputs(f.context.sessionId), []);
	assert.equal(submissions, 0);
	assert.equal(await f.store.isWorkerTurnCancelled("target-session", "target-turn"), false);
});

for (const status of ["failed", "cancelled", "interrupted"] as const) {
	test(`sync wait exits when its admitted peer Turn is ${status}`, async (t) => {
		const f = await fixture(t);
		let submitted = false;
		const scheduler = new WorkerScheduler({
			store: f.store,
			runtime: {
				async createSession() {
					throw new Error("unused");
				},
				async submitTurn(sessionId): Promise<TurnReceipt> {
					submitted = true;
					return { sessionId, turnId: "target-turn", accepted: true, started: true, settled: false };
				},
				async waitForTurn(_sessionId, options) {
					const turn: Turn | undefined = submitted
						? { id: "target-turn", status, error: "provider disconnected" }
						: undefined;
					options?.onWait?.(turn);
					options?.onSettled?.(turn);
					return { turn };
				},
			},
		});
		t.after(() => scheduler.stop());
		const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs: 100 });
		const rejected = assert.rejects(waiting, /provider disconnected/);
		await scheduler.enqueueWorkerMessage(f.requestInput);
		const delivery = await scheduler.waitWorkerDelivery(f.request.delivery.deliveryId);
		await rejected;
		assert.equal(delivery.status, "consumed");
		assert.match(delivery.error ?? "", /provider disconnected/);
		assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
	});
}

test("a durable peer result takes priority over a later failure without a duplicate failure reply", async (t) => {
	const f = await fixture(t);
	let submitted = false;
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unused");
			},
			async submitTurn(sessionId): Promise<TurnReceipt> {
				await f.store.updateWorkerDelivery(f.request.delivery.deliveryId, {
					status: "consumed",
					acceptedTurnId: "target-turn",
					consumedAt: Date.now(),
				});
				await f.service.enqueueMessage(f.replyInput());
				submitted = true;
				return { sessionId, turnId: "target-turn", accepted: true, started: true, settled: false };
			},
			async waitForTurn(_sessionId, options) {
				const turn: Turn | undefined = submitted
					? { id: "target-turn", status: "failed", error: "late failure" }
					: undefined;
				options?.onWait?.(turn);
				options?.onSettled?.(turn);
				return { turn };
			},
		},
	});
	t.after(() => scheduler.stop());
	const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync" });
	await scheduler.enqueueWorkerMessage(f.requestInput);
	await scheduler.waitWorkerDelivery(f.request.delivery.deliveryId);
	const result = await waiting;
	assert.deepEqual(
		result.messages.map((message) => message.messageId),
		["response"],
	);
	assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
	await f.store.saveSession(f.completion(result), false, [], {
		workerWait: { waitId: result.wait.waitId, toolCallId: result.wait.toolCallId, responses: result.receipts! },
	});
	assert.deepEqual(await f.store.listWorkerInputs(f.context.sessionId), []);
});

for (const cancel of [false, true]) {
	test(`a result arriving while sync wait reads a failed delivery is ${cancel ? "released on abort" : "claimed before deciding failure"}`, async (t) => {
		const f = await fixture(t);
		await f.store.updateWorkerDelivery(f.request.delivery.deliveryId, {
			status: "consumed",
			acceptedTurnId: "target-turn",
			error: "confirmed target failure",
		});
		let delivered = false;
		let registrations = 0;
		const controller = new AbortController();
		const scheduler = new WorkerScheduler({
			store: {
				...f.store,
				async registerWorkerWait(context, messageId, waitId, options) {
					const result = await f.store.registerWorkerWait(context, messageId, waitId, options);
					if (++registrations === 2 && cancel) {
						assert.equal(result.wait.status, "ready");
						assert.equal(await f.store.isWorkerDeliveryClaimed("response:delivery"), true);
						controller.abort();
					}
					return result;
				},
				async readWorkerDelivery(id) {
					const delivery = await f.store.readWorkerDelivery(id);
					if (id === f.request.delivery.deliveryId && !delivered) {
						delivered = true;
						await f.service.enqueueMessage(f.replyInput());
					}
					return delivery;
				},
			},
			runtime: {
				async createSession() {
					throw new Error("unused");
				},
				async submitTurn() {
					throw new Error("unused");
				},
				async waitForTurn() {
					throw new Error("unused");
				},
			},
		});
		t.after(() => scheduler.stop());
		const waiting = scheduler.wait(f.context, "request", controller.signal, { mode: "sync" });
		if (cancel) {
			await assert.rejects(waiting, { name: "AbortError" });
			assert.equal(await f.store.isWorkerDeliveryClaimed("response:delivery"), false);
			assert.equal((await f.store.readWorkerDelivery("response:delivery"))?.status, "resolved");
			assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
			return;
		}
		const result = await waiting;
		assert.equal(delivered, true);
		assert.equal(result.wait.status, "ready");
		assert.deepEqual(
			result.messages.map((message) => message.messageId),
			["response"],
		);
		assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
		await f.store.saveSession(f.completion(result), false, [], {
			workerWait: { waitId: result.wait.waitId, toolCallId: result.wait.toolCallId, responses: result.receipts! },
		});
		assert.equal(await f.store.isWorkerDeliveryClaimed("response:delivery"), false);
	});
}

test("ordinary peer Turn completion does not imply a Worker result or cancel its wait", async (t) => {
	const f = await fixture(t);
	let submitted = false;
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unused");
			},
			async submitTurn(sessionId): Promise<TurnReceipt> {
				submitted = true;
				return { sessionId, turnId: "target-turn", accepted: true, started: true, settled: false };
			},
			async waitForTurn(_sessionId, options) {
				const turn: Turn | undefined = submitted ? { id: "target-turn", status: "completed" } : undefined;
				options?.onWait?.(turn);
				options?.onSettled?.(turn);
				return { turn };
			},
		},
	});
	t.after(() => scheduler.stop());
	const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs: 10 });
	await scheduler.enqueueWorkerMessage(f.requestInput);
	const delivery = await scheduler.waitWorkerDelivery(f.request.delivery.deliveryId);
	assert.equal((await waiting).wait.status, "timed_out");
	assert.equal(delivery.error, undefined);
	assert.equal(await f.store.isWorkerMessageCancelled("request"), false);
});

for (const replacement of [false, true]) {
	test(`a supplement consumed at a model gap reports its exact failed Turn${replacement ? " despite a later Turn" : ""}`, async (t) => {
		const f = await fixture(t);
		let observing = () => {};
		const observed = new Promise<void>((resolve) => {
			observing = resolve;
		});
		let settleTarget = () => {};
		const targetDone = new Promise<void>((resolve) => {
			settleTarget = resolve;
		});
		let settled = false;
		const scheduler = new WorkerScheduler({
			store: f.store,
			runtime: {
				async createSession() {
					throw new Error("unused");
				},
				async submitTurn() {
					throw new Error("consumed supplement must not start another Turn");
				},
				async waitForTurn(_sessionId, options) {
					if (settled && replacement) {
						options?.onWait?.({ id: "later-turn", status: "running" });
						throw new Error("must not wait on a later Turn");
					}
					options?.onWait?.({ id: "target-turn", status: "running" });
					observing();
					await targetDone;
					settled = true;
					const turn: Turn = { id: "target-turn", status: "failed", error: "model gap failure" };
					options?.onSettled?.(turn);
					return { turn: replacement ? { id: "later-turn", status: "running" as const } : turn };
				},
			},
		});
		t.after(() => {
			scheduler.stop();
			settleTarget();
		});
		const waiting = scheduler.wait(f.context, "request", undefined, { mode: "sync", timeoutMs: 100 });
		const rejected = assert.rejects(waiting, /model gap failure/);
		await scheduler.enqueueWorkerMessage(f.requestInput);
		await observed;
		await f.store.updateWorkerDelivery(f.request.delivery.deliveryId, {
			status: "consumed",
			acceptedTurnId: "target-turn",
			consumedAt: Date.now(),
		});
		settleTarget();
		const delivery = await scheduler.waitWorkerDelivery(f.request.delivery.deliveryId);
		await rejected;
		assert.equal(delivery.acceptedTurnId, "target-turn");
		assert.match(delivery.error ?? "", /model gap failure/);
		assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
	});
}

test("consumed receipts allow only an exact Turn's error annotation while preserving input identity", async (t) => {
	const f = await fixture(t);
	const id = f.request.delivery.deliveryId;
	const consumed = await f.store.updateWorkerDelivery(id, {
		status: "consumed",
		acceptedTurnId: "target-turn",
		consumedAt: 100,
	});
	await assert.rejects(
		f.store.updateWorkerDelivery(id, { status: "consumed", acceptedTurnId: "other-turn", error: "wrong" }),
		/其他 Turn/,
	);
	await assert.rejects(
		f.store.updateWorkerDelivery(id, {
			status: "consumed",
			acceptedTurnId: "target-turn",
			sessionId: "other-session",
			error: "wrong",
		}),
		/会话关联/,
	);
	assert.deepEqual(await f.store.updateWorkerDelivery(id, { status: "consumed", error: "no Turn" }), consumed);
	assert.deepEqual(
		await f.store.updateWorkerDelivery(id, { status: "failed", acceptedTurnId: "target-turn", error: "downgrade" }),
		consumed,
	);
	const annotated = await f.store.updateWorkerDelivery(id, {
		status: "consumed",
		acceptedTurnId: "target-turn",
		error: "confirmed failure",
		updatedAt: consumed.updatedAt + 1,
		consumedAt: 999,
	});
	assert.deepEqual(annotated, { ...consumed, error: "confirmed failure", updatedAt: consumed.updatedAt + 1 });
	await f.reopen();
	assert.deepEqual(await f.store.readWorkerDelivery(id), annotated);
});

test("sync abort releases the local wait and preserves the peer Turn", async (t) => {
	const f = await fixture(t);
	const scheduler = new WorkerScheduler({
		store: f.store,
		runtime: {
			async createSession() {
				throw new Error("unused");
			},
			async submitTurn() {
				throw new Error("unused");
			},
			async waitForTurn() {
				return {};
			},
		},
	});
	t.after(() => scheduler.stop());
	const controller = new AbortController();
	const waiting = scheduler.wait(f.context, "request", controller.signal, { mode: "sync" });
	await setImmediate();
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
	assert.equal(await f.store.isWorkerTurnCancelled("target-session", "target-turn"), false);
	assert.equal((await f.store.readSession("target-session"))?.turn?.status, "running");
});

test("sync wait rejects the current Session and leaves async self-messaging supported", async (t) => {
	const f = await fixture(t);
	await f.service.enqueueMessage({
		messageId: "self-request",
		workerId: "source",
		sourceWorkerId: "source",
		sourceSessionId: "source-session",
		sourceTurnId: "source-turn",
		targetSessionId: "source-session",
		content: "self",
	});
	await assert.rejects(
		f.store.registerWorkerWait(f.context, "self-request", "wait", { mode: "sync" }),
		/当前 Session/,
	);
	assert.equal((await f.store.registerWorkerWait(f.context, "self-request", "async-wait")).wait.status, "waiting");
});

test("restart preserves an uncommitted sync reply without consuming or replaying it", async (t) => {
	const f = await fixture(t);
	const reply = await f.service.enqueueMessage(f.replyInput());
	await f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" });
	await f.reopen();
	assert.equal((await f.store.readSession(f.context.sessionId))?.turn?.status, "failed");
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
	assert.equal(await f.store.isWorkerDeliveryClaimed(reply.delivery.deliveryId), true);
	assert.deepEqual(await f.store.listWorkerInputs(f.context.sessionId), []);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
});

for (const status of ["paused", "stopped"] as const) {
	test(`sync claim respects the source Worker being ${status}`, async (t) => {
		const f = await fixture(t);
		const reply = await f.service.enqueueMessage(f.replyInput());
		const worker = await f.store.readWorker("source");
		assert(worker);
		await f.store.registerWorker({ ...worker, status });
		await assert.rejects(f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" }), /暂停|停止/);
		assert.equal(await f.store.isWorkerDeliveryClaimed(reply.delivery.deliveryId), false);
		assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
	});
}

test("sync claim excludes queued replies behind the cancellation cutoff", async (t) => {
	const f = await fixture(t);
	const reply = await f.service.enqueueMessage(f.replyInput());
	await f.store.recordWorkerTurnCutoff(f.context.sessionId, "prior-turn", f.context.workerId, reply.message.sequence);
	const waiting = await f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" });
	assert.equal(waiting.wait.status, "waiting");
	assert.equal(waiting.receipts, undefined);
	assert.equal(await f.store.isWorkerDeliveryClaimed(reply.delivery.deliveryId), false);
});

test("an ancestor request and its later reply cannot claim the same final response twice", async (t) => {
	const f = await fixture(t);
	await f.service.enqueueMessage(f.replyInput("question", "question"));
	const question = await f.store.registerWorkerWait(f.context, "request", "question-wait", { mode: "sync" });
	await f.store.saveSession(f.completion(question), false, [], {
		workerWait: { waitId: question.wait.waitId, toolCallId: question.wait.toolCallId, responses: question.receipts! },
	});
	await f.service.enqueueMessage({
		messageId: "answer",
		workerId: "target",
		sourceWorkerId: "source",
		sourceSessionId: "source-session",
		sourceTurnId: "source-turn",
		replyTo: "question",
		kind: "reply",
		content: "answer",
	});
	await f.service.enqueueMessage({ ...f.replyInput("result", "final"), replyTo: "answer" });
	const laterContext = { ...f.context, toolCallId: "final-wait" };
	const final = await f.store.registerWorkerWait(laterContext, "request", "final-wait", { mode: "sync" });
	assert.deepEqual(
		final.messages.map((message) => message.messageId),
		["final"],
	);
	await f.store.saveSession(f.completion(final), false, [], {
		workerWait: { waitId: final.wait.waitId, toolCallId: final.wait.toolCallId, responses: final.receipts! },
	});
	for (const mode of ["async", "sync"] as const) {
		const waiting = await f.store.registerWorkerWait(
			{ ...f.context, toolCallId: `answer-${mode}` },
			"answer",
			`answer-${mode}`,
			{ mode },
		);
		assert.equal(waiting.wait.status, "waiting");
		assert.deepEqual(waiting.messages, []);
	}
});

test("explicit Session deletion releases its sync claims while retaining failed receipts", async (t) => {
	const f = await fixture(t);
	const reply = await f.service.enqueueMessage(f.replyInput());
	await f.store.registerWorkerWait(f.context, "request", "wait", { mode: "sync" });
	await f.store.deleteSession(f.context.sessionId);
	assert.equal(await f.store.isWorkerDeliveryClaimed(reply.delivery.deliveryId), false);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "failed");
});
