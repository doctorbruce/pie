import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { createSqliteRuntimeStore, openStore } from "@pie/local/store";
import { CoordinationError, WorkerCoordinationService, type WorkerMessageKind } from "@pie/runtime/coordination";
import type { Turn } from "@pie/runtime/protocol";
import type { SavedSession } from "@pie/runtime/runtime-store";
import { syncMessageTree } from "@pie/runtime/session-tree";
import type { WorkerCallContext } from "@pie/runtime/worker-communication";
import { WorkerScheduler } from "@pie/runtime/worker-scheduler";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-communication-"));
	let local = openStore({ PI_DATA_DIR: directory });
	let store = createSqliteRuntimeStore(local);
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const service = new WorkerCoordinationService(store);
	await service.registerWorker({ workerId: "contract", assistantId: "contract" });
	await service.registerWorker({ workerId: "research", assistantId: "research" });
	await service.createWorkItem({ workId: "work", title: "审合同" });
	for (const worker of ["contract", "research"]) {
		await service.createAssignment({
			assignmentId: `${worker}-assignment`,
			workerId: worker,
			workId: "work",
			sessionId: `${worker}-session`,
		});
		local.saveSession({
			id: `${worker}-session`,
			kind: "root",
			assistantId: worker,
			workerId: worker,
			runtimeSource: "host",
			title: worker,
			mode: "faux",
			model: "faux",
			createdAt: 1,
			updatedAt: 1,
			revision: 0,
			messages: [],
			turn: { id: `${worker}-turn`, status: "running" },
		});
	}
	const request = await service.enqueueMessage({
		messageId: "request",
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: "contract-session",
		sourceTurnId: "contract-turn",
		workId: "work",
		targetSessionId: "research-session",
		content: "调研法规",
	});
	assert.equal(request.delivery.status, "resolved");
	const context: WorkerCallContext = {
		workerId: "contract",
		sessionId: "contract-session",
		turnId: "contract-turn",
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
		context,
		request,
		service,
		async reply(messageId = "reply", kind: WorkerMessageKind = "reply") {
			return service.enqueueMessage({
				messageId,
				workerId: "contract",
				sourceWorkerId: "research",
				sourceSessionId: "research-session",
				sourceTurnId: "research-turn",
				replyTo: request.message.messageId,
				kind,
				content: `${kind} 法规结论`,
			});
		},
		inputSession(content = "法规已返回", turnId = context.turnId): SavedSession {
			const saved = local.readSession(context.sessionId)!;
			const tree = local.readPath(saved.id, saved.leafId);
			const messages = [...tree.nodes.map((node) => node.message), { role: "user" as const, content, timestamp: 2 }];
			return {
				...saved,
				messages,
				tree: syncMessageTree(tree, messages),
				turn: { id: turnId, status: "running" },
				revision: saved.revision + 1,
			};
		},
		async reopen(editControl?: (db: DatabaseSync) => void) {
			await store.close();
			if (editControl) {
				const db = new DatabaseSync(join(directory, "agent.sqlite"));
				try {
					editControl(db);
				} finally {
					db.close();
				}
			}
			local = openStore({ PI_DATA_DIR: directory });
			store = createSqliteRuntimeStore(local);
		},
	};
}

function status(expected: number) {
	return (error: unknown) => error instanceof CoordinationError && error.status === expected;
}

test("Worker waits persist, and queued replies become ready only with atomic history consumption", async (t) => {
	const f = await fixture(t);
	const waiting = await f.store.registerWorkerWait(f.context, "request", "wait");
	assert.equal(waiting.wait.status, "waiting");
	assert.deepEqual(waiting.messages, []);
	const progress = await f.reply("progress", "progress");
	const reply = await f.reply();
	assert.deepEqual(
		(await f.store.listWorkerInputs(f.context.sessionId)).map((input) => input.message.messageId),
		["progress", "reply"],
	);
	assert.equal((await f.store.registerWorkerWait(f.context, "request", "wait")).wait.status, "waiting");
	f.local.saveSession(f.inputSession("进度"), false, [], {
		workerInputs: [{ deliveryId: progress.delivery.deliveryId, messageId: progress.message.messageId }],
	});
	assert.equal((await f.store.registerWorkerWait(f.context, "request", "wait")).wait.status, "waiting");
	f.local.saveSession(f.inputSession(), false, [], {
		workerInputs: [{ deliveryId: reply.delivery.deliveryId, messageId: reply.message.messageId }],
	});
	await f.reopen();
	const ready = await f.store.registerWorkerWait(f.context, "request", "wait");
	assert.equal(ready.wait.status, "ready");
	assert.deepEqual(
		ready.messages.map((message) => message.messageId),
		["reply"],
	);
	assert.equal((await f.store.readWorkerMessage("reply"))?.status, "dispatched");
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "consumed");
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 2);
	assert.deepEqual(await f.store.listWorkerInputs(f.context.sessionId), []);
});

test("A consumed reply arriving before wait registration is found without consuming or duplicating history", async (t) => {
	const f = await fixture(t);
	const reply = await f.reply();
	const input = f.inputSession();
	const options = { workerInputs: [{ deliveryId: reply.delivery.deliveryId, messageId: reply.message.messageId }] };
	f.local.saveSession(input, false, [], options);
	const receipt = await f.store.readWorkerDelivery(reply.delivery.deliveryId);
	f.local.saveSession(input, false, [], options);
	assert.deepEqual(await f.store.readWorkerDelivery(reply.delivery.deliveryId), receipt);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
	const ready = await f.store.registerWorkerWait(f.context, "request", "wait");
	assert.equal(ready.wait.status, "ready");
	assert.deepEqual(
		ready.messages.map((message) => message.messageId),
		["reply"],
	);
	assert.deepEqual(await f.store.registerWorkerWait(f.context, "request", "wait"), ready);
	await assert.rejects(
		f.store.registerWorkerWait({ ...f.context, toolCallId: "different" }, "request", "wait"),
		status(409),
	);
	const unchanged = await f.store.updateWorkerDelivery(reply.delivery.deliveryId, {
		status: "accepted",
		acceptedTurnId: f.context.turnId,
		updatedAt: 999,
	});
	assert.deepEqual(unchanged, receipt);
	await assert.rejects(
		f.store.updateWorkerDelivery(reply.delivery.deliveryId, { status: "accepted", acceptedTurnId: "other-turn" }),
		status(409),
	);
	assert.throws(() => f.local.saveSession(f.inputSession("不得接纳", "other-turn"), false, [], options), status(409));
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
});

test("Invalid Worker receipts roll back both the full history and every delivery in the save", async (t) => {
	const f = await fixture(t);
	const reply = await f.reply();
	await f.store.registerWorkerWait(f.context, "request", "wait");
	const before = f.local.readSession(f.context.sessionId);
	assert.throws(
		() =>
			f.local.saveSession(f.inputSession(), false, [], {
				workerInputs: [
					{ deliveryId: reply.delivery.deliveryId, messageId: reply.message.messageId },
					{ deliveryId: "missing", messageId: "missing" },
				],
			}),
		status(404),
	);
	assert.deepEqual(f.local.readSession(f.context.sessionId), before);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
	assert.equal((await f.store.readWorkerMessage("reply"))?.status, "queued");
	assert.equal((await f.store.registerWorkerWait(f.context, "request", "wait")).wait.status, "waiting");
	assert.throws(
		() =>
			f.local.saveSession(f.inputSession(), false, [], {
				workerInputs: [{ deliveryId: f.request.delivery.deliveryId, messageId: f.request.message.messageId }],
			}),
		status(409),
	);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
});

test("Wait ownership and persisted Turn cancellation reject late registration and reply consumption", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.store.registerWorkerWait({ ...f.context, workerId: "research" }, "request", "bad-worker"),
		status(403),
	);
	await assert.rejects(
		f.store.registerWorkerWait({ ...f.context, sessionId: "research-session" }, "request", "bad-session"),
		status(403),
	);
	await assert.rejects(f.store.registerWorkerWait(f.context, "missing", "absent"), status(404));
	await f.store.registerWorkerWait(f.context, "request", "wait");
	const reply = await f.reply();
	await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
	await f.reopen();
	assert.equal(await f.store.isWorkerTurnCancelled(f.context.sessionId, f.context.turnId), true);
	assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
	await assert.rejects(f.store.registerWorkerWait(f.context, "request", "wait"), status(409));
	await assert.rejects(
		f.store.registerWorkerWait({ ...f.context, turnId: "new-turn" }, "request", "new-wait"),
		status(409),
	);
	assert.throws(
		() =>
			f.local.saveSession(f.inputSession("迟到回复", "new-turn"), false, [], {
				workerInputs: [{ deliveryId: reply.delivery.deliveryId, messageId: reply.message.messageId }],
			}),
		status(409),
	);
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
	assert.equal((await f.store.readWorkerDelivery(reply.delivery.deliveryId))?.status, "resolved");
});

test("Cancelling a later Turn's wait persistently cancels the earlier request without cancelling unrelated Turns", async (t) => {
	const f = await fixture(t);
	const later = { ...f.context, turnId: "wait-turn" };
	await f.store.registerWorkerWait(later, "request", "later-wait");
	await f.store.cancelWorkerTurn(later.sessionId, later.turnId);
	await f.reopen();
	assert.equal(await f.store.isWorkerTurnCancelled(f.context.sessionId, f.context.turnId), false);
	assert.equal(await f.store.isWorkerMessageCancelled("request"), true);
	await assert.rejects(
		f.store.registerWorkerWait({ ...later, turnId: "third-turn" }, "request", "third-wait"),
		status(409),
	);
});

test("Cancelling before wait registration survives restart and prevents registration", async (t) => {
	const f = await fixture(t);
	await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
	await f.reopen();
	await assert.rejects(f.store.registerWorkerWait(f.context, "request", "wait"), status(409));
	assert.equal(await f.store.isWorkerTurnCancelled(f.context.sessionId, "other-turn"), false);
});

test("New waits claim responses once, and chained question-answer-result replies resume the original request", async (t) => {
	const f = await fixture(t);
	await f.store.registerWorkerWait(f.context, "request", "question-wait");
	const question = await f.reply("question", "question");
	f.local.saveSession(f.inputSession("补充哪一项？"), false, [], {
		workerInputs: [{ deliveryId: question.delivery.deliveryId, messageId: question.message.messageId }],
	});
	const first = await f.store.registerWorkerWait(f.context, "request", "question-wait");
	assert.equal(first.wait.status, "ready");
	assert.deepEqual(
		first.messages.map((message) => message.messageId),
		["question"],
	);
	const next = { ...f.context, turnId: "answer-turn", toolCallId: "wait-result" };
	assert.equal((await f.store.registerWorkerWait(next, "request", "result-wait")).wait.status, "waiting");
	assert.equal(
		(await f.store.registerWorkerWait({ ...next, toolCallId: "second-wait" }, "request", "later-wait")).wait.status,
		"waiting",
	);
	const answer = await f.service.enqueueMessage({
		messageId: "answer",
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: "contract-session",
		sourceTurnId: next.turnId,
		replyTo: "question",
		kind: "reply",
		content: "补充合同期限",
	});
	const result = await f.service.enqueueMessage({
		messageId: "result",
		workerId: "contract",
		sourceWorkerId: "research",
		sourceSessionId: "research-session",
		sourceTurnId: "research-result-turn",
		replyTo: answer.message.messageId,
		kind: "result",
		content: "最终法规结果",
	});
	f.local.saveSession(f.inputSession("最终结果", next.turnId), false, [], {
		workerInputs: [{ deliveryId: result.delivery.deliveryId, messageId: result.message.messageId }],
	});
	await f.reopen();
	const final = await f.store.registerWorkerWait(next, "request", "result-wait");
	assert.equal(final.wait.status, "ready");
	assert.deepEqual(
		final.messages.map((message) => message.messageId),
		["result"],
	);
	assert.deepEqual(await f.store.registerWorkerWait(f.context, "request", "question-wait"), first);
	assert.equal(
		(await f.store.registerWorkerWait({ ...next, toolCallId: "second-wait" }, "request", "later-wait")).wait.status,
		"waiting",
	);
	await f.store.cancelWorkerTurn(next.sessionId, next.turnId);
	assert.equal(await f.store.isWorkerMessageCancelled("result"), true);
	assert.equal(await f.store.isWorkerMessageCancelled("answer"), true);
});

test("A cancelled source Turn cannot persist a late message or delivery", async (t) => {
	const f = await fixture(t);
	await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
	await assert.rejects(
		f.service.enqueueMessage({
			messageId: "late-request",
			workerId: "research",
			sourceWorkerId: "contract",
			sourceSessionId: f.context.sessionId,
			sourceTurnId: f.context.turnId,
			targetSessionId: "research-session",
			content: "不得迟到派发",
		}),
		status(409),
	);
	assert.equal(await f.store.readWorkerMessage("late-request"), undefined);
	assert.equal(await f.store.readWorkerDelivery("late-request:delivery"), undefined);
	assert.deepEqual(await f.store.createWorkerMessage(f.request.message), f.request.message);
});

test("Only a confirmed failed unassigned request accepts a result without a source Session", async (t) => {
	const f = await fixture(t);
	const request = await f.service.enqueueMessage({
		messageId: "unassigned-request",
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: f.context.sessionId,
		sourceTurnId: f.context.turnId,
		content: "新建工作会话",
	});
	assert.equal(request.delivery.sessionId, undefined);
	const failure = await f.service.enqueueMessage({
		messageId: "failure",
		workerId: "contract",
		sourceWorkerId: "research",
		targetSessionId: f.context.sessionId,
		replyTo: request.message.messageId,
		kind: "result",
		content: "创建 Session 失败",
	});
	f.local.saveSession(f.inputSession("失败回执"), false, [], {
		workerInputs: [{ deliveryId: failure.delivery.deliveryId, messageId: failure.message.messageId }],
	});
	assert.equal(
		(await f.store.registerWorkerWait(f.context, request.message.messageId, "failure-wait")).wait.status,
		"waiting",
	);
	await f.store.updateWorkerDelivery(request.delivery.deliveryId, { status: "failed", error: "创建 Session 失败" });
	const ready = await f.store.registerWorkerWait(f.context, request.message.messageId, "failure-wait");
	assert.equal(ready.wait.status, "ready");
	assert.deepEqual(
		ready.messages.map((message) => message.messageId),
		["failure"],
	);
	await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
	assert.equal(await f.store.isWorkerMessageCancelled("failure"), true);
});

for (const outcome of ["cancelled", "failed", "interrupted", "recovery"] as const) {
	test(`a ${outcome} Turn freezes its queued-input cutoff atomically and never expands it on repeated persistence`, async (t) => {
		const f = await fixture(t);
		const queued = await f.service.enqueueMessage({
			messageId: "queued-before-stop",
			workerId: "contract",
			sourceWorkerId: "research",
			sourceSessionId: "research-session",
			sourceTurnId: "research-turn",
			targetSessionId: f.context.sessionId,
			content: "旧补充",
		});
		if (outcome === "recovery") {
			await f.reopen();
			assert.equal(f.local.readSession(f.context.sessionId)?.turn?.status, "failed");
		} else {
			f.local.saveSession({
				...f.inputSession(),
				messages: [],
				tree: undefined,
				turn: { id: f.context.turnId, status: outcome },
			});
		}
		const terminal = f.local.readSession(f.context.sessionId)!;
		const service = new WorkerCoordinationService(f.store);
		const next = await service.enqueueMessage({
			messageId: "queued-after-stop",
			workerId: "contract",
			sourceWorkerId: "research",
			sourceSessionId: "research-session",
			sourceTurnId: "research-new-turn",
			targetSessionId: f.context.sessionId,
			content: "新请求",
		});
		f.local.saveSession({ ...terminal, messages: [] });
		await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
		await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
		assert.equal(await f.store.readWorkerTurnCutoff(f.context.sessionId), queued.message.sequence);
		await f.reopen();
		assert.equal(await f.store.readWorkerTurnCutoff(f.context.sessionId), queued.message.sequence);
		assert.throws(
			() =>
				f.local.saveSession(f.inputSession("不得接纳旧消息", "new-turn"), false, [], {
					workerInputs: [{ deliveryId: queued.delivery.deliveryId, messageId: queued.message.messageId }],
				}),
			status(409),
		);
		assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
		assert.equal((await f.store.readWorkerDelivery(queued.delivery.deliveryId))?.status, "resolved");
		f.local.saveSession(f.inputSession("接纳新消息", "new-turn"), false, [], {
			workerInputs: [{ deliveryId: next.delivery.deliveryId, messageId: next.message.messageId }],
		});
		assert.equal((await f.store.readWorkerDelivery(next.delivery.deliveryId))?.status, "consumed");
		assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
	});
}

test("a rejected terminal Session write rolls back its Worker cutoff", async (t) => {
	const f = await fixture(t);
	await f.reply();
	assert.throws(
		() =>
			f.local.saveSession({ ...f.inputSession(), turn: { id: f.context.turnId, status: "cancelled" } }, false, [], {
				workerInputs: [{ deliveryId: "missing", messageId: "missing" }],
			}),
		status(404),
	);
	assert.equal(await f.store.readWorkerTurnCutoff(f.context.sessionId), 0);
	assert.equal(f.local.readSession(f.context.sessionId)?.turn?.status, "running");
	assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
});

test("existing cutoff tables migrate without changing the recorded terminal watermark", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-cutoff-migration-"));
	const legacy = new DatabaseSync(join(directory, "agent.sqlite"));
	legacy.exec(`CREATE TABLE worker_turn_cutoffs (
		session_id TEXT NOT NULL, turn_id TEXT NOT NULL, worker_id TEXT NOT NULL, sequence INTEGER NOT NULL,
		PRIMARY KEY (session_id, turn_id));
		INSERT INTO worker_turn_cutoffs VALUES ('session', 'turn', 'worker', 7);`);
	legacy.close();
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	assert.equal(await store.readWorkerTurnCutoff("session"), 7);
	assert.equal(await store.recordWorkerTurnCutoff("session", "turn", "worker", 12), 7);
});

for (const control of ["worker", "paused", "assignment", "stop-requested", "work"] as const) {
	for (const consumed of [false, true]) {
		test(`Atomic Worker consumption respects ${control} after preflight and ${consumed ? "preserves consumed retries" : "rolls back new admission"}`, async (t) => {
			const f = await fixture(t);
			const reply = await f.reply();
			const input = f.inputSession();
			input.turn = { id: f.context.turnId, status: "completed" };
			const options = {
				workerInputs: [{ deliveryId: reply.delivery.deliveryId, messageId: reply.message.messageId }],
			};
			await f.store.registerWorkerWait(f.context, "request", "wait");
			if (consumed) f.local.saveSession(input, false, [], options);
			// Keep both fixture Sessions idle so reopening only changes the requested control fact.
			for (const sessionId of ["contract-session", "research-session"]) {
				const saved = f.local.readSession(sessionId)!;
				const tree = f.local.readPath(sessionId);
				f.local.saveSession({
					...saved,
					messages: tree.nodes.map((node) => node.message),
					tree,
					turn: { id: saved.turn!.id, status: "completed" },
				});
			}
			const before = f.local.readSession(f.context.sessionId);
			const history = f.local.readPath(f.context.sessionId);
			const receipt = await f.store.readWorkerDelivery(reply.delivery.deliveryId);
			const message = await f.store.readWorkerMessage(reply.message.messageId);
			const wait = await f.store.registerWorkerWait(f.context, "request", "wait");
			assert.equal((await f.store.listWorkerInputs(f.context.sessionId)).length, consumed ? 0 : 1);
			await f.reopen((db) => {
				if (control === "worker" || control === "paused") {
					db.prepare(
						"UPDATE workers SET payload = json_set(payload, '$.status', ?) WHERE worker_id = 'contract'",
					).run(control === "paused" ? "paused" : "stopped");
				} else if (control === "work") {
					db.prepare(
						"UPDATE work_items SET payload = json_set(payload, '$.status', 'stopped') WHERE work_id = 'work'",
					).run();
				} else {
					db.prepare(
						control === "assignment"
							? "UPDATE assignments SET payload = json_set(payload, '$.status', 'stopped') WHERE session_id = 'contract-session'"
							: "UPDATE assignments SET payload = json_set(payload, '$.stopRequested', json('true')) WHERE session_id = 'contract-session'",
					).run();
				}
			});
			if (consumed) {
				assert.doesNotThrow(() => f.local.saveSession(input, false, [], options));
			} else {
				assert.throws(() => f.local.saveSession(input, false, [], options), {
					status: 409,
					message:
						control === "work"
							? "目标工作项已停止或不存在"
							: control === "paused"
								? "目标 Worker 已暂停，暂不接纳输入"
								: "目标 Worker 或 Session 已暂停或停止",
				});
			}
			assert.deepEqual(f.local.readSession(f.context.sessionId), before);
			assert.deepEqual(f.local.readPath(f.context.sessionId), history);
			assert.deepEqual(await f.store.readWorkerDelivery(reply.delivery.deliveryId), receipt);
			assert.deepEqual(await f.store.readWorkerMessage(reply.message.messageId), message);
			assert.deepEqual(await f.store.registerWorkerWait(f.context, "request", "wait"), wait);
		});
	}
}

for (const outcome of ["paused", "resumed", "cancelled"] as const) {
	test(`A pause at the actual input commit preserves independent ${outcome} control without busy retry`, async (t) => {
		const f = await fixture(t);
		const source = await f.store.readWorker("research");
		assert(source);
		await f.store.registerWorker({ ...source, status: "paused" });
		let attempts = 0;
		let admitted: Turn | undefined;
		const scheduler = new WorkerScheduler({
			store: f.store,
			runtime: {
				async createSession() {
					assert.fail("the existing target Session must be retained");
				},
				async submitTurn(sessionId, input) {
					attempts++;
					assert.equal(sessionId, f.context.sessionId);
					assert(input.workerDeliveryId);
					const target = await f.store.readWorker("contract");
					assert(target);
					if (attempts === 1) await f.store.registerWorker({ ...target, status: "paused" });
					const saved = f.inputSession("接纳来信", "new-turn");
					try {
						f.local.saveSession(saved, false, [], {
							workerInputs: [{ deliveryId: input.workerDeliveryId, messageId: input.requestId! }],
						});
					} catch (error) {
						if (outcome === "resumed") await f.store.registerWorker({ ...target, status: "active" });
						if (outcome === "cancelled") {
							await f.store.cancelWorkerTurn(f.context.sessionId, f.context.turnId);
							const previous = f.local.readSession(sessionId)!;
							const tree = f.local.readPath(sessionId);
							f.local.saveSession({
								...previous,
								messages: tree.nodes.map((node) => node.message),
								tree,
								turn: { id: f.context.turnId, status: "cancelled" },
							});
						}
						throw error;
					}
					admitted = { id: "new-turn", status: "completed" };
					return { sessionId, turnId: admitted.id, accepted: true, started: true, settled: true };
				},
				async waitForTurn(_sessionId, options) {
					options?.onWait?.(admitted);
					options?.onSettled?.(admitted);
					return { turn: admitted };
				},
			},
		});
		t.after(() => scheduler.stop());
		const request = {
			messageId: "paused-at-commit",
			workerId: "contract",
			sourceWorkerId: "research",
			sourceSessionId: "research-session",
			sourceTurnId: "research-turn",
			targetSessionId: f.context.sessionId,
			content: "暂停前已进入调度",
		};
		const sent = await scheduler.enqueueWorkerMessage(request);
		assert.equal(
			(await scheduler.waitWorkerDelivery(sent.delivery.deliveryId)).status,
			outcome === "cancelled" ? "failed" : "resolved",
		);
		await scheduler.drain();
		assert.equal(attempts, 1, "pause rejection must end this scheduling attempt");
		assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 0);
		assert.equal((await f.store.readWorkerMessage(sent.message.messageId))?.status, "queued");
		const failureId = `worker-failure:${createHash("sha256").update(sent.message.messageId).digest("hex")}`;
		if (outcome === "cancelled") {
			assert.equal((await f.store.readWorkerMessage(failureId))?.kind, "result");
			return;
		}
		assert.equal(await f.store.readWorkerMessage(failureId), undefined);
		const target = await f.store.readWorker("contract");
		assert(target);
		await f.store.registerWorker({ ...target, status: "active" });
		await scheduler.enqueueWorkerMessage(request);
		assert.equal((await scheduler.waitWorkerDelivery(sent.delivery.deliveryId)).status, "consumed");
		await scheduler.drain();
		assert.equal(attempts, 2);
		assert.equal(f.local.readPath(f.context.sessionId).nodes.length, 1);
	});
}
