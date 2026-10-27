import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { applySessionEvent, prependHistoryPage } from "@pie/runtime/session-events";

const snapshot: SessionSnapshot = {
	id: "session",
	instanceId: "instance",
	revision: 1,
	kind: "root",
	assistantId: "assistant",
	runtimeSource: "host",
	title: "Test",
	mode: "faux",
	model: "faux",
	createdAt: 0,
	updatedAt: 0,
	messages: [{ role: "user", content: "history", timestamp: 1 }],
	interactions: [],
	execution: { modelStreaming: false, activeTools: [], waitingForInteraction: false, cancellationRequested: false },
	history: { leafId: "leaf", nextBeforeSeq: 5 },
};
const packet = (revision: number, event?: SessionEvent["event"]): SessionEvent => ({
	type: "agent.event",
	sessionId: "session",
	instanceId: "instance",
	revision,
	turn: { id: "turn", status: "running" },
	event,
});

test("session deltas reconstruct text, thinking, tool arguments and completed messages without duplicating history", () => {
	let current = snapshot;
	const apply = (event: SessionEvent["event"]) => {
		const next = applySessionEvent(current, packet(current.revision + 1, event));
		assert(next);
		current = next;
	};
	apply({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } });
	for (const update of [
		{ type: "thinking_start", contentIndex: 0 },
		{ type: "thinking_delta", contentIndex: 0, delta: "plan" },
		{ type: "text_start", contentIndex: 1 },
		{ type: "text_delta", contentIndex: 1, delta: "hello" },
		{
			type: "toolcall_start",
			contentIndex: 2,
			toolCall: { type: "toolCall", id: "call", name: "echo", arguments: {} },
		},
		{ type: "toolcall_delta", contentIndex: 2, delta: '{"value":1}' },
	])
		apply({ type: "message_update", assistantMessageEvent: update });
	assert.match(JSON.stringify(current.streamingMessage), /plan/);
	assert.match(JSON.stringify(current.streamingMessage), /hello/);
	assert.equal(current.messages.length, 1);
	const message = { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop", timestamp: 2 };
	apply({ type: "message_end", message });
	apply({ type: "message_end", message });
	assert.equal(current.messages.length, 2);
	assert.equal(current.streamingMessage, undefined);
	assert.equal(snapshot.messages.length, 1);
	assert.equal(applySessionEvent(current, packet(current.revision)), current);
});

test("event gaps, process changes and branch resets require a fresh bounded snapshot", () => {
	assert.equal(applySessionEvent(snapshot, packet(3)), undefined);
	assert.equal(applySessionEvent(snapshot, { ...packet(2), instanceId: "new" }), undefined);
	assert.equal(applySessionEvent(snapshot, packet(2, { type: "history.reset" })), undefined);
	assert.equal(applySessionEvent(snapshot, { ...packet(0), snapshot: { ...snapshot, revision: 0 } }), snapshot);
	assert.equal(applySessionEvent(snapshot, { ...packet(2), snapshot: { ...snapshot, revision: 2 } })?.revision, 2);
});

test("older pages retain concurrent live messages and reject another branch or process", () => {
	const page = {
		instanceId: "instance",
		revision: 1,
		leafId: "leaf",
		nextBeforeSeq: null,
		entries: [
			{ id: "old", parentId: null, seq: 1, message: { role: "user" as const, content: "older", timestamp: 0 } },
			{ id: "known", parentId: "old", seq: 2, message: snapshot.messages[0] },
		],
	};
	assert.equal(prependHistoryPage(snapshot, page, 5).messages.length, 2);
	assert.equal(prependHistoryPage(snapshot, { ...page, leafId: "other" }, 5), snapshot);
	assert.equal(prependHistoryPage(snapshot, { ...page, instanceId: "other" }, 5), snapshot);
	const reconnected = { ...snapshot, history: { leafId: "leaf", nextBeforeSeq: 10 } };
	assert.equal(prependHistoryPage(reconnected, page, 5), reconnected);
});

test("execution deltas preserve orthogonal work and every native Turn outcome", () => {
	const execution = {
		modelStreaming: true,
		activeTools: [{ toolCallId: "call", toolName: "remote" }],
		waitingForInteraction: true,
		cancellationRequested: true,
	};
	const running = applySessionEvent(snapshot, { ...packet(2), execution });
	assert(running);
	assert.deepEqual(running.execution, execution);
	assert.deepEqual(snapshot.execution.activeTools, []);
	assert.equal(applySessionEvent(running, packet(3))?.execution, execution);
	for (const status of ["interrupted", "completed", "cancelled", "failed"] as const) {
		const settled = applySessionEvent(running, {
			...packet(3),
			type: "turn.settled",
			turn: { id: "turn", status },
			execution: {
				...snapshot.execution,
				...(status === "interrupted" ? { recoveryBlockedReason: "unknown tool outcome" } : {}),
			},
		});
		assert.equal(settled?.turn?.status, status);
		assert.equal(settled?.execution.modelStreaming, false);
		assert.deepEqual(settled?.execution.activeTools, []);
		assert.equal(settled?.execution.cancellationRequested, false);
		assert.equal(
			settled?.execution.recoveryBlockedReason,
			status === "interrupted" ? "unknown tool outcome" : undefined,
		);
	}
	assert.equal(applySessionEvent(running, { ...packet(1), execution: snapshot.execution }), running);
	assert.equal(applySessionEvent(running, { ...packet(4), execution: snapshot.execution }), undefined);
	assert.equal(applySessionEvent(running, { ...packet(3), instanceId: "restarted" }), undefined);
	const reconnected = { ...snapshot, instanceId: "restarted", revision: 0 };
	assert.equal(
		applySessionEvent(running, { ...packet(0), instanceId: "restarted", snapshot: reconnected }),
		reconnected,
	);
});
