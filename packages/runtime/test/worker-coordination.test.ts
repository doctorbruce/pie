import assert from "node:assert/strict";
import test from "node:test";
import {
	type AssignmentRecord,
	CoordinationError,
	WorkerCoordinationService,
	type WorkerCoordinationStore,
	type WorkerDelivery,
	type WorkerMessage,
	type WorkerMessageCreate,
	type WorkerRecord,
	type WorkItem,
} from "../src/coordination.ts";

function workerStore() {
	const workers = new Map<string, WorkerRecord>();
	const workItems = new Map<string, WorkItem>();
	const assignments = new Map<string, AssignmentRecord>();
	const messages = new Map<string, WorkerMessage>();
	const deliveries = new Map<string, WorkerDelivery>();
	const sequences = new Map<string, number>();
	const store: WorkerCoordinationStore = {
		async registerWorker(worker) {
			workers.set(worker.workerId, structuredClone(worker));
			return worker;
		},
		async readWorker(workerId) {
			return workers.get(workerId);
		},
		async listWorkers() {
			return [...workers.values()];
		},
		async createWorkItem(workItem) {
			const saved = workItems.get(workItem.workId);
			if (saved) return saved;
			workItems.set(workItem.workId, structuredClone(workItem));
			return workItem;
		},
		async readWorkItem(workId) {
			return workItems.get(workId);
		},
		async findAssignmentByWork(workId) {
			return [...assignments.values()].filter((assignment) => assignment.workId === workId);
		},
		async findAssignmentBySession(sessionId) {
			return [...assignments.values()].find((assignment) => assignment.sessionId === sessionId);
		},
		async createAssignment(assignment) {
			assignments.set(assignment.assignmentId, structuredClone(assignment));
			return assignment;
		},
		async readWorkerMessage(messageId) {
			return messages.get(messageId);
		},
		async createWorkerMessage(message) {
			messages.set(message.messageId, structuredClone(message));
			return message;
		},
		async createWorkerDelivery(delivery) {
			deliveries.set(delivery.deliveryId, structuredClone(delivery));
			return delivery;
		},
		async readWorkerDelivery(deliveryId) {
			return deliveries.get(deliveryId);
		},
		async updateWorkerDelivery(deliveryId, update) {
			const current = deliveries.get(deliveryId);
			if (!current) throw new Error("投递不存在");
			const next = { ...current, ...update };
			deliveries.set(deliveryId, next);
			return next;
		},
		async nextWorkerSequence(workerId) {
			const sequence = (sequences.get(workerId) ?? 0) + 1;
			sequences.set(workerId, sequence);
			return sequence;
		},
	};
	return { store, workers, workItems, assignments, messages, deliveries, sequences };
}

function isConflict(error: unknown) {
	return error instanceof CoordinationError && error.status === 409;
}

async function setup() {
	const saved = workerStore();
	const service = new WorkerCoordinationService(saved.store);
	await service.registerWorker({ assistantId: "contract" });
	await service.registerWorker({ assistantId: "research" });
	await service.createWorkItem({ workId: "contract-a", title: "审查合同甲" });
	await service.createWorkItem({ workId: "contract-b", title: "审查合同乙" });
	await service.createAssignment({ workId: "contract-a", workerId: "contract", sessionId: "contract-a-session" });
	await service.createAssignment({ workId: "contract-b", workerId: "contract", sessionId: "contract-b-session" });
	await service.createAssignment({ workId: "contract-a", workerId: "research", sessionId: "research-a-session" });
	return { ...saved, service };
}

test("Worker registration refreshes configuration while keeping its identity and creation time", async () => {
	const { store } = workerStore();
	const service = new WorkerCoordinationService(store);
	const first = await service.registerWorker({
		assistantId: "contract",
		assistantRevision: "1",
		defaultWorkspacePath: "/contracts",
		defaultModel: { provider: "faux", id: "model-a" },
		productBinding: { assistantId: "product-assistant" },
		createdAt: 1,
	});
	const refreshed = await service.registerWorker({
		assistantId: "contract",
		assistantRevision: "2",
		defaultWorkspacePath: "/new-contracts",
		defaultModel: { provider: "faux", id: "model-b" },
		status: "paused",
	});
	assert.equal(refreshed.workerId, "contract");
	assert.equal(refreshed.createdAt, first.createdAt);
	assert.equal(refreshed.assistantRevision, "2");
	assert.equal(refreshed.defaultWorkspacePath, "/new-contracts");
	assert.deepEqual(refreshed.defaultModel, { provider: "faux", id: "model-b" });
	assert.equal(refreshed.status, "paused");
	assert.equal(refreshed.productBinding, undefined);
	await assert.rejects(service.registerWorker({ workerId: "contract", assistantId: "other" }), isConflict);
	await assert.rejects(service.registerWorker({ workerId: "another-worker", assistantId: "contract" }), isConflict);
});

test("messages resolve by unique work assignment or an exact target Session", async () => {
	const { service } = await setup();
	const first = await service.enqueueMessage({
		messageId: "supplement-a",
		workerId: "contract",
		sourceWorkerId: "research",
		workId: "contract-a",
		content: "合同甲补充法规",
	});
	assert.equal(first.delivery.status, "resolved");
	assert.equal(first.delivery.sessionId, "contract-a-session");
	const second = await service.enqueueMessage({
		workerId: "contract",
		sourceWorkerId: "research",
		targetSessionId: "contract-b-session",
		content: "合同乙的补充",
	});
	assert.equal(second.delivery.sessionId, "contract-b-session");
	assert.notEqual(second.delivery.sessionId, first.delivery.sessionId);
	await assert.rejects(
		service.enqueueMessage({
			messageId: "wrong-session",
			workerId: "research",
			sourceWorkerId: "contract",
			targetSessionId: "contract-b-session",
			content: "错误归属",
		}),
		isConflict,
	);
	assert.equal(await service.readWorkerMessage("wrong-session"), undefined);
	await assert.rejects(
		service.enqueueMessage({
			workerId: "contract",
			sourceWorkerId: "research",
			workId: "contract-a",
			targetSessionId: "contract-b-session",
			content: "错误工作项",
		}),
		isConflict,
	);
});

test("ambiguous work and explicit new Session requests stay pending without choosing an existing Session", async () => {
	const { service } = await setup();
	await service.createAssignment({ workId: "contract-a", workerId: "contract", sessionId: "contract-a-second" });
	const ambiguous = await service.enqueueMessage({
		workerId: "contract",
		sourceWorkerId: "research",
		workId: "contract-a",
		content: "属于哪份工作上下文？",
	});
	assert.equal(ambiguous.delivery.status, "pending");
	assert.equal(ambiguous.delivery.sessionId, undefined);
	assert.match(ambiguous.delivery.error ?? "", /多个/);
	const fresh = await service.enqueueMessage({
		workerId: "research",
		sourceWorkerId: "contract",
		workId: "contract-a",
		content: "新建另一项检索上下文",
		newSession: true,
		workspacePath: "/research",
		model: { provider: "faux", id: "custom-model" },
		productBinding: { astronSessionId: "product-session" },
		title: "单独检索",
		mode: "faux",
	});
	assert.equal(fresh.delivery.status, "pending");
	assert.equal(fresh.delivery.sessionId, undefined);
	assert.equal(fresh.message.workspacePath, "/research");
	assert.deepEqual(fresh.message.model, { provider: "faux", id: "custom-model" });
	assert.deepEqual(fresh.message.productBinding, { astronSessionId: "product-session" });
	assert.equal(fresh.message.title, "单独检索");
	assert.equal(fresh.message.mode, "faux");
});

test("a new request is stored before its WorkItem or Session exists", async () => {
	const { service, messages, deliveries, workItems } = await setup();
	const saved = await service.enqueueMessage({
		messageId: "new-work-request",
		workerId: "contract",
		sourceWorkerId: "research",
		workId: "contract-c",
		newSession: true,
		content: "审查合同丙",
	});
	assert.equal(messages.size, 1);
	assert.equal(deliveries.size, 1);
	assert.equal(workItems.has("contract-c"), false);
	assert.equal(saved.delivery.status, "pending");
	assert.equal(saved.delivery.sessionId, undefined);
});

test("reply_to follows the original Session across multiple question/reply hops", async () => {
	const { service } = await setup();
	const request = await service.enqueueMessage({
		messageId: "law-request",
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: "contract-a-session",
		workId: "contract-a",
		content: "查法规",
	});
	assert.equal(request.delivery.sessionId, "research-a-session");
	const question = await service.enqueueMessage({
		messageId: "law-question",
		workerId: "contract",
		sourceWorkerId: "research",
		sourceSessionId: "research-a-session",
		kind: "question",
		replyTo: "law-request",
		content: "适用哪个地区？",
	});
	assert.equal(question.delivery.sessionId, "contract-a-session");
	const reply = await service.enqueueMessage({
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: "contract-a-session",
		kind: "reply",
		replyTo: "law-question",
		content: "香港",
	});
	assert.equal(reply.delivery.sessionId, "research-a-session");
	await assert.rejects(
		service.enqueueMessage({
			workerId: "contract",
			sourceWorkerId: "research",
			sourceSessionId: "research-a-session",
			targetSessionId: "contract-b-session",
			replyTo: "law-request",
			kind: "result",
			content: "不应送往合同乙",
		}),
		isConflict,
	);
	await assert.rejects(
		service.enqueueMessage({
			workerId: "research",
			sourceWorkerId: "contract",
			sourceSessionId: "contract-b-session",
			replyTo: "law-question",
			kind: "reply",
			content: "不能从另一工作会话冒充回复",
		}),
		isConflict,
	);
});

test("retries keep original facts and reject changed parameters without allocating another sequence", async () => {
	const { service, messages, deliveries, sequences, store } = await setup();
	const input = {
		messageId: "stable-message",
		workerId: "research",
		sourceWorkerId: "contract",
		sourceSessionId: "contract-a-session",
		workId: "contract-a",
		content: "查法规",
	};
	const first = await service.enqueueMessage(input);
	await service.dispatchDelivery(first.delivery);
	const retry = await service.enqueueMessage(input);
	assert.equal(retry.message.createdAt, first.message.createdAt);
	assert.equal(retry.message.sequence, first.message.sequence);
	assert.equal(retry.delivery.status, "dispatched");
	assert.equal(messages.size, 1);
	assert.equal(deliveries.size, 1);
	assert.equal(sequences.get("research"), 1);
	await assert.rejects(service.enqueueMessage({ ...input, content: "不同内容" }), isConflict);
	await assert.rejects(service.enqueueMessage({ ...input, targetSessionId: "other-session" }), isConflict);
	assert.equal(sequences.get("research"), 1);
	await store.updateWorkerDelivery(first.delivery.deliveryId, { status: "consumed", acceptedTurnId: "turn-a" });
	assert.equal((await service.resolveDelivery(first.delivery)).status, "consumed");
	assert.equal((await service.dispatchDelivery(first.delivery)).status, "consumed");
});

test("retry repairs a missing delivery after the message fact was already saved", async () => {
	const { service, deliveries, messages, sequences } = await setup();
	const input = {
		messageId: "split-write",
		workerId: "research",
		sourceWorkerId: "contract",
		workId: "contract-a",
		content: "查法规",
	};
	const first = await service.enqueueMessage(input);
	// A response can be lost between the two stores without losing the stable message identity.
	deliveries.delete(first.delivery.deliveryId);
	const retried = await service.enqueueMessage(input);
	assert.equal(retried.message.createdAt, first.message.createdAt);
	assert.equal(retried.delivery.deliveryId, first.delivery.deliveryId);
	assert.equal(messages.size, 1);
	assert.equal(deliveries.size, 1);
	assert.equal(sequences.get("research"), 1);
});

test("stopped assignments are observable and are never dispatched by a late message", async () => {
	const { service, assignments } = await setup();
	const assignment = (await service.findAssignmentBySession("research-a-session"))!;
	assignments.set(assignment.assignmentId, { ...assignment, status: "stopped" });
	const late = await service.enqueueMessage({
		workerId: "research",
		sourceWorkerId: "contract",
		workId: "contract-a",
		content: "迟到的补充",
	});
	assert.equal(late.delivery.status, "pending");
	assert.equal(late.delivery.sessionId, "research-a-session");
	assert.match(late.delivery.error ?? "", /已停止/);
	assert.equal((await service.dispatchDelivery(late.delivery)).status, "pending");
});

test("follow-up kinds require an existing reference and cannot request a new Session", async () => {
	const { service } = await setup();
	await assert.rejects(
		service.enqueueMessage({ workerId: "contract", sourceWorkerId: "research", kind: "reply", content: "无关联" }),
		(error: unknown) => error instanceof CoordinationError && error.status === 400,
	);
	await assert.rejects(
		service.enqueueMessage({
			workerId: "contract",
			sourceWorkerId: "research",
			kind: "result",
			newSession: true,
			content: "新建结果会话",
		}),
		(error: unknown) => error instanceof CoordinationError && error.status === 400,
	);
});

test("delivery identity cannot be reused by a different message", async () => {
	const { service, messages } = await setup();
	await service.enqueueMessage({
		messageId: "first-message",
		deliveryId: "fixed-delivery",
		workerId: "research",
		sourceWorkerId: "contract",
		workId: "contract-a",
		content: "第一条请求",
	});
	await assert.rejects(
		service.enqueueMessage({
			messageId: "second-message",
			deliveryId: "fixed-delivery",
			workerId: "research",
			sourceWorkerId: "contract",
			workId: "contract-a",
			content: "第二条请求",
		}),
		isConflict,
	);
	assert.equal(messages.has("second-message"), false);
});

test("untrusted message fields are validated before a message or sequence is persisted", async () => {
	const { service, messages, sequences } = await setup();
	const invalidFields: Record<string, unknown>[] = [
		{ workerId: 1 },
		{ messageId: [] },
		{ sourceSessionId: false },
		{ kind: "bogus" },
		{ mode: "live" },
		{ newSession: "true" },
		{ content: 42 },
		{ content: "x".repeat(16001) },
		{ workspacePath: {} },
		{ model: "model-name" },
		{ model: { provider: "faux", id: 1 } },
		{ productBinding: [] },
		{ status: "consumed" },
		{ sequence: 1 },
		{ createdAt: 1 },
	];
	for (const fields of invalidFields) {
		const input = {
			workerId: "research",
			sourceWorkerId: "contract",
			workId: "contract-a",
			content: "合法正文",
			...fields,
		} as unknown as WorkerMessageCreate;
		await assert.rejects(
			service.enqueueMessage(input),
			(error: unknown) => error instanceof CoordinationError && error.status === 400,
			JSON.stringify(fields),
		);
	}
	assert.equal(messages.size, 0);
	assert.equal(sequences.size, 0);
});

test("a stopped Worker or WorkItem cannot be revived by resolving an already queued message", async () => {
	const { service, store, workItems } = await setup();
	const saved = await service.enqueueMessage({
		workerId: "research",
		sourceWorkerId: "contract",
		workId: "contract-a",
		content: "查法规",
	});
	await service.registerWorker({ assistantId: "research", status: "stopped" });
	assert.equal((await service.dispatchDelivery(saved.delivery)).status, "pending");
	assert.match((await service.readWorkerDelivery(saved.delivery.deliveryId))?.error ?? "", /Worker/);
	await service.registerWorker({ assistantId: "research", status: "active" });
	const work = (await store.readWorkItem("contract-a"))!;
	workItems.set(work.workId, { ...work, status: "stopped" });
	assert.equal((await service.dispatchDelivery(saved.delivery)).status, "pending");
	assert.match((await service.readWorkerDelivery(saved.delivery.deliveryId))?.error ?? "", /工作项已停止/);
});

test("an explicitly new Session stays bound across resolution and dispatch retries", async () => {
	const { service, store } = await setup();
	const received = await service.enqueueMessage({
		workerId: "contract",
		sourceWorkerId: "research",
		workId: "contract-a",
		content: "独立上下文",
		newSession: true,
	});
	assert.equal(received.delivery.status, "pending");
	const assignment = await service.createAssignment({
		workerId: "contract",
		workId: "contract-a",
		sessionId: "new-work-session",
	});
	await store.updateWorkerDelivery(received.delivery.deliveryId, {
		assignmentId: assignment.assignmentId,
		sessionId: assignment.sessionId,
		status: "resolved",
	});
	const resolved = await service.resolveDelivery(received.delivery.deliveryId);
	assert.equal(resolved.status, "resolved");
	assert.equal(resolved.sessionId, assignment.sessionId);
	assert.equal((await service.dispatchDelivery(resolved)).status, "dispatched");
	await store.updateWorkerDelivery(received.delivery.deliveryId, {
		assignmentId: "wrong-assignment",
		status: "resolved",
	});
	await assert.rejects(service.resolveDelivery(received.delivery.deliveryId), isConflict);
});

test("an exact target Session cannot dispatch a stopped WorkItem without an explicit workId", async () => {
	const { service, store, workItems } = await setup();
	const work = (await store.readWorkItem("contract-a"))!;
	workItems.set(work.workId, { ...work, status: "stopped" });
	const received = await service.enqueueMessage({
		workerId: "contract",
		sourceWorkerId: "research",
		targetSessionId: "contract-a-session",
		content: "迟到补充",
	});
	assert.equal(received.delivery.status, "pending");
	assert.match(received.delivery.error ?? "", /工作项已停止/);
	assert.equal((await service.dispatchDelivery(received.delivery)).status, "pending");
});

test("assignment identity rejects changed directory, model, product and creation parameters", async () => {
	const { service } = await setup();
	const input = {
		workerId: "contract",
		workId: "contract-a",
		sessionId: "selected-session",
		workspacePath: "/contracts",
		model: { provider: "faux", id: "selected" },
		productBinding: "product-session",
		creationKey: "stable-create",
	};
	const assignment = await service.createAssignment(input);
	assert.deepEqual(await service.createAssignment(input), assignment);
	for (const change of [
		{ workspacePath: "/other" },
		{ model: { provider: "faux", id: "other" } },
		{ productBinding: "other-session" },
		{ creationKey: "other-create" },
	])
		await assert.rejects(service.createAssignment({ ...input, ...change }), isConflict);
});
