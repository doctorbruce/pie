import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type DurableJobReference, recoverInterruptedTurn, type SessionMetadata } from "@pie/runtime";
import { durableJobResult, pendingDurableJobs } from "@pie/runtime/durable-jobs";
import { syncMessageTree } from "@pie/runtime/session-tree";
import { createToolExecutionRecord, validateToolExecutionRecord } from "@pie/runtime/tool-execution";

const reference: DurableJobReference = {
	id: "job",
	sessionId: "session",
	turnId: "turn",
	toolCallId: "call",
	toolName: "remote",
};
const input: AgentMessage = { role: "user", content: "execute", timestamp: 1 };
const call = fauxAssistantMessage([fauxToolCall("remote", { value: "effect" }, { id: "call" })], {
	stopReason: "toolUse",
});

test("job results validate identity, distinguish waiting and unknown, and retain content, media and details", () => {
	assert.equal(durableJobResult(reference, { ...reference, status: "running" }), undefined);
	for (const snapshot of [
		undefined,
		{ ...reference, status: "unknown" as const },
		{ ...reference, status: "completed" as const },
		{ ...reference, turnId: "another", status: "running" as const },
	])
		assert.throws(() => durableJobResult(reference, snapshot));
	const result = durableJobResult(reference, {
		...reference,
		status: "completed",
		result: { content: [{ type: "image", mimeType: "image/png", data: "AA==" }], details: { path: "output.png" } },
	});
	assert.equal(result?.isError, false);
	assert.equal(result?.content[0].type, "image");
	assert.equal(Reflect.get(result!.details!, "path"), "output.png");
	for (const status of ["failed", "cancelled"] as const)
		assert.equal(durableJobResult(reference, { ...reference, status, error: "terminal failure" })?.isError, true);
});

test("execution facts share collision-free identities across modes and validate Turn ownership", () => {
	for (const mode of ["inline", "delegated", "durable"] as const) {
		const started = createToolExecutionRecord({ ...reference, mode, phase: "started" });
		const completed = createToolExecutionRecord({ ...reference, mode, phase: "completed" });
		assert.equal(started.executionId, completed.executionId);
		assert.notEqual(started.id, completed.id);
		assert.equal(started.id, createToolExecutionRecord({ ...reference, mode, phase: "started" }).id);
		validateToolExecutionRecord(started, "session", "turn");
		assert.throws(() => validateToolExecutionRecord(started, "other", "turn"));
		assert.throws(() => validateToolExecutionRecord(started, "session", "other"));
	}
	const first = createToolExecutionRecord({
		...reference,
		turnId: "a:b",
		toolCallId: "c",
		mode: "inline",
		phase: "started",
	});
	const second = createToolExecutionRecord({
		...reference,
		turnId: "a",
		toolCallId: "b:c",
		mode: "inline",
		phase: "started",
	});
	assert.notEqual(first.id, second.id);
	assert.notEqual(first.executionId, createToolExecutionRecord({ ...first, sessionId: "other" }).executionId);
	const intent = createToolExecutionRecord({
		...reference,
		mode: "durable",
		phase: "submission_intent",
		externalId: reference.id,
	});
	validateToolExecutionRecord(intent, "session", "turn");
	assert.throws(() => validateToolExecutionRecord({ ...intent, externalId: undefined }, "session", "turn"));
	assert.throws(() => validateToolExecutionRecord({ ...intent, mode: "inline" }, "session", "turn"));
	assert.throws(() => validateToolExecutionRecord({ ...intent, timestamp: NaN }, "session", "turn"));
});

test("parallel recovery only queries missing results and rejects unknown calls or ambiguous associations", () => {
	const second = { ...reference, id: "job-2", toolCallId: "call-2" };
	const parallel = fauxAssistantMessage(
		[fauxToolCall("remote", {}, { id: "call" }), fauxToolCall("remote", {}, { id: "call-2" })],
		{ stopReason: "toolUse" },
	);
	const result = durableJobResult(reference, {
		...reference,
		status: "completed",
		result: { content: [], details: {} },
	})!;
	assert.deepEqual(pendingDurableJobs("session", "turn", [reference, second], [input, parallel, result]), [second]);
	assert.throws(() => pendingDurableJobs("session", "turn", [reference], [input, parallel, result]));
	for (const jobs of [
		[reference, reference],
		[{ ...reference, sessionId: "another" }],
		[{ ...reference, toolName: "other" }],
	])
		assert.throws(() => pendingDurableJobs("session", "turn", jobs, [input, call]));
	assert.throws(() => pendingDurableJobs("session", "turn", [reference], [input, call, result, result]));
});

test("a durable association makes an unfinished tool call queryable, not implicitly completed or resubmitted", () => {
	const tree = syncMessageTree(undefined, [input, call]);
	const session: SessionMetadata = {
		id: "session",
		kind: "root",
		assistantId: "assistant",
		runtimeSource: "host",
		title: "job",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		leafId: tree.leafId,
		turn: { id: "turn", status: "running" },
		runtime: { systemPrompt: "original", toolIds: ["remote"], skills: [], subagents: [] },
		turnCheckpoint: {
			version: 1,
			turnId: "turn",
			inputEntryId: tree.nodes[0].id,
			systemPrompt: "original",
			jobs: [reference],
		},
	};
	assert.equal(recoverInterruptedTurn(session, tree)?.status, "interrupted");
	session.turnCheckpoint!.jobs = [{ ...reference, turnId: "another" }];
	assert.equal(recoverInterruptedTurn(session, tree)?.status, "failed");
	session.turnCheckpoint!.jobs = [];
	assert.equal(recoverInterruptedTurn(session, tree)?.status, "failed");
});
