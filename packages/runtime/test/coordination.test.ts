import assert from "node:assert/strict";
import test from "node:test";
import {
	CoordinationError,
	CoordinationService,
	type CoordinationStore,
	type InputBatch,
	type YieldRecord,
} from "../src/coordination.ts";

function store(): CoordinationStore {
	const batches = new Map<string, InputBatch>();
	const yields = new Map<string, YieldRecord>();
	return {
		async createInputBatch(batch) {
			const existing = batches.get(batch.batchId);
			if (existing) {
				if (existing.requestFingerprint !== batch.requestFingerprint) throw new Error("冲突");
				return existing;
			}
			batches.set(batch.batchId, batch);
			return batch;
		},
		async readInputBatch(batchId) {
			return batches.get(batchId);
		},
		async updateInputBatch(batchId, update) {
			const current = batches.get(batchId);
			if (!current) throw new Error("不存在");
			const next = { ...current, ...update };
			batches.set(batchId, next);
			return next;
		},
		async createYield(record) {
			const existing = yields.get(record.yieldId);
			if (existing) return existing;
			yields.set(record.yieldId, record);
			return record;
		},
		async readYield(yieldId) {
			return yields.get(yieldId);
		},
	};
}

test("input batches are idempotent and only one turn can accept them", async () => {
	const service = new CoordinationService(store());
	const first = await service.createInputBatch({ batchId: "batch-1", sessionId: "session-1", content: "补充资料" });
	const retry = await service.createInputBatch({ batchId: "batch-1", sessionId: "session-1", content: "补充资料" });
	assert.equal(retry.createdAt, first.createdAt);
	await service.acceptInputBatch("batch-1", "turn-1");
	await assert.rejects(service.acceptInputBatch("batch-1", "turn-2"), (error: unknown) => {
		return error instanceof CoordinationError && error.status === 409;
	});
	const consumed = await service.consumeInputBatch("batch-1", "turn-1");
	assert.equal(consumed.status, "consumed");
});

test("yield is a durable structured fact and retry keeps its identity", async () => {
	const service = new CoordinationService(store());
	const record = await service.yieldTurn({
		yieldId: "yield-1",
		sessionId: "session-1",
		turnId: "turn-1",
		reason: "waiting_for_message",
		checkpoint: { inputEntryId: "entry-1", pendingReply: "message-1" },
	});
	const retry = await service.yieldTurn({
		yieldId: "yield-1",
		sessionId: "session-1",
		turnId: "turn-1",
		reason: "waiting_for_message",
		checkpoint: { inputEntryId: "entry-1", pendingReply: "message-1" },
	});
	assert.deepEqual(retry, record);
});
