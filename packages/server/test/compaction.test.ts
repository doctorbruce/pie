import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createCompactionTransform } from "../src/compaction.ts";
import type { ContextCompaction } from "../src/protocol.ts";

function conversation(turns: number, offset = 0): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = offset; index < offset + turns; index++) {
		messages.push({
			role: "user",
			content: `user-${index}-${"u".repeat(72)}`,
			timestamp: index * 2,
		});
		messages.push(fauxAssistantMessage(`assistant-${index}-${"a".repeat(72)}`, { timestamp: index * 2 + 1 }));
	}
	return messages;
}

test("compaction keeps the transcript intact and folds later history into the previous checkpoint", async () => {
	const original = conversation(12);
	const summaries: string[] = [];
	const records: ContextCompaction[] = [];
	const transform = createCompactionTransform({
		contextWindow: 220,
		settings: { reserveTokens: 40, keepRecentTokens: 60 },
		summarize: async ({ prompt }) => {
			summaries.push(prompt);
			return `checkpoint-${summaries.length}`;
		},
		onCompacted: (record) => records.push(record),
	});

	const firstContext = await transform(original);
	assert.equal(original.length, 24);
	assert.equal(records[0].generation, 1);
	assert(records[0].firstKeptMessage > 0);
	assert.notEqual(original[records[0].firstKeptMessage].role, "toolResult");
	assert(firstContext.length < original.length);
	assert(firstContext[0].role === "user" && String(firstContext[0].content).includes("checkpoint-1"));
	assert.match(summaries[0], /user-0/);

	const extended = [...original, ...conversation(10, 12)];
	const secondContext = await transform(extended);
	assert.equal(extended.length, 44);
	assert.equal(records[1].generation, 2);
	assert(records[1].firstKeptMessage > records[0].firstKeptMessage);
	assert.match(summaries[1], /<previous-summary>\ncheckpoint-1/);
	assert(secondContext[0].role === "user" && String(secondContext[0].content).includes("checkpoint-2"));
});

test("compaction does not split before a tool result", async () => {
	const messages = conversation(8);
	messages.push({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "r".repeat(400) }],
		isError: false,
		timestamp: 100,
	});
	messages.push({ role: "user", content: "continue", timestamp: 101 });
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 180,
		settings: { reserveTokens: 30, keepRecentTokens: 80 },
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			record = next;
		},
	});

	await transform(messages);
	assert(record);
	assert.notEqual(messages[record.firstKeptMessage].role, "toolResult");
});
