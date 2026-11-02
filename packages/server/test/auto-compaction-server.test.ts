import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Assistant, SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

type ModelRequest = { summary: boolean; body: string };
type Reply = {
	error?: string;
	status?: number;
	hold?: boolean;
	finishReason?: string;
	tool?: { name: string; arguments: Record<string, unknown> };
};

async function start(
	context: TestContext,
	handle: (request: ModelRequest, requests: ModelRequest[]) => Reply,
	thresholdTokens = 300,
	hostThresholdTokens?: number | null,
	options: { retry?: { maxRetries: number; baseDelayMs: number }; toolIds?: string[] } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pie-auto-compaction-"));
	const requests: ModelRequest[] = [];
	const endpoint = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString("utf8");
			const call = { summary: body.includes("You are a context summarization assistant"), body };
			requests.push(call);
			const reply = handle(call, requests);
			if (reply.error || (reply.status !== undefined && reply.status >= 400)) {
				response.writeHead(reply.status ?? 400, { "content-type": "application/json" });
				response.end(reply.error ? JSON.stringify({ error: { message: reply.error, type: "test_error" } }) : "");
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (reply.hold) {
				response.flushHeaders();
				return;
			}
			response.end(
				`data: ${JSON.stringify({
					id: "compaction-test",
					object: "chat.completion.chunk",
					model: "tiny",
					choices: [
						{
							index: 0,
							delta: reply.tool
								? {
										tool_calls: [
											{
												index: 0,
												id: "read-once",
												type: "function",
												function: {
													name: reply.tool.name,
													arguments: JSON.stringify(reply.tool.arguments),
												},
											},
										],
									}
								: { content: call.summary ? "checkpoint" : "reply" },
							finish_reason: reply.finishReason ?? (reply.tool ? "tool_calls" : "stop"),
						},
					],
				})}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointAddress = endpoint.address();
	assert(endpointAddress && typeof endpointAddress !== "string");
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
					apiKey: "fixture",
					models: [{ id: "tiny", input: ["text", "image"], contextWindow: 10000, maxTokens: 128 }],
				},
			},
			defaultModel: { provider: "local", id: "tiny" },
		}),
	);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			compaction: { thresholdTokens, reserveTokens: 1000, keepRecentTokens: 150 },
			retry: options.retry ?? { maxRetries: 2, baseDelayMs: 1 },
		}),
	);
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const abort = new AbortController();
	let reading: Promise<void> | undefined;
	context.after(async () => {
		abort.abort();
		await reading;
		await core.close();
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	async function configureHost(threshold?: number) {
		const response = await fetch(`${base}/host-runtimes`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				runtimes: [
					{
						assistantId: "host-compaction",
						assistantRevision: String(threshold ?? "default"),
						runtime: {
							systemPrompt: "",
							toolIds: options.toolIds ?? [],
							skills: [],
							subagents: [],
							compaction: threshold === undefined ? {} : { thresholdTokens: threshold },
						},
					},
				],
			}),
		});
		assert.equal(response.status, 200);
	}
	let assistantId: string;
	if (hostThresholdTokens !== undefined) {
		await configureHost(hostThresholdTokens ?? undefined);
		assistantId = "host-compaction";
		await writeFile(join(directory, "settings.json"), "not valid JSON");
	} else {
		const assistantResponse = await post("/assistants", {
			name: "Compaction",
			systemPrompt: "",
			toolIds: options.toolIds ?? [],
		});
		assert.equal(assistantResponse.status, 201);
		assistantId = ((await assistantResponse.json()) as Assistant).id;
	}
	const sessionResponse = await post("/sessions", { mode: "real", assistantId, workspacePath: directory });
	assert.equal(sessionResponse.status, 201);
	const session = (await sessionResponse.json()) as SessionSnapshot;
	const events: SessionEvent[] = [];
	const eventResponse = await fetch(`${base}/sessions/${session.id}/events`, { signal: abort.signal });
	assert(eventResponse.body);
	const reader = eventResponse.body.getReader();
	reading = (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			buffer += decoder.decode(chunk.value, { stream: true });
			while (buffer.includes("\n\n")) {
				const boundary = buffer.indexOf("\n\n");
				const packet = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (packet.startsWith("data: ")) events.push(JSON.parse(packet.slice(6)) as SessionEvent);
			}
		}
	})().catch((error) => {
		if (!abort.signal.aborted) throw error;
	});
	const snapshot = async () => (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	async function settled() {
		for (let attempt = 0; attempt < 300; attempt++) {
			const value = await snapshot();
			if (value.turn?.status !== "running") {
				await delay(10);
				return value;
			}
			await delay(10);
		}
		throw new Error("turn did not settle");
	}
	async function submit(body: unknown) {
		assert.equal((await post(`/sessions/${session.id}/turns`, body)).status, 202);
		return settled();
	}
	return { requests, events, post, session, snapshot, settled, submit, configureHost, directory };
}

test("ordinary model requests recover from an empty-body 503, including host compaction defaults", async (context) => {
	for (const host of [false, true]) {
		await context.test(host ? "host compaction: {}" : "local retry settings", async (child) => {
			const server = await start(
				child,
				(_request, requests) => (requests.length === 1 ? { status: 503 } : {}),
				9000,
				host ? null : undefined,
			);
			const snapshot = await server.submit({ text: "Continue after the provider recovers." });
			assert.equal(snapshot.turn?.status, "completed", snapshot.turn?.error);
			assert.equal(server.requests.length, 2);
			assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
			assert(!snapshot.messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
		});
	}
});

test("ordinary model retries exhaust the configured budget before failing", async (context) => {
	const server = await start(context, () => ({ status: 503 }), 9000);
	const snapshot = await server.submit({ text: "Provider remains unavailable." });
	assert.equal(snapshot.turn?.status, "failed");
	assert.match(snapshot.turn?.error ?? "", /503/);
	assert.equal(server.requests.length, 3);
	assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
});

test("cancelling ordinary model retry backoff settles the turn without another provider request", async (context) => {
	let receivedFailure = () => {};
	const firstFailure = new Promise<void>((resolve) => {
		receivedFailure = resolve;
	});
	const server = await start(
		context,
		() => {
			receivedFailure();
			return { status: 503 };
		},
		9000,
		undefined,
		{ retry: { maxRetries: 2, baseDelayMs: 10000 } },
	);
	assert.equal(
		(await server.post(`/sessions/${server.session.id}/turns`, { text: "Cancel while retrying." })).status,
		202,
	);
	await firstFailure;
	await delay(25);
	const running = await server.snapshot();
	assert.equal(running.turn?.status, "running");
	assert.equal((await server.post(`/sessions/${server.session.id}/cancel`, { turnId: running.turn?.id })).status, 202);
	const snapshot = await server.settled();
	assert.equal(snapshot.turn?.status, "cancelled");
	assert.equal(server.requests.length, 1);
});

test("retrying a model response after a completed tool preserves its result and does not replay the tool", async (context) => {
	const server = await start(
		context,
		(_request, requests) => {
			if (requests.length === 1)
				return {
					tool: { name: "read", arguments: { path: "tool-result.txt", description: "Read the saved result" } },
				};
			return requests.length === 2 ? { status: 503 } : {};
		},
		9000,
		undefined,
		{ toolIds: ["read"] },
	);
	await writeFile(join(server.directory, "tool-result.txt"), "completed-tool-result");
	const snapshot = await server.submit({ text: "Read the saved result, then finish." });
	assert.equal(snapshot.turn?.status, "completed", snapshot.turn?.error);
	assert.equal(server.requests.length, 3);
	const results = snapshot.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 1);
	assert.equal(results[0].isError, false);
	assert.match(JSON.stringify(results[0].content), /completed-tool-result/);
	assert.equal(server.events.filter((event) => event.event?.type === "tool_execution_start").length, 1);
	assert.match(server.requests[1].body, /completed-tool-result/);
	assert.equal(server.requests[1].body, server.requests[2].body);
});

test("host compaction thresholds hot-update without reading a local settings file", async (context) => {
	const server = await start(context, () => ({}), 300, 8000);
	assert.equal((await server.submit({ text: "x".repeat(600) })).turn?.status, "completed");
	assert.equal((await server.submit({ text: "y".repeat(600) })).compaction, undefined);
	await server.configureHost(300);
	const compacted = await server.submit({ text: "z".repeat(600) });
	assert.equal(compacted.turn?.status, "completed");
	assert.equal(compacted.compaction?.generation, 1);
	assert(server.requests.some((request) => request.summary));
	await server.configureHost();
	const restored = await server.submit({ text: "after reset" });
	assert.equal(restored.turn?.status, "completed");
	assert.equal(restored.compaction?.generation, 1);
});

test("provider overflow compacts and retries the same native turn, retaining images and full history", async (context) => {
	let failed = false;
	const server = await start(
		context,
		(request, requests) => {
			if (!request.summary && requests.filter((call) => !call.summary).length === 2 && !failed) {
				failed = true;
				return { error: "context_length_exceeded" };
			}
			return {};
		},
		9000,
	);
	assert.equal((await server.submit({ text: `older-${"x".repeat(600)}` })).turn?.status, "completed");
	const image = { type: "image", data: "Zml4dHVyZSBpbWFnZQ==", mimeType: "image/png" };
	const snapshot = await server.submit({ text: "current", images: [image] });
	assert.equal(snapshot.turn?.status, "completed");
	assert.equal(snapshot.messages.length, 4);
	assert.equal(snapshot.compaction?.generation, 1);
	assert.equal(
		snapshot.messages.filter((message) => message.role === "assistant" && message.stopReason === "error").length,
		0,
	);
	assert(server.requests.at(-1)?.body.includes(`data:image/png;base64,${image.data}`));
	assert(server.events.some((event) => event.type === "compaction.started" && event.event?.reason === "overflow"));
	assert(server.events.some((event) => event.type === "compaction.finished" && event.event?.status === "completed"));
});

test("transient summary failures retry through the SDK and publish backoff events", async (context) => {
	const server = await start(context, (request, requests) =>
		request.summary && requests.filter((call) => call.summary).length === 1
			? { error: "503 terminated", status: 503 }
			: {},
	);
	await server.submit({ text: "x".repeat(600) });
	const snapshot = await server.submit({ text: "y".repeat(600) });
	assert.equal(snapshot.turn?.status, "completed");
	assert.equal(snapshot.compaction?.generation, 1);
	assert.equal(server.requests.filter((call) => call.summary).length, 2);
	assert(server.events.some((event) => event.type === "compaction.retry" && event.event?.attempt === 1));
});

test("quota and incomplete summaries fail explicitly without publishing a checkpoint or the over-budget request", async (context) => {
	for (const reply of [{ error: "429 insufficient_quota", status: 429 }, { finishReason: "length" }]) {
		await context.test(JSON.stringify(reply), async (child) => {
			const server = await start(child, (request) => (request.summary ? reply : {}));
			await server.submit({ text: "x".repeat(600) });
			const snapshot = await server.submit({ text: "y".repeat(600) });
			assert.equal(snapshot.turn?.status, "failed");
			assert.equal(snapshot.compaction, undefined);
			assert.equal(server.requests.filter((call) => call.summary).length, 1);
			assert.equal(server.requests.filter((call) => !call.summary).length, 1);
			assert(
				server.events.some((event) => event.type === "compaction.finished" && event.event?.status === "failed"),
			);
		});
	}
});

test("cancelling a streaming summary settles the native turn and never saves a checkpoint", async (context) => {
	const server = await start(context, (request) => (request.summary ? { hold: true } : {}));
	await server.submit({ text: "x".repeat(600) });
	assert.equal((await server.post(`/sessions/${server.session.id}/turns`, { text: "y".repeat(600) })).status, 202);
	for (let attempt = 0; !server.requests.some((request) => request.summary); attempt++) {
		assert(attempt < 300);
		await delay(10);
	}
	const running = await server.snapshot();
	assert.equal((await server.post(`/sessions/${server.session.id}/cancel`, { turnId: running.turn?.id })).status, 202);
	const snapshot = await server.settled();
	assert.equal(snapshot.turn?.status, "cancelled");
	assert.equal(snapshot.compaction, undefined);
	assert.equal(server.requests.filter((call) => !call.summary).length, 1);
	assert(server.events.some((event) => event.type === "compaction.finished" && event.event?.status === "cancelled"));
});
