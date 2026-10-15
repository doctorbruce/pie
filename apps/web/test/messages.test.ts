import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionSnapshot, WireMessage } from "@pie/runtime/protocol";
import { toThreadMessages, updateToolProgress } from "../client/messages.ts";

const assistant: WireMessage = {
	role: "assistant",
	timestamp: 1,
	stopReason: "toolUse",
	content: [
		{ type: "thinking", thinking: "先检查工具" },
		{ type: "toolCall", id: "call-1", name: "powershell", arguments: { command: "throw 'test failure'" } },
	],
};
const snapshot: SessionSnapshot = {
	instanceId: "server-1",
	id: "session-1",
	kind: "root",
	assistantId: "assistant-1",
	runtimeSource: "local",
	assistant: {
		id: "assistant-1",
		name: "测试助手",
		systemPrompt: "",
		toolIds: [],
		pluginIds: [],
		subagentIds: [],
		createdAt: 0,
		updatedAt: 0,
	},
	title: "测试会话",
	createdAt: 0,
	updatedAt: 0,
	mode: "real",
	model: "test-model",
	revision: 1,
	messages: [{ role: "user", content: "测试错误", timestamp: 0 }, assistant],
	turn: { id: "turn-1", status: "running" },
	interactions: [],
};

test("tool results join their call and preserve reasoning, errors and stable message ids", () => {
	const before = toThreadMessages(snapshot);
	assert.deepEqual(before[1].status, { type: "running" });
	const after = toThreadMessages({
		...snapshot,
		messages: [
			...snapshot.messages,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "powershell",
				isError: true,
				content: [{ type: "text", text: "test failure" }],
				timestamp: 2,
			},
		],
	});
	assert.equal(after.length, 2);
	assert.equal(after[1].id, before[1].id);
	assert(Array.isArray(after[1].content));
	assert.deepEqual(after[1].content[0], { type: "reasoning", text: "先检查工具" });
	assert.equal(after[1].content[1].result, "test failure");
	assert.equal(after[1].content[1].isError, true);
});

test("partial text retains identity when committed; aborted output stays cancelled", () => {
	const partial: WireMessage = {
		role: "assistant",
		timestamp: 4,
		stopReason: "pending",
		content: [{ type: "text", text: "部分回复" }],
	};
	const streaming = toThreadMessages({ ...snapshot, streamingMessage: partial });
	const finished = toThreadMessages({
		...snapshot,
		messages: [...snapshot.messages, { ...partial, stopReason: "aborted" }],
		turn: { id: "turn-1", status: "cancelled" },
	});
	assert.equal(streaming.at(-1)?.id, finished.at(-1)?.id);
	assert.deepEqual(finished.at(-1)?.status, { type: "incomplete", reason: "cancelled" });
	assert.deepEqual(toThreadMessages(), []);
});

test("tool progress stays UI-only and does not mark a running call as completed", () => {
	const packet: SessionEvent = {
		type: "agent.event",
		sessionId: snapshot.id,
		snapshot,
		event: {
			type: "tool_execution_update",
			toolCallId: "call-1",
			partialResult: { content: [{ type: "text", text: "仍在执行（已等待 60 秒）" }], details: {} },
		},
	};
	const original = structuredClone(snapshot);
	const progress = updateToolProgress(new Map(), packet);
	const messages = toThreadMessages(snapshot, progress);
	assert.deepEqual(messages[1].status, { type: "running" });
	assert(Array.isArray(messages[1].content));
	const call = messages[1].content[1];
	assert.equal(call.type, "tool-call");
	assert.equal(call.result, undefined);
	assert.equal(call.artifact, "仍在执行（已等待 60 秒）");
	assert.deepEqual(snapshot, original);
	const finished = toThreadMessages(
		{
			...snapshot,
			messages: [
				...snapshot.messages,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "powershell",
					isError: false,
					content: [{ type: "text", text: "done" }],
					timestamp: 2,
				},
			],
		},
		progress,
	);
	assert(Array.isArray(finished[1].content));
	assert.equal(finished[1].content[1].artifact, undefined);
	assert.equal(finished[1].content[1].result, "done");
	assert.equal(
		updateToolProgress(progress, { ...packet, event: { type: "tool_execution_end", toolCallId: "call-1" } }).size,
		0,
	);
	const cancelled = { ...snapshot, turn: { id: "turn-1", status: "cancelled" as const } };
	assert.equal(updateToolProgress(progress, { ...packet, snapshot: cancelled }).size, 0);
	const cancelledMessages = toThreadMessages(cancelled, progress);
	assert(Array.isArray(cancelledMessages[1].content));
	assert.equal(cancelledMessages[1].content[1].artifact, undefined);
});

test("progress updates preserve other calls and ignore malformed or unrelated events", () => {
	const progress = new Map([
		["call-1", "first"],
		["call-2", "second"],
	]);
	const packet: SessionEvent = { type: "agent.event", sessionId: snapshot.id, snapshot };
	assert.equal(updateToolProgress(progress, packet), progress);
	for (const partialResult of [null, {}, { content: null }, { content: [null, 42, { type: "text", text: false }] }]) {
		assert.equal(
			updateToolProgress(progress, {
				...packet,
				event: {
					type: "tool_execution_update",
					toolCallId: "call-1",
					partialResult,
				},
			}),
			progress,
		);
	}
	const next = updateToolProgress(progress, {
		...packet,
		event: { type: "tool_execution_start", toolCallId: "call-1" },
	});
	assert.deepEqual([...next], [["call-2", "second"]]);
	assert.equal(progress.get("call-1"), "first");
});
