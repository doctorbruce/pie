import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { DEFAULT_HISTORY_IMAGE_BYTES, latestRealUserMessage, projectImageHistory } from "../src/image-history.ts";

function image(text: string): ImageContent {
	return { type: "image", data: Buffer.from(text).toString("base64"), mimeType: "image/png" };
}

function user(content: UserMessage["content"], timestamp = 0): UserMessage {
	return { role: "user", content, timestamp };
}

function tool(content: ToolResultMessage["content"], id = "screenshot"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "screenshot",
		content,
		details: { path: "screenshot.png", source: { tool: "browser" } },
		isError: false,
		timestamp: 0,
	};
}

function bytes(part: ImageContent): number {
	return Buffer.byteLength(JSON.stringify(part.data), "utf8");
}

test("image history removes older tool pictures before user pictures without changing tool pairs or stored messages", () => {
	const old = image("old user picture");
	const first = image("first screenshot");
	const second = image("second screenshot");
	const current = image("current user picture");
	const calls = fauxAssistantMessage([
		fauxToolCall("screenshot", {}, { id: "first" }),
		fauxToolCall("screenshot", {}, { id: "second" }),
	]);
	const firstResult = tool([{ type: "text", text: "Browser title stays available" }, first], "first");
	const secondResult = tool([second], "second");
	const input = [user([old]), calls, firstResult, secondResult, user([current])];
	const original = structuredClone(input);
	const output = projectImageHistory(input, bytes(old) + bytes(current) + bytes(second));
	assert.equal(JSON.stringify(output).includes(first.data), false);
	assert.equal(JSON.stringify(output).includes(second.data), true);
	assert.equal(JSON.stringify(output).includes(old.data), true);
	assert.equal(JSON.stringify(output).includes(current.data), true);
	assert.match(JSON.stringify(output), /Historical image omitted from this request/);
	assert.match(JSON.stringify(output), /Browser title stays available/);
	assert.equal(output[1], calls);
	assert.deepEqual(
		calls.content.filter((part) => part.type === "toolCall").map((part) => part.id),
		["first", "second"],
	);
	assert.equal(output[2].role, "toolResult");
	if (output[2].role !== "toolResult") throw new Error("Missing tool result");
	assert.equal(output[2].toolCallId, "first");
	assert.equal(output[2].details, firstResult.details);
	assert.equal(output[3], secondResult);
	assert.deepEqual(input, original);

	const smaller = projectImageHistory(input, bytes(current));
	assert.equal(JSON.stringify(smaller).includes(old.data), false);
	assert.equal(JSON.stringify(smaller).includes(second.data), false);
	assert.equal(JSON.stringify(smaller).includes(current.data), true);
	assert.deepEqual(input, original);
});

test("image history counts repeated image occurrences even when the same object is reused", () => {
	const picture = image("repeated screenshot");
	const result = tool([picture, picture]);
	const output = projectImageHistory([result, user("Continue")], bytes(picture));
	assert.equal(JSON.stringify(output).split(picture.data).length, 2);
	assert.equal(output[0].role, "toolResult");
	if (output[0].role !== "toolResult") throw new Error("Missing tool result");
	assert.deepEqual(output[0].content, [
		{ type: "text", text: "[Historical image omitted from this request: image/png]" },
		picture,
	]);
	assert.deepEqual(result.content, [picture, picture]);
});

test("image history protects every latest real user picture even above budget", () => {
	const old = image("old picture");
	const first = image("current one");
	const second = image("current two");
	const current = user([first, second]);
	const input = [user([old]), current];
	const output = projectImageHistory(input, 0);
	assert.equal(output[1], current);
	assert.equal(JSON.stringify(output).includes(old.data), false);
	assert.equal(JSON.stringify(output).includes(first.data), true);
	assert.equal(JSON.stringify(output).includes(second.data), true);
});

test("a latest text-only user makes prior user pictures eligible in transcript order", () => {
	const first = image("oldest picture");
	const second = image("newer picture");
	const current = user("Continue", 2);
	const input = [user([first], 500), user([second], 1), current];
	const output = projectImageHistory(input, bytes(second));
	assert.equal(JSON.stringify(output).includes(first.data), false);
	assert.equal(JSON.stringify(output).includes(second.data), true);
	assert.equal(output[2], current);
});

test("internal and imported system messages do not replace the protected user", () => {
	const picture = image("current picture");
	const current = user([picture]);
	const checkpoint = Object.assign(user("context summary"), { contextCheckpoint: true });
	const catalog = user([
		Object.assign(
			{ type: "text" as const, text: "available skills" },
			{
				synthetic: true,
				metadata: { kind: "capability_catalog" },
			},
		),
	]);
	const background = user([
		Object.assign(
			{ type: "text" as const, text: "background completed" },
			{ synthetic: true, backgroundJobId: "job" },
		),
	]);
	const worker = Object.assign(user("Worker request"), {
		workerMessageId: "worker-message",
		metadata: { workerCommunication: { kind: "request" } },
	});
	const system = Object.assign(user("Imported system message"), { transferMessage: { role: "system" } });
	const input = [current, checkpoint, catalog, background, worker, system];
	assert.equal(latestRealUserMessage(input), current);
	assert.equal(projectImageHistory(input, 0), input);
	assert.equal(latestRealUserMessage([checkpoint, catalog, background, worker, system]), undefined);
});

test("a real image remains protected beside a synthetic turn-context block", () => {
	const picture = image("current picture");
	const current = user([
		Object.assign(
			{ type: "text" as const, text: "turn context" },
			{ synthetic: true, metadata: { kind: "turn_context" } },
		),
		picture,
	]);
	assert.equal(latestRealUserMessage([current]), current);
	assert.equal(projectImageHistory([current], 0)[0], current);
});

test("an explicit original protected user outside the summary head does not protect an older head picture", () => {
	const old = user([image("old picture")]);
	const current = user([image("current picture")]);
	const output = projectImageHistory([old], 0, current);
	assert.deepEqual(output, [
		user([{ type: "text", text: "[Historical image omitted from this request: image/png]" }]),
	]);
	const full = projectImageHistory([old, current], 0, old);
	assert.equal(full[0], old);
	assert.equal(JSON.stringify(full).includes(image("current picture").data), false);
	assert.notEqual(full[1], current);
});

test("image history defaults to a 16 MiB encoded target and preserves untouched messages", () => {
	assert.equal(DEFAULT_HISTORY_IMAGE_BYTES, 16 * 1024 * 1024);
	const picture: ImageContent = { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" };
	const result = tool([picture, picture]);
	const current = user("Continue");
	const output = projectImageHistory([result, current]);
	assert.equal(output[0].role, "toolResult");
	if (output[0].role !== "toolResult") throw new Error("Missing tool result");
	assert.equal(output[0].content.filter((part) => part.type === "image").length, 1);
	assert.equal(output[1], current);
	const underBudget = [tool([image("small image")]), user("Continue")];
	assert.equal(projectImageHistory(underBudget), underBudget);
	const textOnly: AgentMessage[] = [user("Hello"), fauxAssistantMessage("Hi")];
	assert.equal(projectImageHistory(textOnly, 0), textOnly);
});
