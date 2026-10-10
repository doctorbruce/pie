import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ImagePart, SessionSnapshot, SessionTransfer } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

type ModelRequest = {
	messages: { role: string; content: string | { type: string; image_url?: { url: string }; text?: string }[] }[];
};
const image: ImagePart = { type: "image", mimeType: "image/png", data: "Zml4dHVyZSBpbWFnZQ==" };

async function start(holdFirst = false) {
	const directory = await mkdtemp(join(tmpdir(), "pie-multimodal-"));
	const calls: ModelRequest[] = [];
	let held: ServerResponse | undefined;
	function reply(response: ServerResponse) {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			"data: " +
				JSON.stringify({
					id: "image-test",
					object: "chat.completion.chunk",
					model: "vision-test",
					choices: [{ index: 0, delta: { content: "image received" }, finish_reason: "stop" }],
				}) +
				"\n\ndata: [DONE]\n\n",
		);
	}
	const endpoint = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest);
			if (holdFirst && calls.length === 1) held = response;
			else reply(response);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "local",
					models: [{ id: "vision-test", input: ["text", "image"], contextWindow: 100000, maxTokens: 100 }],
				},
			},
			defaultModel: { provider: "fixture", id: "vision-test" },
		}),
	);
	let core = createCoreServer({ PI_DATA_DIR: directory });
	let base = "";
	async function listen() {
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
	}
	await listen();
	const post = (path: string, body: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const snapshot = async (id: string) => (await (await fetch(`${base}/sessions/${id}`)).json()) as SessionSnapshot;
	async function settled(id: string) {
		for (let attempt = 0; attempt < 200; attempt++) {
			const value = await snapshot(id);
			if (value.turn?.status !== "running") {
				assert.equal(value.turn?.status, "completed", value.turn?.error);
				return value;
			}
			await delay(10);
		}
		throw new Error("Turn did not settle");
	}
	return {
		calls,
		post,
		snapshot,
		settled,
		get base() {
			return base;
		},
		async session() {
			const response = await post("/sessions", { mode: "real" });
			assert.equal(response.status, 201);
			return (await response.json()) as SessionSnapshot;
		},
		async export(id: string) {
			return (await (await fetch(`${base}/sessions/${id}/export`)).json()) as SessionTransfer;
		},
		release() {
			if (held) {
				reply(held);
				held = undefined;
			}
		},
		async restart() {
			await core.close();
			core = createCoreServer({ PI_DATA_DIR: directory });
			await listen();
		},
		async close() {
			held?.destroy();
			await core.close();
			await new Promise<void>((resolve) => {
				endpoint.close(() => resolve());
				endpoint.closeAllConnections();
			});
			assert.ok(directory.startsWith(join(tmpdir(), "pie-multimodal-")));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("turn sends images in the first SDK request and preserves them through display, export and restart", async (context) => {
	const server = await start();
	context.after(() => server.close());
	const session = await server.session();
	const largeImage = { ...image, data: Buffer.alloc(60000, 1).toString("base64") };
	const response = await server.post(`/sessions/${session.id}/turns`, {
		text: "explain\n\nhidden context",
		displayText: "explain",
		images: [image, largeImage],
		clientMessageId: "client-image",
	});
	assert.equal(response.status, 202, await response.text());
	const snapshot = await server.settled(session.id);
	const user = server.calls[0].messages.find((message) => message.role === "user");
	assert.deepEqual(user?.content, [
		{ type: "text", text: "explain\n\nhidden context" },
		...[image, largeImage].map((part) => ({
			type: "image_url",
			image_url: { url: `data:${part.mimeType};base64,${part.data}` },
		})),
	]);
	assert.deepEqual(snapshot.messages[0].content, [{ type: "text", text: "explain" }, image, largeImage]);
	const transfer = await server.export(session.id);
	assert.deepEqual(transfer.transcript[0].content, [
		{ type: "text", text: "explain" },
		...[image, largeImage].map((part) => ({
			type: "file",
			mimeType: part.mimeType,
			uri: `data:${part.mimeType};base64,${part.data}`,
		})),
	]);
	await server.restart();
	assert.deepEqual((await server.snapshot(session.id)).messages[0].content, snapshot.messages[0].content);
	assert.equal((await server.post(`/sessions/${session.id}/turns`, { text: "continue" })).status, 202);
	await server.settled(session.id);
	assert.deepEqual(server.calls[1].messages.find((message) => message.role === "user")?.content, user?.content);
});

test("image-only input reaches the model without a read tool call", async (context) => {
	const server = await start();
	context.after(() => server.close());
	const session = await server.session();
	const response = await server.post(`/sessions/${session.id}/turns`, { text: "", images: [image] });
	assert.equal(response.status, 202, await response.text());
	const snapshot = await server.settled(session.id);
	assert.deepEqual(server.calls[0].messages.find((message) => message.role === "user")?.content, [
		{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
	]);
	assert.ok(!snapshot.messages.some((message) => message.role === "toolResult"));
});

test("steer preserves image content and canonical identity in the next SDK request", async (context) => {
	const server = await start(true);
	context.after(() => server.close());
	const session = await server.session();
	const response = await server.post(`/sessions/${session.id}/turns`, { text: "start" });
	assert.equal(response.status, 202);
	const turn = (await response.json()) as { turnId: string };
	for (let attempt = 0; server.calls.length === 0 && attempt < 200; attempt++) await delay(10);
	assert.equal(server.calls.length, 1);
	const steer = await server.post(`/sessions/${session.id}/steer`, {
		turnId: turn.turnId,
		text: "inspect this",
		images: [image],
		clientMessageId: "steer-image",
	});
	assert.equal(steer.status, 202, await steer.text());
	server.release();
	const snapshot = await server.settled(session.id);
	const users = server.calls[1].messages.filter((message) => message.role === "user");
	assert.deepEqual(users.at(-1)?.content, [
		{ type: "text", text: "inspect this" },
		{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
	]);
	assert.equal(
		Reflect.get(snapshot.messages.filter((message) => message.role === "user").at(-1)!, "clientMessageId"),
		"steer-image",
	);
});

test("imported canonical image attachments remain multimodal in the next request", async (context) => {
	const server = await start();
	context.after(() => server.close());
	const session = await server.session();
	const response = await fetch(`${server.base}/sessions/${session.id}/import`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			source: { astronSessionId: "astron-image", coreId: "opencode", sessionId: "imported-image" },
			transcript: [
				{
					role: "user",
					content: [
						{ type: "text", text: "original image" },
						{ type: "file", mimeType: image.mimeType, uri: `data:image/png;base64,${image.data}` },
					],
				},
			],
		}),
	});
	assert.equal(response.status, 200, await response.text());
	assert.equal((await server.post(`/sessions/${session.id}/turns`, { text: "continue" })).status, 202);
	await server.settled(session.id);
	assert.deepEqual(server.calls[0].messages.find((message) => message.role === "user")?.content, [
		{ type: "text", text: "original image" },
		{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
	]);
});

test("invalid image data is rejected without starting a model call", async (context) => {
	const server = await start();
	context.after(() => server.close());
	const session = await server.session();
	for (const images of [
		null,
		[null],
		[{ ...image, data: "not base64!" }],
		[{ ...image, data: "" }],
		[{ ...image, mimeType: "text/plain" }],
	]) {
		const response = await server.post(`/sessions/${session.id}/turns`, { text: "explain", images });
		assert.equal(response.status, 400);
	}
	assert.equal(server.calls.length, 0);
});
