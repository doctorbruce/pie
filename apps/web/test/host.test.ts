import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Assistant, SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { createServer as createViteServer } from "vite";
import { startChatHost } from "../host.ts";
import { createWebConfig } from "../vite.config.ts";

test("chat host proxies browser HTTP and faux SSE while rejecting foreign origins and hosts", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-chat-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const host = await startChatHost({ environment: { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" }, port: 0 });
	t.after(() => host.close());
	const response = await fetch(host.url);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /<title>Pie<\/title>/);
	assert.equal((await fetch(`${host.url}/api/health`, { headers: { Origin: host.url } })).status, 200);
	for (const origin of ["https://untrusted.example", "http://127.0.0.1:1", "null"])
		assert.equal((await fetch(`${host.url}/api/health`, { headers: { Origin: origin } })).status, 403);
	for (const authority of ["untrusted.example", "localhost:5174"]) {
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const call = request(`${host.url}/api/health`, { headers: { Host: authority } }, (result) => {
				result.resume();
				resolve(result.statusCode);
			});
			call.on("error", reject);
			call.end();
		});
		assert.equal(status, 403);
	}
	const created = await fetch(`${host.url}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: host.url },
		body: JSON.stringify({ mode: "faux", title: "本地聊天验收" }),
	});
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	const controller = new AbortController();
	const stream = await fetch(`${host.url}/api/sessions/${session.id}/events`, {
		headers: { Origin: host.url },
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
	});
	assert.equal(stream.status, 200);
	assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
	assert(stream.body);
	const reader = stream.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	async function nextPacket(): Promise<SessionEvent> {
		while (true) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6)) as SessionEvent;
				continue;
			}
			const { done, value } = await reader.read();
			assert(!done, "SSE 应持续到执行结算");
			buffer += decoder.decode(value, { stream: true });
		}
	}
	try {
		assert.equal((await nextPacket()).type, "snapshot");
		const sent = await fetch(`${host.url}/api/sessions/${session.id}/turns`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: host.url },
			body: JSON.stringify({ text: "本地假模型验收" }),
		});
		assert.equal(sent.status, 202);
		let settled: SessionEvent;
		do settled = await nextPacket();
		while (settled.type !== "turn.settled");
		assert.equal(settled.turn?.status, "completed");
		const final = await fetch(`${host.url}/api/sessions/${session.id}`).then(
			(response) => response.json() as Promise<SessionSnapshot>,
		);
		assert(final.messages.some((message) => message.role === "assistant"));
	} finally {
		controller.abort();
		await reader.cancel().catch(() => {});
	}
	await host.close();
	await host.close();
	await assert.rejects(fetch(host.url));
});

test("chat configuration only accepts a local Core and a valid listening port", async () => {
	for (const target of [
		"https://127.0.0.1:4318",
		"http://localhost:4318",
		"http://192.168.1.2:4318",
		"http://127.0.0.1:4318/path",
		"http://user:secret@127.0.0.1:4318",
	])
		assert.throws(() => createWebConfig(target), /PI_SERVER_URL/);
	for (const port of [-1, 65536, 1.5, Number.NaN]) await assert.rejects(startChatHost({ port }), /port/);
	const config = createWebConfig("http://127.0.0.1:4318");
	await assert.rejects(
		createViteServer({ ...config, configFile: false, server: { ...config.server, host: "0.0.0.0" } }),
		/127\.0\.0\.1/,
	);
});

test("chat startup failure releases Core storage so the next launch can reuse it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-chat-restart-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const occupied = createHttpServer();
	occupied.listen(0, "127.0.0.1");
	await once(occupied, "listening");
	t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
	const address = occupied.address();
	assert(address && typeof address !== "string");
	const environment = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	await assert.rejects(startChatHost({ environment, port: address.port }), /already in use/);
	const host = await startChatHost({ environment, port: 0 });
	await host.close();
});

test("chat CLI prints its URL and releases the database on SIGTERM", { timeout: 15000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-chat-cli-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const child = spawn(
		process.execPath,
		["--conditions=source", fileURLToPath(new URL("../host.ts", import.meta.url)), "--port", "0"],
		{ env: { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	const exited = once(child, "exit");
	const lines = createInterface({ input: child.stdout });
	let url = "";
	for await (const line of lines) {
		const match = /Pie 聊天已启动：(http:\/\/127\.0\.0\.1:\d+)/.exec(line);
		if (match) {
			url = match[1];
			lines.close();
			break;
		}
	}
	assert(url, "CLI 应输出聊天页面地址");
	assert.equal((await fetch(`${url}/api/health`)).status, 200);
	const catalog = (await fetch(`${url}/api/assistants`).then((response) => response.json())) as {
		assistants: Assistant[];
	};
	const assistant = catalog.assistants[0];
	assert.equal(
		(
			await fetch(`${url}/api/assistants/${assistant.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...assistant, toolIds: ["bash"] }),
			})
		).status,
		200,
	);
	const session = (await fetch(`${url}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "faux", assistantId: assistant.id }),
	}).then((response) => response.json())) as SessionSnapshot;
	assert.equal(
		(
			await fetch(`${url}/api/sessions/${session.id}/turns`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: '调用工具 bash {"command":"echo CHAT_STOP_TEST"}' }),
			})
		).status,
		202,
	);
	let running: SessionSnapshot;
	do {
		running = (await fetch(`${url}/api/sessions/${session.id}`).then((response) =>
			response.json(),
		)) as SessionSnapshot;
		assert.equal(running.turn?.status, "running");
	} while (!running.interactions.length);
	child.kill("SIGTERM");
	const [code, signal] = await exited;
	assert([0, 143].includes(code));
	assert.equal(signal, null);
	const restarted = await startChatHost({ environment: { PI_DATA_DIR: directory }, port: 0 });
	const recovered = (await fetch(`${restarted.url}/api/sessions/${session.id}`).then((response) =>
		response.json(),
	)) as SessionSnapshot;
	assert.equal(recovered.turn?.status, "cancelled");
	await restarted.close();
});
