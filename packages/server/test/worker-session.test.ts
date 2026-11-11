import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { WorkerCoordinationService, type WorkerEnqueueResult } from "@pie/runtime/coordination";
import type { SessionSnapshot } from "@pie/runtime/protocol";
import type { WorkerWaitResult } from "@pie/runtime/worker-communication";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-session-"));
	const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	let store = openStore(env);
	const start = () =>
		createLocalRuntime({
			store,
			agents: createAgentFactory(env),
			plugins: createPlugins(env),
			traceToolStream: false,
		});
	let runtime = await start();
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await runtime.registerHostRuntimes(
		["a", "b"].map((assistantId) => ({
			assistantId,
			assistantRevision: "1",
			runtime: {
				systemPrompt: "Coordinate independently",
				toolIds: [],
				skills: [],
				subagents: [
					{
						id: `peer-${assistantId}`,
						assistantId: assistantId === "a" ? "b" : "a",
						name: "Peer",
						description: "Peer",
					},
				],
			},
		})),
	);
	return {
		directory,
		get store() {
			return store;
		},
		get runtime() {
			return runtime;
		},
		async restart() {
			await runtime.close();
			store = openStore(env);
			runtime = await start();
		},
	};
}

function toolResult(snapshot: SessionSnapshot, name: string) {
	const message = [...snapshot.messages]
		.reverse()
		.find((entry) => entry.role === "toolResult" && entry.toolName === name);
	assert(message?.role === "toolResult");
	assert.equal(message.isError, false, JSON.stringify(message));
	return message;
}

function sentReceipt(snapshot: SessionSnapshot) {
	const details = toolResult(snapshot, "communicate").details as { sent?: WorkerEnqueueResult };
	assert(details.sent);
	return details.sent;
}

test("Explicit Worker creates bind empty product Sessions without changing ordinary creates, including restart retries", async (t) => {
	const f = await fixture(t);
	const body = {
		creationKey: "cowork-product-a",
		assistantId: "a",
		workerId: "a",
		astronSessionId: "product-a",
		title: "合同甲",
		workspacePath: join(f.directory, "contracts"),
		mode: "faux" as const,
	};
	const created = await f.runtime.createSession(body);
	assert.equal(created.workerId, "a");
	assert.deepEqual(created.messages, []);
	assert.equal(created.turn, undefined);
	const assignment = await f.store.findAssignmentBySession(created.id);
	assert(assignment);
	assert.equal(assignment.workerId, "a");
	assert.equal(assignment.workspacePath, body.workspacePath);
	assert.deepEqual(assignment.productBinding, { assistantId: "a", astronSessionId: "product-a" });
	const work = await f.store.readWorkItem(assignment.workId);
	assert.equal(work?.title, "合同甲");
	assert.equal(work?.sourceSessionId, created.id);
	assert.equal((await f.runtime.exportSession(created.id)).source.astronSessionId, "product-a");
	assert.equal((await f.runtime.createSession(body)).id, created.id);
	assert.equal((await f.runtime.createSession({ ...body, creationKey: ` ${body.creationKey} ` })).id, created.id);
	assert.deepEqual(await f.store.findAssignmentBySession(created.id), assignment);
	const ordinary = await f.runtime.createSession({ assistantId: "a", title: "原有普通会话" });
	assert.equal(ordinary.workerId, undefined);
	assert.equal(await f.store.findAssignmentBySession(ordinary.id), undefined);
	assert.equal(ordinary.turn, undefined);
	await f.restart();
	assert.equal((await f.runtime.createSession(body)).id, created.id);
	assert.deepEqual(await f.store.findAssignmentBySession(created.id), assignment);
	assert.deepEqual(await f.store.readWorkItem(assignment.workId), work);
	await assert.rejects(f.runtime.createSession({ ...body, title: "不同参数" }), /creationKey/);
	assert.equal((await f.runtime.listSessions()).sessions.length, 2);
});

test("A retry repairs a Worker association saved only partly before failure without starting a Turn", async (t) => {
	const f = await fixture(t);
	const body = { assistantId: "a", workerId: "a", creationKey: "repairable", title: "待补齐" };
	const createAssignment = f.store.createAssignment.bind(f.store);
	let fail = true;
	f.store.createAssignment = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("assignment save interrupted");
		}
		return createAssignment(...args);
	};
	await assert.rejects(f.runtime.createSession(body), /工作会话关联保存失败/);
	const receipt = f.store.readSessionCreation(body.creationKey);
	assert(receipt);
	assert.equal(await f.store.findAssignmentBySession(receipt.sessionId), undefined);
	assert.equal(f.store.readSession(receipt.sessionId)?.turn, undefined);
	assert.equal(f.store.readTree(receipt.sessionId).nodes.length, 0);
	const workId = `worker-work:${createHash("sha256")
		.update(JSON.stringify([body.workerId, receipt.sessionId]))
		.digest("hex")}`;
	const work = await f.store.readWorkItem(workId);
	assert(work);
	await f.restart();
	const repaired = await f.runtime.createSession(body);
	assert.equal(repaired.id, receipt.sessionId);
	assert.equal(repaired.turn, undefined);
	assert.deepEqual(repaired.messages, []);
	assert.equal((await f.store.findAssignmentBySession(repaired.id))?.workId, workId);
	assert.deepEqual(await f.store.readWorkItem(workId), work);
	assert.equal((await f.runtime.listSessions()).sessions.length, 1);
});

test("Deleting a Worker Session stops its association and queued inputs without destroying other work or uncertain receipts", async (t) => {
	const f = await fixture(t);
	const deleted = await f.runtime.createSession({ assistantId: "a", workerId: "a", creationKey: "deleted-work" });
	const sibling = await f.runtime.createSession({ assistantId: "a", workerId: "a" });
	const peer = await f.runtime.createSession({ assistantId: "b", workerId: "b" });
	const assignment = await f.store.findAssignmentBySession(deleted.id);
	assert(assignment);
	const work = await f.store.readWorkItem(assignment.workId);
	const service = new WorkerCoordinationService(f.store);
	const outgoing = await service.enqueueMessage({
		messageId: "outgoing-before-delete",
		sourceWorkerId: "a",
		sourceSessionId: deleted.id,
		workerId: "b",
		targetSessionId: peer.id,
		content: "核查合同",
	});
	const context = {
		workerId: "a",
		sessionId: deleted.id,
		turnId: "waiting-turn",
		toolCallId: "wait-call",
		targets: [],
		mode: "faux" as const,
	};
	assert.equal(
		(await f.store.registerWorkerWait(context, outgoing.message.messageId, "delete-wait")).wait.status,
		"waiting",
	);
	const incoming = {
		sourceWorkerId: "b",
		workerId: "a",
		workId: assignment.workId,
		content: "补充条款",
	};
	const resolved = await service.enqueueMessage({ ...incoming, messageId: "resolved-before-delete" });
	const uncertain = await service.enqueueMessage({ ...incoming, messageId: "uncertain-before-delete" });
	await f.store.updateWorkerDelivery(uncertain.delivery.deliveryId, { status: "dispatched" });
	const consumed = await service.enqueueMessage({ ...incoming, messageId: "consumed-before-delete" });
	await f.store.updateWorkerDelivery(consumed.delivery.deliveryId, { status: "consumed", acceptedTurnId: "old-turn" });
	const worker = await f.store.readWorker("a");
	assert(worker);
	await f.store.registerWorker({ ...worker, status: "paused" });
	const pending = await Promise.all([
		service.enqueueMessage({ ...incoming, messageId: "pending-work-before-delete" }),
		service.enqueueMessage({ ...incoming, messageId: "pending-target-before-delete", targetSessionId: deleted.id }),
		service.enqueueMessage({
			messageId: "pending-reply-before-delete",
			sourceWorkerId: "b",
			sourceSessionId: peer.id,
			workerId: "a",
			replyTo: outgoing.message.messageId,
			kind: "result",
			content: "核查结果",
		}),
	]);
	assert(pending.every((entry) => entry.delivery.status === "pending"));
	await f.runtime.deleteSession(deleted.id);
	assert.equal(f.store.readSession(deleted.id), undefined);
	const stopped = await f.store.findAssignmentBySession(deleted.id);
	assert.equal(stopped?.status, "stopped");
	assert.equal(stopped?.stopRequested, true);
	assert.deepEqual(await f.store.readWorkItem(assignment.workId), work);
	assert.equal((await f.store.findAssignmentBySession(sibling.id))?.status, "active");
	assert.equal((await f.store.findAssignmentBySession(peer.id))?.status, "active");
	for (const entry of [resolved, ...pending]) {
		const failed = await f.store.readWorkerDelivery(entry.delivery.deliveryId);
		assert.equal(failed?.status, "failed");
		assert.equal(failed?.error, "目标 Session 已删除");
		assert.equal(
			(await f.store.updateWorkerDelivery(entry.delivery.deliveryId, { status: "resolved" })).status,
			"failed",
		);
		assert(await f.store.readWorkerMessage(entry.message.messageId));
	}
	assert.equal((await f.store.readWorkerDelivery(uncertain.delivery.deliveryId))?.status, "dispatched");
	assert.equal((await f.store.readWorkerDelivery(consumed.delivery.deliveryId))?.status, "consumed");
	await assert.rejects(f.store.registerWorkerWait(context, outgoing.message.messageId, "delete-wait"), /请求已取消/);
	await f.restart();
	assert.deepEqual(await f.store.findAssignmentBySession(deleted.id), stopped);
	await assert.rejects(f.store.registerWorkerWait(context, outgoing.message.messageId, "delete-wait"), /请求已取消/);
	await f.store.registerWorker({ ...worker, status: "active" });
	const late = await f.runtime.enqueueWorkerMessage({ ...incoming, messageId: "late-after-delete" });
	const receipt = await f.runtime.waitWorkerDelivery(late.delivery.deliveryId);
	assert.equal(receipt.status, "pending");
	assert.match(receipt.error ?? "", /Session 已停止/);
	assert.equal(receipt.sessionId, deleted.id);
	await assert.rejects(
		f.runtime.createSession({ assistantId: "a", workerId: "a", creationKey: "deleted-work" }),
		/已删除/,
	);
	assert.equal((await f.runtime.listSessions()).sessions.length, 2);
	await f.runtime.submitTurn(sibling.id, { text: "继续审合同乙" });
	assert.equal((await f.runtime.waitForTurn(sibling.id)).turn?.status, "completed");
});

for (const failReportOnce of [false, true])
	test(
		`Deleting a paused target releases its peer's wait${failReportOnce ? " after retrying a failed report" : ""}`,
		{ timeout: 20000 },
		async (t) => {
			const f = await fixture(t);
			const source = await f.runtime.createSession({ assistantId: "a", workerId: "a", mode: "faux" });
			const target = await f.runtime.createSession({ assistantId: "b", workerId: "b", mode: "faux" });
			const worker = await f.store.readWorker("b");
			assert(worker);
			await f.store.registerWorker({ ...worker, status: "paused" });
			await f.runtime.submitTurn(source.id, {
				text: `调用工具 communicate ${JSON.stringify({ to: "b", session_id: target.id, content: "核查合同", wait: false })}`,
			});
			const sent = await f.runtime.waitForTurn(source.id);
			const request = sentReceipt(sent);
			assert.equal((await f.runtime.waitWorkerDelivery(request.delivery.deliveryId)).status, "pending");
			await f.runtime.submitTurn(source.id, {
				text: `调用工具 communicate ${JSON.stringify({ message_id: request.message.messageId })}`,
			});
			const waiting = await f.runtime.waitForTurn(source.id);
			const { wait } = toolResult(waiting, "communicate").details as WorkerWaitResult;
			assert.equal(wait.status, "waiting");
			assert.equal(waiting.execution.waitingForMessage?.messageId, request.message.messageId);
			let reportAttempts = 0;
			let deletedUpdatedAt: number | undefined;
			const reports: string[] = [];
			const createMessage = f.store.createWorkerMessage.bind(f.store);
			f.store.createWorkerMessage = async (message) => {
				if (message.messageId.startsWith("worker-failure:")) {
					reportAttempts++;
					if (failReportOnce && reportAttempts === 1) throw new Error("report write failed once");
					reports.push(message.messageId);
				}
				return createMessage(message);
			};
			if (failReportOnce) {
				await assert.rejects(f.runtime.deleteSession(target.id), {
					status: 503,
					message: "会话已删除，失败回信尚未保存，请重试核对",
				});
				assert.equal(f.store.readSession(target.id), undefined);
				deletedUpdatedAt = (await f.store.findAssignmentBySession(target.id))?.updatedAt;
				await assert.rejects(f.runtime.getSession(target.id), { status: 404 });
				await assert.rejects(f.runtime.submitTurn(target.id, { text: "不得复活" }), { status: 404 });
				await assert.rejects(f.runtime.renameSession(target.id, { title: "不得重建" }), { status: 404 });
				await assert.rejects(f.runtime.deleteSession("missing-session"), { status: 404 });
				assert.equal(f.store.readSession(target.id), undefined);
				assert.equal(
					(await f.runtime.getSession(source.id)).execution.waitingForMessage?.messageId,
					request.message.messageId,
				);
			}
			await f.runtime.deleteSession(target.id);
			if (failReportOnce)
				assert.equal((await f.store.findAssignmentBySession(target.id))?.updatedAt, deletedUpdatedAt);
			assert.equal((await f.store.readWorkerDelivery(request.delivery.deliveryId))?.status, "failed");
			const failureId = `worker-failure:${createHash("sha256").update(request.message.messageId).digest("hex")}`;
			const failure = await f.runtime.waitWorkerDelivery(`${failureId}:delivery`);
			assert.equal(failure.status, "consumed");
			assert.equal(failure.sessionId, source.id);
			const message = await f.runtime.getWorkerMessage(failureId);
			assert.equal(message.kind, "result");
			assert.deepEqual(reports, [failureId]);
			assert.equal(reportAttempts, failReportOnce ? 2 : 1);
			assert.match(message.content, /目标 Session 已删除/);
			assert.equal((await f.runtime.getSession(source.id)).execution.waitingForMessage, undefined);
			const ready = await f.store.registerWorkerWait(
				{ ...wait, targets: [], mode: "faux" },
				request.message.messageId,
				wait.waitId,
			);
			assert.equal(ready.wait.status, "ready");
			assert.deepEqual(
				ready.messages.map((reply) => reply.messageId),
				[failureId],
			);
			assert.equal((await f.runtime.listSessions()).sessions.length, 1);
		},
	);

test("Deleting a paused target does not report to a removed source Session and Worker", async (t) => {
	const f = await fixture(t);
	const sourceAssistant = await f.runtime.saveAssistant({ name: "Source", systemPrompt: "Work", toolIds: [] });
	const source = await f.runtime.createSession({
		assistantId: sourceAssistant.id,
		workerId: sourceAssistant.id,
		mode: "faux",
	});
	const target = await f.runtime.createSession({ assistantId: "b", workerId: "b", mode: "faux" });
	const worker = await f.store.readWorker("b");
	assert(worker);
	await f.store.registerWorker({ ...worker, status: "paused" });
	const queued = await f.runtime.enqueueWorkerMessage({
		messageId: "removed-source-request",
		sourceWorkerId: sourceAssistant.id,
		sourceSessionId: source.id,
		workerId: "b",
		targetSessionId: target.id,
		content: "Work",
	});
	assert.equal((await f.runtime.waitWorkerDelivery(queued.delivery.deliveryId)).status, "pending");
	await f.runtime.deleteSession(source.id);
	await f.runtime.deleteAssistant(sourceAssistant.id);
	assert.equal(await f.store.readWorker(sourceAssistant.id), undefined);
	assert.deepEqual(await f.runtime.deleteSession(target.id), { deleted: true });
	assert.equal((await f.store.readWorkerDelivery(queued.delivery.deliveryId))?.status, "failed");
	const failureId = `worker-failure:${createHash("sha256").update(queued.message.messageId).digest("hex")}`;
	assert.equal(await f.store.readWorkerMessage(failureId), undefined);
});
