import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createSqliteRuntimeStore, openStore } from "@pie/local/store";
import { WorkerCoordinationService } from "@pie/runtime/coordination";
import type { WorkerCallContext, WorkerSendInput } from "@pie/runtime/worker-communication";
import { WorkerScheduler, type WorkerSchedulerRuntime } from "@pie/runtime/worker-scheduler";

type SourceControl = "active" | "paused" | "worker" | "assignment" | "stop-requested" | "work" | "configuration";

function definitions(workerIds: string[]) {
	return workerIds.map((assistantId) => ({
		assistantId,
		assistantRevision: "1",
		runtime: { systemPrompt: "Do work.", toolIds: [], skills: [], subagents: [] },
	}));
}

function outgoingId(context: WorkerCallContext) {
	return `worker-message:${createHash("sha256")
		.update(JSON.stringify([context.sessionId, context.turnId, context.toolCallId]))
		.digest("hex")}`;
}

async function fixture(t: TestContext, control: SourceControl = "active") {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-source-control-"));
	const local = openStore({ PI_DATA_DIR: directory });
	const storage = createSqliteRuntimeStore(local);
	const execution = { creations: 0, submissions: 0 };
	const runtime: WorkerSchedulerRuntime = {
		async createSession() {
			execution.creations++;
			return { id: "unexpected-session" };
		},
		async submitTurn(sessionId) {
			execution.submissions++;
			return { sessionId, turnId: "unexpected-turn", accepted: true, started: true, settled: false };
		},
		async waitForTurn() {
			return {};
		},
	};
	const scheduler = new WorkerScheduler({ store: storage, runtime });
	const coordination = new WorkerCoordinationService(storage);
	t.after(async () => {
		scheduler.stop();
		await scheduler.drain();
		await storage.close();
		await rm(directory, { recursive: true, force: true });
	});
	await scheduler.syncHostRuntimes(definitions(["source", "target"]));
	for (const workerId of ["source", "target"]) {
		await coordination.createWorkItem({
			workId: `${workerId}-work`,
			title: `${workerId} work`,
			status: workerId === "source" && control === "work" ? "stopped" : "active",
		});
		await coordination.createAssignment({
			assignmentId: `${workerId}-assignment`,
			workerId,
			workId: `${workerId}-work`,
			sessionId: `${workerId}-session`,
			status: workerId === "source" && control === "assignment" ? "stopped" : "active",
			stopRequested: workerId === "source" && control === "stop-requested",
		});
		const worker = await storage.readWorker(workerId);
		assert(worker);
		await storage.registerWorker({
			...worker,
			status: workerId === "target" || control === "paused" ? "paused" : control === "worker" ? "stopped" : "active",
		});
	}
	// A completed incoming request makes a causal reply legal without proactive authorization.
	await storage.createWorkerMessage({
		messageId: "incoming-request",
		workerId: "source",
		sourceWorkerId: "target",
		sourceSessionId: "target-session",
		workId: "source-work",
		targetSessionId: "source-session",
		kind: "request",
		content: "请回复本请求",
		sequence: 1,
		status: "dispatched",
		createdAt: 1,
	});
	await storage.createWorkerDelivery({
		deliveryId: "incoming-request:delivery",
		messageId: "incoming-request",
		workerId: "source",
		assignmentId: "source-assignment",
		sessionId: "source-session",
		status: "consumed",
		createdAt: 1,
		updatedAt: 1,
	});
	if (control === "configuration") await scheduler.syncHostRuntimes(definitions(["target"]));
	const context: WorkerCallContext = {
		workerId: "source",
		sessionId: "source-session",
		turnId: "source-turn",
		toolCallId: "send",
		targets: [{ assistantId: "target", name: "Target", description: "Other work" }],
		mode: "faux",
	};
	return { local, storage, scheduler, context, execution };
}

function input(reply: boolean): WorkerSendInput {
	return reply
		? { to: "target", kind: "result", reply_to: "incoming-request", content: "结果" }
		: { to: "target", session_id: "target-session", content: "新的跨工作请求" };
}

for (const control of ["worker", "assignment", "stop-requested", "work", "configuration"] as const) {
	for (const reply of [false, true]) {
		test(`Source ${control} rejects new ${reply ? "causal replies" : "requests"} without message or execution facts`, async (t) => {
			const f = await fixture(t, control);
			await assert.rejects(
				f.scheduler.send({ ...f.context, targets: reply ? [] : f.context.targets }, input(reply)),
				{
					status: 409,
				},
			);
			await f.scheduler.drain();
			const messageId = outgoingId(f.context);
			if (control !== "configuration") {
				await assert.rejects(
					f.storage.createWorkerMessage({
						messageId,
						workerId: "target",
						sourceWorkerId: "source",
						sourceSessionId: f.context.sessionId,
						sourceTurnId: f.context.turnId,
						workId: reply ? "source-work" : "target-work",
						targetSessionId: "target-session",
						...(reply ? { replyTo: "incoming-request" } : {}),
						kind: reply ? "result" : "request",
						content: "直接入库也不能绕过来源停止",
						sequence: 1,
						status: "queued",
						createdAt: 1,
					}),
					{ status: 409 },
				);
			}
			assert.equal(await f.storage.readWorkerMessage(messageId), undefined);
			assert.equal(await f.storage.readWorkerDelivery(`${messageId}:delivery`), undefined);
			assert.deepEqual(f.execution, { creations: 0, submissions: 0 });
		});
	}
}

for (const reply of [false, true]) {
	test(`Paused source can send ${reply ? "a causal reply" : "a request"}, and stopped retries preserve the saved receipt`, async (t) => {
		const f = await fixture(t, "paused");
		const context = { ...f.context, targets: reply ? [] : f.context.targets };
		const message = input(reply);
		const sent = await f.scheduler.send(context, message);
		await f.scheduler.drain();
		const worker = await f.storage.readWorker("source");
		assert(worker);
		await f.storage.registerWorker({ ...worker, status: "stopped" });
		await f.scheduler.syncHostRuntimes(definitions(["target"]));
		assert.deepEqual(await f.scheduler.send(context, message), sent);
		assert.deepEqual(await f.storage.createWorkerMessage(sent.message), sent.message);
		await assert.rejects(f.scheduler.send(context, { ...message, content: "changed identity" }), { status: 409 });
		assert.deepEqual(f.execution, { creations: 0, submissions: 0 });
	});

	test(`SQLite rejects a ${reply ? "causal reply" : "request"} when source stops after async preflight`, async (t) => {
		const f = await fixture(t);
		const createMessage = f.local.createWorkerMessage;
		let insertAttempts = 0;
		f.local.createWorkerMessage = async (message) => {
			insertAttempts++;
			const worker = await f.storage.readWorker("source");
			assert.equal(worker?.status, "active");
			assert(worker);
			await f.storage.registerWorker({ ...worker, status: "stopped" });
			return createMessage(message);
		};
		await assert.rejects(f.scheduler.send(f.context, input(reply)), { status: 409, message: "来源 Worker 已停止" });
		assert.equal(insertAttempts, 1, "source changes only at the actual SQLite insertion boundary");
		const messageId = outgoingId(f.context);
		assert.equal(await f.storage.readWorkerMessage(messageId), undefined);
		assert.equal(await f.storage.readWorkerDelivery(`${messageId}:delivery`), undefined);
		assert.deepEqual(f.execution, { creations: 0, submissions: 0 });
	});
}

test("Source configuration is checked again after waiting in the inbox queue", async (t) => {
	const f = await fixture(t);
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const createMessage = f.local.createWorkerMessage;
	f.local.createWorkerMessage = async (message) => {
		if (message.messageId === "blocker") {
			markStarted();
			await blocked;
		}
		return createMessage(message);
	};
	const blocker = f.scheduler.enqueueWorkerMessage({
		messageId: "blocker",
		workerId: "target",
		sourceWorkerId: "target",
		content: "占用收件短队列",
	});
	await started;
	const sending = f.scheduler.send(f.context, input(false));
	const rejected = assert.rejects(sending, { status: 409, message: "来源 Worker 的助手配置已移除" });
	await f.scheduler.syncHostRuntimes(definitions(["target"]));
	release();
	await Promise.all([blocker, rejected]);
	const messageId = outgoingId(f.context);
	assert.equal(await f.storage.readWorkerMessage(messageId), undefined);
	assert.equal(await f.storage.readWorkerDelivery(`${messageId}:delivery`), undefined);
	assert.deepEqual(f.execution, { creations: 0, submissions: 0 });
});

test("A stopped target can still generate a system failure receipt", async (t) => {
	const f = await fixture(t, "paused");
	const target = await f.storage.readWorker("target");
	assert(target);
	await f.storage.registerWorker({ ...target, status: "stopped" });
	const sent = await f.scheduler.send(f.context, input(false));
	assert.equal((await f.scheduler.waitWorkerDelivery(sent.delivery.deliveryId)).status, "failed");
	await f.scheduler.drain();
	const failureId = `worker-failure:${createHash("sha256").update(sent.message.messageId).digest("hex")}`;
	const failure = await f.storage.readWorkerMessage(failureId);
	assert.equal(failure?.kind, "result");
	assert.equal(failure?.sourceWorkerId, "target");
	assert.equal(failure?.sourceTurnId, undefined);
	assert.equal(failure?.replyTo, sent.message.messageId);
	assert.match(failure?.content ?? "", /Worker 消息未执行.*目标 Worker 已停止/);
	assert.deepEqual(f.execution, { creations: 0, submissions: 0 });
});
