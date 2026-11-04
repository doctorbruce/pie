import assert from "node:assert/strict";
import test from "node:test";
import {
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { retryDelayMs } from "../src/compaction/retry.ts";
import { resolveCompactionSettings } from "../src/compaction-settings.ts";
import { createRetryStream } from "../src/model-retry.ts";

const model = fauxProvider().getModel();
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1 };

test("ordinary model retries report attempts and their final outcome with one stable identity", async () => {
	let attempts = 0;
	const updates: { retryId: string; status: string; attempt: number; message: string; next?: number }[] = [];
	const stream = createRetryStream(
		() => {
			const output = createAssistantMessageEventStream();
			const message =
				++attempts <= 2
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 status code (no body)" })
					: fauxAssistantMessage("recovered");
			output.push(
				message.stopReason === "error"
					? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message },
			);
			return output;
		},
		policy,
		(update) => updates.push(update),
	);
	assert.equal((await (await stream(model, { messages: [] })).result()).stopReason, "stop");
	assert.deepEqual(
		updates.map(({ status, attempt }) => ({ status, attempt })),
		[
			{ status: "started", attempt: 1 },
			{ status: "started", attempt: 2 },
			{ status: "completed", attempt: 2 },
		],
	);
	assert(updates[0].retryId);
	assert(updates.every((update) => update.retryId === updates[0].retryId));
	assert(updates.slice(0, 2).every((update) => Number.isSafeInteger(update.next)));
});

test("retry exhaustion and cancellation report failure before the terminal model response", async () => {
	for (const cancel of [false, true]) {
		const controller = new AbortController();
		const statuses: string[] = [];
		let attempts = 0;
		const stream = createRetryStream(
			() => {
				attempts++;
				const output = createAssistantMessageEventStream();
				output.push({
					type: "error",
					reason: "error",
					error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }),
				});
				return output;
			},
			{ ...policy, maxRetries: 1 },
			(update) => {
				statuses.push(update.status);
				assert.equal(update.message, "503");
				if (cancel && update.status === "started") controller.abort();
			},
		);
		const output = await stream(model, { messages: [] }, { signal: controller.signal });
		assert.equal((await output.result()).stopReason, cancel ? "aborted" : "error");
		assert.deepEqual(statuses, ["started", "failed"]);
		assert.equal(attempts, cancel ? 1 : 2);
	}
});

test("model retry defaults use five retries with Amio backoff, positive jitter and a 30-second cap", (context) => {
	const { retry } = resolveCompactionSettings({}, model);
	assert.deepEqual(retry, { enabled: true, maxRetries: 5, baseDelayMs: 2000, maxAgentDelayMs: 30000 });
	const random = context.mock.method(Math, "random", () => 0);
	assert.deepEqual(
		[1, 2, 3, 4, 5, 50].map((attempt) => retryDelayMs(retry, attempt)),
		[2000, 4000, 8000, 16000, 30000, 30000],
	);
	random.mock.mockImplementation(() => 0.999);
	assert.equal(retryDelayMs(retry, 1), 2499);
	assert.equal(retryDelayMs(retry, 5), 30000);
});

test("an empty failed attempt is suppressed while retrying the same model context", async () => {
	let attempts = 0;
	const original = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
	const stream = createRetryStream((_model, context, options) => {
		assert.equal(context, original);
		assert.equal(options?.maxRetries, 0);
		const output = createAssistantMessageEventStream();
		const message =
			++attempts === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 status code (no body)" })
				: fauxAssistantMessage("recovered");
		output.push({ type: "start", partial: message });
		output.push(
			message.stopReason === "error"
				? { type: "error", reason: "error", error: message }
				: { type: "done", reason: "stop", message },
		);
		return output;
	}, policy);
	const output = await stream(model, original);
	const types: string[] = [];
	for await (const event of output) types.push(event.type);
	assert.deepEqual(types, ["start", "done"]);
	assert.equal((await output.result()).stopReason, "stop");
	assert.equal(attempts, 2);
	assert.equal(original.messages.length, 1);
});

test("permanent errors and unrelated numeric text are terminal for model retry", async () => {
	for (const errorMessage of [
		"401 unauthorized",
		"429 insufficient_quota",
		"500 context_length_exceeded",
		"The request mentioned 530",
		"Upstream API error: 5300",
	]) {
		let attempts = 0;
		const stream = createRetryStream(() => {
			attempts++;
			const output = createAssistantMessageEventStream();
			output.push({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			});
			return output;
		}, policy);
		const output = await stream(model, { messages: [] });
		assert.equal((await output.result()).errorMessage, errorMessage);
		assert.equal(attempts, 1);
	}
});

test("model retry never replays a response after forwarding text, thinking or tool events", async (context) => {
	for (const type of ["text_delta", "thinking_delta", "toolcall_end"] as const) {
		await context.test(type, async () => {
			let attempts = 0;
			const stream = createRetryStream(() => {
				attempts++;
				const output = createAssistantMessageEventStream();
				const message = fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503" });
				const update: AssistantMessageEvent =
					type === "toolcall_end"
						? {
								type,
								contentIndex: 0,
								toolCall: { type: "toolCall", id: "write-1", name: "write", arguments: {} },
								partial: message,
							}
						: { type, contentIndex: 0, delta: "partial", partial: message };
				output.push({ type: "start", partial: message });
				output.push(update);
				output.push({
					type: "error",
					reason: "error",
					error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }),
				});
				return output;
			}, policy);
			const output = await stream(model, { messages: [] });
			const types: string[] = [];
			for await (const event of output) types.push(event.type);
			assert.deepEqual(types, ["start", type, "error"]);
			assert.equal(attempts, 1);
		});
	}
});

test("model retry respects disabled retry settings and already-cancelled requests", async () => {
	let attempts = 0;
	const stream = createRetryStream(
		() => {
			attempts++;
			const output = createAssistantMessageEventStream();
			output.push({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }),
			});
			return output;
		},
		{ ...policy, enabled: false },
	);
	assert.equal((await (await stream(model, { messages: [] })).result()).stopReason, "error");
	assert.equal(attempts, 1);
	const controller = new AbortController();
	controller.abort();
	assert.equal(
		(await (await stream(model, { messages: [] }, { signal: controller.signal })).result()).stopReason,
		"aborted",
	);
	assert.equal(attempts, 1);
});
