import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Assistant, SessionEvent, SessionSnapshot } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

type ModelRequest = { summary: boolean; body: string };
type Reply = { error?: string; status?: number; hold?: boolean; finishReason?: string };

async function start(
	context: TestContext,
	handle: (request: ModelRequest, requests: ModelRequest[]) => Reply,
	thresholdTokens = 300,
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
			if (reply.error) {
				response.writeHead(reply.status ?? 400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: reply.error, type: "test_error" } }));
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
							delta: { content: call.summary ? "checkpoint" : "reply" },
							finish_reason: reply.finishReason ?? "stop",
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
			retry: { maxRetries: 2, baseDelayMs: 1 },
		}),
	);
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const assistantResponse = await post("/assistants", { name: "Compaction", systemPrompt: "", toolIds: [] });
	assert.equal(assistantResponse.status, 201);
	const assistant = (await assistantResponse.json()) as Assistant;
	const sessionResponse = await post("/sessions", { mode: "real", assistantId: assistant.id });
	assert.equal(sessionResponse.status, 201);
	const session = (await sessionResponse.json()) as SessionSnapshot;
	const events: SessionEvent[] = [];
	const abort = new AbortController();
	const eventResponse = await fetch(`${base}/sessions/${session.id}/events`, { signal: abort.signal });
	assert(eventResponse.body);
	const reader = eventResponse.body.getReader();
	const reading = (async () => {
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
	context.after(async () => {
		abort.abort();
		await reading;
		await core.close();
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
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
	return { requests, events, post, session, snapshot, settled, submit };
}

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
