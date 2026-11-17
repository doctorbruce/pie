import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type CompactionSummaryRequest, createCompactionTransform } from "@pie/runtime/compaction";
import type { ContextCompaction } from "@pie/runtime/protocol";
import { nextCapabilityCatalog } from "../../runtime/src/capability-catalog.ts";

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

test("manual compaction bypasses disabled automatic compaction and retains the latest user input", async () => {
	const messages = conversation(3);
	const original = structuredClone(messages);
	const events: string[] = [];
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async ({ prompt }) => {
			assert.match(prompt, /user-0/);
			assert.match(prompt, /user-2-/);
			return "manual checkpoint";
		},
		onCompacted: (next) => {
			record = next;
		},
		report: (event) => events.push(`${event.type}:${event.reason}`),
	});
	assert.equal(await transform(messages), messages);
	const projected = await transform(messages, undefined, { manual: true });
	assert.equal(record?.firstKeptMessage, 5);
	assert.equal(record?.turnStartIndex, 4);
	assert.deepEqual(projected.slice(1), messages.slice(-2));
	assert.deepEqual(messages, original);
	assert.deepEqual(events, ["compaction.started:manual", "compaction.finished:manual"]);
});

test("manual compaction leaves empty or already minimal history unchanged without a model call", async () => {
	const transform = createCompactionTransform({
		contextWindow: 10000,
		summarize: async () => assert.fail("minimal history must not call the summary model"),
		onCompacted: () => assert.fail("minimal history must not create a checkpoint"),
		report: () => assert.fail("a no-op must not claim to compact history"),
	});
	for (const messages of [[], conversation(1)]) {
		assert.equal(await transform(messages, undefined, { manual: true }), messages);
	}
});

test("manual compaction summarizes a single user's completed tool history while keeping their image and a safe recent suffix", async () => {
	const user: AgentMessage = {
		role: "user",
		content: [{ type: "image", data: "Y3VycmVudA==", mimeType: "image/png" }],
		timestamp: 1,
	};
	const messages: AgentMessage[] = [
		user,
		fauxAssistantMessage([{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "report.txt" } }]),
		{
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			content: [{ type: "text", text: `Saved report.txt ${"completed work ".repeat(100)}` }],
			isError: false,
			timestamp: 3,
		},
		fauxAssistantMessage([{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "final.txt" } }]),
		{
			role: "toolResult",
			toolCallId: "read-2",
			toolName: "read",
			content: [{ type: "text", text: "Recent result" }],
			isError: false,
			timestamp: 5,
		},
		fauxAssistantMessage("Final reply"),
	];
	const original = structuredClone(messages);
	const records: ContextCompaction[] = [];
	const transform = createCompactionTransform({
		contextWindow: 10000,
		supportsImages: true,
		imageBudgetBytes: 1,
		settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		summarize: async (request) => {
			assert.match(request.prompt, /Saved report.txt/);
			assert(!request.prompt.includes("read-2"));
			assert.deepEqual(
				request.images?.map((image) => image.data),
				["Y3VycmVudA=="],
			);
			return "Completed the report write";
		},
		onCompacted: (next) => records.push(next),
	});
	const projected = await transform(messages, undefined, { manual: true });
	assert.equal(records.length, 1);
	assert.equal(records[0].firstKeptMessage, 3);
	assert.equal(records[0].turnStartIndex, 0);
	assert.equal(projected[1], user);
	assert.deepEqual(projected.slice(2), messages.slice(3));
	assert.deepEqual(messages, original);
	assert.equal(await transform(projected, undefined, { manual: true }), projected);
	assert.equal(records.length, 1);
});

test("a capability reminder does not replace the actual Turn input during compaction", async () => {
	const messages = conversation(8);
	const input = { role: "user" as const, content: "CURRENT_USER_INPUT", timestamp: 100 };
	messages.push(input, fauxAssistantMessage("x".repeat(3000)), nextCapabilityCatalog([], "- skill: Summary")!);
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 400,
		settings: { reserveTokens: 40, keepRecentTokens: 20 },
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			record = next;
		},
	});
	const projected = await transform(messages);
	assert.equal(record?.turnStartIndex, 16);
	assert(projected.includes(input));
});

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

test("materialized working windows compact repeatedly without summarizing checkpoint messages", async () => {
	let working = conversation(12);
	const prompts: string[] = [];
	const transform = createCompactionTransform({
		contextWindow: 220,
		settings: { reserveTokens: 40, keepRecentTokens: 60 },
		summarize: async ({ prompt }) => {
			prompts.push(prompt);
			return `checkpoint-${prompts.length}`;
		},
		onCompacted: (_next, _source, projected) => {
			working = projected;
		},
	});
	await transform(working);
	working.push(...conversation(10, 12));
	await transform(working);
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /<previous-summary>\ncheckpoint-1/);
	assert(!prompts[1].includes("<context-checkpoint>"));
	assert(!prompts[1].includes("user-0-"));
	assert(working.length < 10);
});

test("commit failure and cancellation leave the original working history available for retry", async () => {
	const messages = conversation(12);
	const original = structuredClone(messages);
	let fail = true;
	const generations: number[] = [];
	const transform = createCompactionTransform({
		contextWindow: 220,
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			if (fail) throw new Error("checkpoint commit failed");
			generations.push(next.generation);
		},
	});
	await assert.rejects(transform(messages), /commit failed/);
	assert.deepEqual(messages, original);
	fail = false;
	await transform(messages);
	assert.deepEqual(generations, [1]);
	const controller = new AbortController();
	const cancelled = createCompactionTransform({
		contextWindow: 220,
		summarize: async () => {
			controller.abort();
			return "checkpoint";
		},
		onCompacted: () => assert.fail("cancelled checkpoint must not commit"),
	});
	await assert.rejects(cancelled(messages, controller.signal), { name: "AbortError" });
	assert.deepEqual(messages, original);
});

function imageHistory(): AgentMessage[] {
	return [
		{ role: "user", content: [{ type: "image", data: "b2xk", mimeType: "image/png" }], timestamp: 1 },
		fauxAssistantMessage([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "chart.png" } }]),
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [
				{ type: "text", text: `Previously read chart.png successfully${"x".repeat(2100)}` },
				{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "image", data: "cmVjZW50", mimeType: "image/png" }], timestamp: 4 },
		fauxAssistantMessage("previous answer", { timestamp: 5 }),
		{ role: "user", content: [{ type: "image", data: "Y3VycmVudA==", mimeType: "image/png" }], timestamp: 6 },
	];
}

test("vision summaries receive historical user and tool images with their sources", async () => {
	const messages = imageHistory();
	const original = structuredClone(messages);
	let request: CompactionSummaryRequest | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		supportsImages: true,
		imageBudgetBytes: 128,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async (input) => {
			request = input;
			return "checkpoint";
		},
		onCompacted: () => {},
	});
	const projected = await transform(messages, undefined, { force: true });
	assert.deepEqual(
		request?.images?.map((image) => image.data),
		["b2xk", "dG9vbA==", "cmVjZW50"],
	);
	assert.match(request?.prompt ?? "", /Image 1.*user message 1/i);
	assert.match(request?.prompt ?? "", /Image 2.*read.*read-1/i);
	assert.match(request?.prompt ?? "", /Previously read chart.png successfully/);
	assert.match(request?.prompt ?? "", /\[User\]: \[Attached image 1: user message 1, content block 1\]/);
	assert.match(request?.prompt ?? "", /\[Attached image 2: read tool result \(read-1\), content block 2\]/);
	assert.match(request?.prompt ?? "", /\[User\]: \[Attached image 3: user message 4, content block 1\]/);
	assert.deepEqual(messages, original);
	assert.equal(projected.at(-1), messages.at(-1));
});

test("summary image budgets do not protect an old head user when the current user is retained", async () => {
	const messages = imageHistory();
	const original = structuredClone(messages);
	let request: CompactionSummaryRequest | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		supportsImages: true,
		imageBudgetBytes: 1,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async (input) => {
			request = input;
			return "checkpoint";
		},
		onCompacted: () => {},
	});
	const projected = await transform(messages, undefined, { force: true });
	assert.equal(request?.images?.length ?? 0, 0);
	assert.match(request?.prompt ?? "", /Historical image omitted/);
	assert.deepEqual(messages, original);
	assert.equal(projected.at(-1), messages.at(-1));
});

test("every image source remains available when a tool's image markers exceed its summary text limit", async () => {
	const messages = imageHistory();
	const tool = messages[2];
	if (tool.role !== "toolResult") throw new Error("missing tool result");
	tool.content.push(
		...Array.from({ length: 40 }, () => ({ type: "image" as const, data: "aW1n", mimeType: "image/png" })),
	);
	const original = structuredClone(messages);
	let request: CompactionSummaryRequest | undefined;
	const transform = createCompactionTransform({
		contextWindow: 100000,
		supportsImages: true,
		imageBudgetBytes: 8192,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async (input) => {
			request = input;
			return "checkpoint";
		},
		onCompacted: () => {},
	});
	await transform(messages, undefined, { force: true });
	assert.equal(request?.images?.length, 43);
	assert.match(request?.prompt ?? "", /Attached image 42: read tool result \(read-1\), content block 42/);
	assert.match(request?.prompt ?? "", /Attached image 43: user message 4, content block 1/);
	assert.deepEqual(messages, original);
});

test("non-vision summaries retain tool text without resending image pixels", async () => {
	let request: CompactionSummaryRequest | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		supportsImages: false,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async (input) => {
			request = input;
			return "checkpoint";
		},
		onCompacted: () => {},
	});
	await transform(imageHistory(), undefined, { force: true });
	assert.equal(request?.images, undefined);
	assert.match(request?.prompt ?? "", /Previously read chart.png successfully/);
	assert(!request?.prompt.includes("dG9vbA=="));
});

test("forced compaction keeps the only real user's image and summarizes completed work before a synthetic notice", async () => {
	const user: AgentMessage = {
		role: "user",
		content: [{ type: "image", data: "Y3VycmVudA==", mimeType: "image/png" }],
		timestamp: 1,
	};
	const messages: AgentMessage[] = [
		user,
		fauxAssistantMessage([{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "report.txt" } }]),
		{
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			content: [{ type: "text", text: "Wrote the completed analysis to report.txt" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "user",
			content: [Object.assign({ type: "text" as const, text: "background job completed" }, { synthetic: true })],
			timestamp: 4,
		},
	];
	const original = structuredClone(messages);
	let request: CompactionSummaryRequest | undefined;
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		supportsImages: true,
		imageBudgetBytes: 1,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async (input) => {
			request = input;
			return "checkpoint records the completed write";
		},
		onCompacted: (next) => {
			record = next;
		},
	});
	const projected = await transform(messages, undefined, { force: true });
	assert.equal(record?.turnStartIndex, 0);
	assert(projected.includes(user));
	assert.deepEqual(
		request?.images?.map((image) => image.data),
		["Y3VycmVudA=="],
	);
	assert.match(request?.prompt ?? "", /Wrote the completed analysis to report.txt/);
	assert.match(request?.prompt ?? "", /write\(path="report.txt"\)/);
	assert.deepEqual(messages, original);
});

test("compaction budgets exclude omitted historical pixels without replacing checkpoint source or retained history", async () => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 3; index++) {
		messages.push(
			{ role: "user", content: [{ type: "image", data: "b2xk", mimeType: "image/png" }], timestamp: index * 2 },
			fauxAssistantMessage("done", { timestamp: index * 2 + 1 }),
		);
	}
	messages.push({ role: "user", content: "current request", timestamp: 10 });
	const previous = messages[1];
	assert.equal(previous.role, "assistant");
	if (previous.role !== "assistant") throw new Error("missing previous assistant");
	previous.usage = { ...previous.usage, input: 9000, totalTokens: 9000 };
	const original = structuredClone(messages);
	const records: ContextCompaction[] = [];
	const transform = createCompactionTransform({
		contextWindow: 4000,
		supportsImages: true,
		imageBudgetBytes: 1,
		settings: { reserveTokens: 400, keepRecentTokens: 1500 },
		summarize: async () => "checkpoint",
		onCompacted: (next, source) => {
			records.push(next);
			assert.equal(source, messages);
			assert.deepEqual(source, original);
		},
	});
	assert.equal(await transform(messages, undefined, { systemPrompt: "s".repeat(10000) }), messages);
	assert.equal(records.length, 0);
	const projected = await transform(messages, undefined, { force: true, systemPrompt: "s".repeat(10000) });
	assert.equal(records.length, 1);
	assert(records[0].estimatedTokensAfter < 3600);
	assert(
		projected.some(
			(message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
		),
	);
	assert.deepEqual(messages, original);
});
