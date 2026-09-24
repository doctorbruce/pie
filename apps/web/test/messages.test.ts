import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot, WireMessage } from "@pie/server/protocol";
import { toThreadMessages } from "../client/messages.ts";

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
