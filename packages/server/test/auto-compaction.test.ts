import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { isContextOverflow } from "../src/compaction/overflow.ts";
import { retryAssistantCall } from "../src/compaction/retry.ts";
import { createCompactionStream, createCompactionTransform, estimateContextTokens } from "../src/compaction.ts";
import { resolveCompactionSettings } from "../src/compaction-settings.ts";
import type { ContextCompaction } from "../src/protocol.ts";

const model = { provider: "local", id: "tiny", contextWindow: 1000, maxTokens: 100 };
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1 };

function history(): AgentMessage[] {
	return [
		{ role: "user", content: `older-${"x".repeat(160)}`, timestamp: 1 },
		fauxAssistantMessage("previous reply", { timestamp: 2 }),
		{
			role: "user",
			content: [
				{ type: "text", text: "current" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp: 3,
		},
	];
}

test("automatic compaction settings cap thresholds at 90% and apply model-specific budgets", () => {
	assert.equal(
		resolveCompactionSettings({}, { ...model, contextWindow: 1048576, maxTokens: 393216 }).compaction.thresholdTokens,
		943718,
	);
	const configured = resolveCompactionSettings(
		{
			compaction: {
				thresholdTokens: 99999,
				modelOverrides: { "local/tiny": { reserveTokens: 200, keepRecentTokens: 80 } },
			},
		},
		model,
	);
	assert.equal(configured.compaction.thresholdTokens, 800);
	assert.equal(configured.compaction.keepRecentTokens, 80);
	assert.equal(resolveCompactionSettings({ compaction: { enabled: false } }, model).compaction.enabled, false);
	assert.throws(() => resolveCompactionSettings({ retry: { maxRetries: -1 } }, model), /maxRetries/);
});

test("usage components are used when a provider omits totalTokens", () => {
	const message = fauxAssistantMessage("ok");
	message.usage = { ...message.usage, input: 50, output: 10, cacheRead: 30, cacheWrite: 5, totalTokens: 0 };
	assert.equal(estimateContextTokens([message]), 95);
});

test("request preflight includes system and tool schemas without mutating the ledger", async () => {
	const messages = history().map((message) =>
		message.role === "user" && Array.isArray(message.content) ? { ...message, content: "current" } : message,
	);
	const original = structuredClone(messages);
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 1000,
		settings: { reserveTokens: 100, keepRecentTokens: 20 },
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			record = next;
		},
	});
	await transform(messages, undefined, {
		systemPrompt: "s".repeat(3300),
		tools: [
			{
				name: "read",
				description: "read",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
	});
	assert(record);
	assert.deepEqual(messages, original);
	assert.equal(record.messageCount, messages.length);
});

test("checkpoint restoration ignores usage captured before compaction and tracks modified paths", async () => {
	const messages = history().map((message) =>
		message.role === "user" && Array.isArray(message.content) ? { ...message, content: "current" } : message,
	);
	const assistant = messages[1];
	assert.equal(assistant.role, "assistant");
	if (assistant.role !== "assistant") throw new Error("missing assistant");
	assistant.usage = { ...assistant.usage, totalTokens: 5000 };
	assistant.content.push({
		type: "toolCall",
		id: "write-1",
		name: "write",
		arguments: { path: "src/exact.ts", content: "updated" },
	});
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 1000,
		settings: { reserveTokens: 100, keepRecentTokens: 1 },
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			record = next;
		},
	});
	await transform(messages);
	assert(record);
	assert.deepEqual(record.details?.modifiedFiles, ["src/exact.ts"]);
	assert(record.summary.includes("src/exact.ts"));
	let called = false;
	const restored = createCompactionTransform({
		contextWindow: 1000,
		initial: record,
		summarize: async () => {
			called = true;
			return "unexpected";
		},
		onCompacted: () => {},
	});
	await restored(messages);
	assert.equal(called, false);
});

test("summary failure or cancellation never persists a checkpoint", async () => {
	const messages = history();
	for (const failure of [new Error("summary failed"), new DOMException("Aborted", "AbortError")]) {
		let persisted = false;
		const events: string[] = [];
		const transform = createCompactionTransform({
			contextWindow: 10000,
			summarize: async () => {
				throw failure;
			},
			onCompacted: () => {
				persisted = true;
			},
			report: (event) => events.push(event.type),
		});
		await assert.rejects(transform(messages, undefined, { force: true }), failure);
		assert.equal(persisted, false);
		assert.deepEqual(events, ["compaction.started", "compaction.finished"]);
	}
});

test("upstream retry distinguishes transient failures from quota exhaustion and aborts backoff", async () => {
	let attempts = 0;
	const success = await retryAssistantCall(
		async () =>
			++attempts < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 terminated" })
				: fauxAssistantMessage("ok"),
		policy,
		undefined,
	);
	assert.equal(attempts, 3);
	assert.equal(success.stopReason, "stop");
	attempts = 0;
	await retryAssistantCall(
		async () => {
			attempts++;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 insufficient_quota" });
		},
		policy,
		undefined,
	);
	assert.equal(attempts, 1);
	const controller = new AbortController();
	const aborted = await retryAssistantCall(
		async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }),
		policy,
		controller.signal,
		{ onRetryScheduled: () => controller.abort() },
	);
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(
		isContextOverflow(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Throttling error: Too many tokens" }),
		),
		false,
	);
});

test("overflow recovery emits only the retried assistant and preserves the current image", async () => {
	const messages = history();
	const requests: AgentMessage[][] = [];
	let records = 0;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		summarize: async () => "checkpoint",
		onCompacted: () => records++,
	});
	const stream = createCompactionStream((_model, context) => {
		requests.push(context.messages);
		const output = createAssistantMessageEventStream();
		const response =
			requests.length === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded" })
				: fauxAssistantMessage("recovered");
		output.push({ type: "start", partial: response });
		output.push(
			response.stopReason === "error"
				? { type: "error", reason: "error", error: response }
				: { type: "done", reason: "stop", message: response },
		);
		return output;
	}, transform);
	const result = await stream(fauxProvider().getModel(), { messages });
	const types: string[] = [];
	for await (const event of result) types.push(event.type);
	assert.deepEqual(types, ["start", "done"]);
	assert.equal((await result.result()).stopReason, "stop");
	assert.equal(records, 1);
	assert.equal(requests.length, 2);
	assert.equal(requests[1].at(-1), messages.at(-1));
	assert.equal(messages.length, 3);
});

test("large trailing tool results retain their assistant call and the current image", async () => {
	const current: AgentMessage = {
		role: "user",
		content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		timestamp: 3,
	};
	const call = fauxAssistantMessage([
		{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "large.txt" } },
	]);
	const messages: AgentMessage[] = [
		{ role: "user", content: "x".repeat(36000), timestamp: 1 },
		fauxAssistantMessage("old reply"),
		current,
		call,
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "r".repeat(400) }],
			isError: false,
			timestamp: 5,
		},
	];
	let record: ContextCompaction | undefined;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		settings: { reserveTokens: 1000, keepRecentTokens: 50 },
		summarize: async () => "checkpoint",
		onCompacted: (next) => {
			record = next;
		},
	});
	const projected = await transform(messages);
	assert.equal(record?.firstKeptMessage, 3);
	assert.equal(record?.turnStartIndex, 2);
	assert.equal(projected[1], current);
	assert.equal(projected[2], call);
	assert.equal(projected[3].role, "toolResult");
	assert.equal(messages.length, 5);
});

test("overflow after visible output is never replayed", async () => {
	let calls = 0;
	let compacted = false;
	const transform = createCompactionTransform({
		contextWindow: 10000,
		summarize: async () => "checkpoint",
		onCompacted: () => {
			compacted = true;
		},
	});
	const stream = createCompactionStream(() => {
		calls++;
		const output = createAssistantMessageEventStream();
		const response = fauxAssistantMessage("partial", {
			stopReason: "error",
			errorMessage: "context_length_exceeded",
		});
		output.push({ type: "start", partial: response });
		output.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: response });
		output.push({ type: "error", reason: "error", error: response });
		return output;
	}, transform);
	const result = await stream(fauxProvider().getModel(), { messages: history() });
	assert.equal((await result.result()).stopReason, "error");
	assert.equal(calls, 1);
	assert.equal(compacted, false);
});

test("empty summaries and oversized current input fail without losing media", async () => {
	for (const summary of ["", "checkpoint"]) {
		let compacted = false;
		const messages = history();
		const transform = createCompactionTransform({
			contextWindow: 1000,
			summarize: async () => summary,
			onCompacted: () => {
				compacted = true;
			},
		});
		await assert.rejects(transform(messages, undefined, { force: true }), summary ? /仍超出预算/ : /摘要为空/);
		assert.equal(compacted, false);
		const current = messages.at(-1);
		assert(
			current?.role === "user" &&
				Array.isArray(current.content) &&
				current.content.some((block) => block.type === "image"),
		);
	}
});

test("zero-output length stops recover once and repeated overflow cannot loop", async () => {
	for (const repeated of [false, true]) {
		let calls = 0;
		let compactions = 0;
		const transform = createCompactionTransform({
			contextWindow: 10000,
			summarize: async () => "checkpoint",
			onCompacted: () => compactions++,
		});
		const stream = createCompactionStream(() => {
			calls++;
			const output = createAssistantMessageEventStream();
			const response =
				calls === 1
					? fauxAssistantMessage("", { stopReason: "length" })
					: repeated
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded" })
						: fauxAssistantMessage("recovered");
			output.push({ type: "start", partial: response });
			output.push(
				response.stopReason === "error"
					? { type: "error", reason: "error", error: response }
					: { type: "done", reason: calls === 1 ? "length" : "stop", message: response },
			);
			return output;
		}, transform);
		const result = await stream(fauxProvider().getModel(), { messages: history() });
		assert.equal((await result.result()).stopReason, repeated ? "error" : "stop");
		assert.equal(calls, 2);
		assert.equal(compactions, 1);
	}
});
