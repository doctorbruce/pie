import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRuntimeStore, openStore } from "@pie/local/store";
import {
	type AssignmentRecord,
	WorkerCoordinationService,
	type WorkerDelivery,
	type WorkerMessage,
	type WorkerRecord,
	type WorkItem,
} from "@pie/runtime/coordination";

test("SQLite Worker facts and independent work sessions survive close and reopen", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-store-"));
	let localStore = openStore({ PI_DATA_DIR: directory });
	let store = createSqliteRuntimeStore(localStore);
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const worker: WorkerRecord = {
		workerId: "contract",
		assistantId: "contract",
		assistantRevision: "7",
		status: "active",
		productBinding: { assistantId: "product-contract" },
		defaultWorkspacePath: "/contracts",
		defaultModel: { provider: "host", id: "host-model" },
		createdAt: 1,
		updatedAt: 1,
	};
	const workA: WorkItem = { workId: "work-a", title: "合同甲", status: "active", createdAt: 2, updatedAt: 2 };
	const workB: WorkItem = { workId: "work-b", title: "合同乙", status: "active", createdAt: 3, updatedAt: 3 };
	const assignmentA: AssignmentRecord = {
		assignmentId: "assignment-a",
		workId: workA.workId,
		workerId: worker.workerId,
		sessionId: "session-a",
		workspacePath: "/contracts/a",
		model: { provider: "host", id: "model-a" },
		productBinding: { sessionId: "product-a" },
		status: "active",
		createdAt: 4,
	};
	const assignmentB: AssignmentRecord = {
		...assignmentA,
		assignmentId: "assignment-b",
		workId: workB.workId,
		sessionId: "session-b",
		workspacePath: "/contracts/b",
		model: { provider: "host", id: "model-b" },
		productBinding: { sessionId: "product-b" },
		createdAt: 5,
	};
	await store.registerWorker(worker);
	await store.createWorkItem(workA);
	await store.createWorkItem(workB);
	await store.createAssignment(assignmentA);
	await store.createAssignment(assignmentB);
	const message: WorkerMessage = {
		messageId: "message-a",
		workerId: worker.workerId,
		sourceWorkerId: "research",
		sourceSessionId: "research-a",
		sourceTurnId: "research-turn",
		workId: workA.workId,
		targetSessionId: assignmentA.sessionId,
		replyTo: "request-a",
		kind: "reply",
		content: "法规补充",
		sequence: await store.nextWorkerSequence(worker.workerId),
		status: "queued",
		createdAt: 6,
	};
	assert.equal(message.sequence, 1);
	await store.createWorkerMessage(message);
	const delivery: WorkerDelivery = {
		deliveryId: "delivery-a",
		messageId: message.messageId,
		workerId: worker.workerId,
		status: "pending",
		createdAt: 6,
		updatedAt: 6,
	};
	await store.createWorkerDelivery(delivery);
	const accepted = await store.updateWorkerDelivery(delivery.deliveryId, {
		assignmentId: assignmentA.assignmentId,
		sessionId: assignmentA.sessionId,
		status: "accepted",
		acceptedTurnId: "turn-a",
		updatedAt: 7,
	});
	assert.equal(await store.nextWorkerSequence(worker.workerId), 2);
	assert.equal(await store.nextWorkerSequence("research"), 1);
	await store.close();
	localStore = openStore({ PI_DATA_DIR: directory });
	store = createSqliteRuntimeStore(localStore);
	assert.deepEqual(await store.listWorkers(), [worker]);
	assert.deepEqual(await store.readWorker(worker.workerId), worker);
	assert.deepEqual(await store.readWorkItem(workA.workId), workA);
	assert.deepEqual(await store.readWorkItem(workB.workId), workB);
	assert.deepEqual(await store.findAssignmentByWork(workA.workId), [assignmentA]);
	assert.deepEqual(await store.findAssignmentByWork(workB.workId), [assignmentB]);
	assert.deepEqual(await store.findAssignmentBySession(assignmentA.sessionId), assignmentA);
	assert.deepEqual(await store.findAssignmentBySession(assignmentB.sessionId), assignmentB);
	assert.deepEqual(await store.readWorkerMessage(message.messageId), message);
	assert.deepEqual(await store.readWorkerDelivery(delivery.deliveryId), accepted);
	assert.equal(await store.nextWorkerSequence(worker.workerId), 3);
	assert.equal(await store.nextWorkerSequence("research"), 2);
	assert.equal(await store.readWorker("missing"), undefined);
	assert.equal(await store.readWorkItem("missing"), undefined);
	assert.equal(await store.findAssignmentBySession("missing"), undefined);
	assert.deepEqual(await store.findAssignmentByWork("missing"), []);
	assert.equal(await store.readWorkerMessage("missing"), undefined);
	assert.equal(await store.readWorkerDelivery("missing"), undefined);
});

test("SQLite Worker retries preserve facts and reject conflicting identities", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-store-"));
	const localStore = openStore({ PI_DATA_DIR: directory });
	const store = createSqliteRuntimeStore(localStore);
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const service = new WorkerCoordinationService(store);
	const worker = await service.registerWorker({ assistantId: "contract", status: "active" });
	await service.registerWorker({ assistantId: "router", status: "active" });
	const work = await service.createWorkItem({ workId: "work", title: "合同甲", createdAt: 1, updatedAt: 1 });
	assert.deepEqual(
		await service.createWorkItem({ workId: "work", title: "合同甲", createdAt: 2, updatedAt: 2 }),
		work,
	);
	const assignment = await service.createAssignment({
		assignmentId: "assignment",
		workId: work.workId,
		workerId: worker.workerId,
		sessionId: "session",
	});
	const request = {
		messageId: "message",
		workerId: worker.workerId,
		sourceWorkerId: "router",
		workId: work.workId,
		kind: "request" as const,
		content: "审查合同甲",
	};
	const queued = await service.enqueueMessage(request);
	const retried = await service.enqueueMessage(request);
	assert.deepEqual(retried, queued);
	assert.deepEqual(
		await store.createWorkerMessage({ ...queued.message, createdAt: queued.message.createdAt + 1, sequence: 99 }),
		queued.message,
	);
	assert.equal(queued.delivery.sessionId, assignment.sessionId);
	const consumed = await store.updateWorkerDelivery(queued.delivery.deliveryId, {
		status: "consumed",
		acceptedTurnId: "turn",
		consumedAt: 5,
		updatedAt: 5,
	});
	assert.deepEqual(await store.createWorkerDelivery({ ...queued.delivery, createdAt: 6, updatedAt: 6 }), consumed);
	await assert.rejects(service.enqueueMessage({ ...request, content: "审查另一份合同" }), { status: 409 });
	await assert.rejects(store.createWorkItem({ ...work, title: "另一目标" }), { status: 409 });
	await assert.rejects(store.registerWorker({ ...worker, assistantId: "other" }), { status: 409 });
	await assert.rejects(store.createAssignment({ ...assignment, assignmentId: "other", workId: "another-work" }), {
		status: 409,
	});
	await assert.rejects(store.createWorkerDelivery({ ...queued.delivery, messageId: "other-message" }), {
		status: 409,
	});
	await assert.rejects(store.updateWorkerDelivery("missing", { status: "failed" }), { status: 404 });
	assert.deepEqual(await store.findAssignmentBySession(assignment.sessionId), assignment);
	assert.deepEqual(await store.readWorkerMessage(request.messageId), queued.message);
	assert.deepEqual(await store.readWorkerDelivery(queued.delivery.deliveryId), consumed);
});

test("SQLite Worker sequence allocation is independent, ordered and durable", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-store-"));
	let localStore = openStore({ PI_DATA_DIR: directory });
	t.after(async () => {
		localStore.close();
		await rm(directory, { recursive: true, force: true });
	});
	const sequences = await Promise.all(Array.from({ length: 16 }, () => localStore.nextWorkerSequence("contract")));
	assert.deepEqual(
		sequences,
		Array.from({ length: 16 }, (_, index) => index + 1),
	);
	await localStore.createWorkerMessage({
		messageId: "imported-message",
		workerId: "research",
		sourceWorkerId: "contract",
		kind: "request",
		content: "法规检索",
		sequence: 8,
		status: "queued",
		createdAt: 1,
	});
	await assert.rejects(
		localStore.createWorkerMessage({
			messageId: "collision",
			workerId: "research",
			sourceWorkerId: "contract",
			kind: "request",
			content: "另一检索",
			sequence: 8,
			status: "queued",
			createdAt: 2,
		}),
		{ status: 409 },
	);
	localStore.close();
	localStore = openStore({ PI_DATA_DIR: directory });
	assert.equal(await localStore.nextWorkerSequence("contract"), 17);
	assert.equal(await localStore.nextWorkerSequence("research"), 9);
	assert.equal(await localStore.nextWorkerSequence("research"), 10);
	assert.equal(await localStore.nextWorkerSequence("new-worker"), 1);
});

test("concurrent Worker registration cannot bind two identities to one assistant", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-identity-"));
	const localStore = openStore({ PI_DATA_DIR: directory });
	const store = createSqliteRuntimeStore(localStore);
	t.after(async () => {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const service = new WorkerCoordinationService(store);
	const results = await Promise.allSettled([
		service.registerWorker({ workerId: "worker-a", assistantId: "same-assistant" }),
		service.registerWorker({ workerId: "worker-b", assistantId: "same-assistant" }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert(rejected?.status === "rejected");
	assert.equal(rejected.reason.status, 409);
	assert.equal((await store.listWorkers()).length, 1);
});
