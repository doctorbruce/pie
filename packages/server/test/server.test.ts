import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	Assistant,
	ModelCatalog,
	ProviderCatalog,
	SessionEvent,
	SessionSnapshot,
	SessionSummary,
} from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

const shellTool = "bash";
const waitCommand = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
const failCommand =
	process.platform === "win32" ? "Write-Error 'test failure'; exit 7" : "printf 'test failure\\n' >&2; exit 7";

async function start(env: NodeJS.ProcessEnv = {}) {
	const directory = env.PI_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "pie-server-test-")));
	const core = createCoreServer({ ...env, PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	return {
		...core,
		async close() {
			await core.close();
			if (!env.PI_DATA_DIR) await rm(directory, { recursive: true, force: true });
		},
		base,
		post: (path: string, body: unknown) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		put: (path: string, body: unknown) =>
			fetch(`${base}${path}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
	};
}

async function* events(url: string): AsyncGenerator<SessionEvent> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	assert.equal(response.status, 200);
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			while (buffer.includes("\n\n")) {
				const boundary = buffer.indexOf("\n\n");
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6));
			}
		}
	} finally {
		await reader.cancel();
	}
}

test("HTTP accepts a turn; SSE carries the real tool loop, settlement and reconnect snapshot", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-read-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "input.txt");
	await writeFile(path, "READ_OK");
	const core = await start();
	t.after(() => core.close());
	const catalog = (await (await fetch(`${core.base}/tools`)).json()) as { tools: { id: string }[] };
	assert.deepEqual(
		catalog.tools.map((tool) => tool.id),
		["read", "bash", "edit", "write", "grep", "find", "ls", "job_output", "job_kill"],
	);
	const assistants = (await (await fetch(`${core.base}/assistants`)).json()) as { assistants: Assistant[] };
	assert.deepEqual(assistants.assistants[0].toolIds, []);
	assert.equal(
		(
			await core.put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "read-host",
						assistantRevision: "1",
						runtime: { systemPrompt: "", toolIds: ["read"], skills: [], subagents: [] },
					},
				],
			})
		).status,
		200,
	);
	const created = await core.post("/sessions", {
		assistantId: "read-host",
		workspacePath: directory,
	});
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	const stream = events(`${core.base}/sessions/${session.id}/events`);
	assert.equal((await stream.next()).value?.type, "snapshot");
	const accepted = await core.post(`/sessions/${session.id}/turns`, {
		text: `调用工具 read ${JSON.stringify({ path })}`,
	});
	assert.equal(accepted.status, 202);
	const { turnId } = (await accepted.json()) as { turnId: string };
	const received: SessionEvent[] = [];
	for await (const packet of stream) {
		received.push(packet);
		assert.equal(packet.sessionId, session.id);
		assert.equal(packet.turnId, turnId);
		if (packet.type === "turn.settled") break;
	}
	assert(received.some((p) => p.event?.type === "tool_execution_start"));
	assert(received.some((p) => p.event?.type === "message_update"));
	assert.equal(received.find((p) => p.event?.type === "agent_end")?.snapshot.turn?.status, "running");
	const final = received.at(-1)?.snapshot;
	assert(final);
	assert.equal(final.turn?.status, "completed");
	assert.deepEqual(
		final.messages.map((m) => m.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	assert(final.messages.some((m) => m.role === "toolResult" && !m.isError && m.toolName === "read"));
	assert.match(JSON.stringify(final.messages), /READ_OK/);
	const reconnected = events(`${core.base}/sessions/${session.id}/events`);
	assert.deepEqual((await reconnected.next()).value?.snapshot, final);
	await reconnected.return(undefined);
	assert(received.every((p, i) => i === 0 || p.snapshot.revision > received[i - 1].snapshot.revision));
});

test("a persisted host runtime that no longer parses is dropped instead of blocking boot", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-stale-runtimes-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const dataDirectory = join(directory, "data");
	await mkdir(dataDirectory, { recursive: true });
	const database = new DatabaseSync(join(dataDirectory, "agent.sqlite"));
	database.exec(
		"CREATE TABLE IF NOT EXISTS host_runtimes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);" +
			"CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, payload TEXT NOT NULL);" +
			"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, payload TEXT NOT NULL);",
	);
	database.prepare("INSERT OR REPLACE INTO host_runtimes VALUES (?, ?)").run(
		"stale-host",
		JSON.stringify({
			assistantId: "stale-host",
			assistantRevision: "1",
			runtime: { systemPrompt: "", toolIds: ["tool-that-was-removed"], skills: [], subagents: [] },
		}),
	);
	database.close();

	const core = createCoreServer({ PI_DATA_DIR: dataDirectory });
	t.after(() => core.close());
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;

	const health = await fetch(`${base}/health`);
	assert.equal(health.status, 200);
	// The host re-registers on connect; the stale row is gone from storage.
	await core.close();
	const persisted = new DatabaseSync(join(dataDirectory, "agent.sqlite"));
	const rows = persisted.prepare("SELECT COUNT(*) AS count FROM host_runtimes").get() as { count: number };
	persisted.close();
	assert.equal(rows.count, 0);
});

test("global SSE stays incremental when the session snapshot exceeds the client backlog limit", async (t) => {
	const core = await start();
	t.after(() => core.close());
	const session = (await (await core.post("/sessions", {})).json()) as SessionSnapshot;
	const imported = await core.put(`/sessions/${session.id}/import`, {
		schemaVersion: 1,
		source: { astronSessionId: "large-session", coreId: "test", sessionId: "large-session" },
		transcript: [{ role: "user", content: [{ type: "text", text: "x".repeat(1_100_000) }] }],
	});
	assert.equal(imported.status, 200);
	assert(Buffer.byteLength(await imported.text()) > 1024 * 1024);
	const stream = events(`${core.base}/events`);
	const firstPacket = stream.next();
	const accepted = await core.post(`/sessions/${session.id}/turns`, { text: "继续" });
	assert.equal(accepted.status, 202, await accepted.clone().text());
	let receivedAgentEvent = false;
	let next = await firstPacket;
	while (!next.done) {
		const packet = next.value;
		assert(Buffer.byteLength(JSON.stringify(packet)) < 64 * 1024);
		if (packet.snapshot) assert.deepEqual(Object.keys(packet.snapshot), ["turn"]);
		if (packet.type === "agent.event") {
			receivedAgentEvent = true;
			assert.equal("snapshot" in packet, false);
			assert.equal("message" in (packet.event ?? {}), false);
			assert.equal("messages" in (packet.event ?? {}), false);
		}
		if (packet.type === "turn.settled") {
			assert(receivedAgentEvent);
			assert.equal(packet.snapshot.turn?.status, "completed");
			break;
		}
		next = await stream.next();
	}
});

test("global SSE promotes file output details for Astron artifact discovery", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-artifact-test-"));
	const core = await start();
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	assert.equal(
		(
			await core.put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "artifact-host",
						assistantRevision: "1",
						runtime: { systemPrompt: "", toolIds: ["write"], skills: [], subagents: [] },
					},
				],
			})
		).status,
		200,
	);
	const session = (await (
		await core.post("/sessions", { assistantId: "artifact-host", workspacePath: directory })
	).json()) as SessionSnapshot;
	const stream = events(`${core.base}/events`);
	const firstPacket = stream.next();
	assert.equal(
		(
			await core.post(`/sessions/${session.id}/turns`, {
				text: `调用工具 write ${JSON.stringify({ path: "result.txt", content: "ARTIFACT", artifactRole: "final" })}`,
			})
		).status,
		202,
	);
	let next = await firstPacket;
	while (!next.done) {
		const packet = next.value;
		if (packet.type === "interaction.requested" && packet.interaction) {
			assert.equal(
				(await core.post(`/sessions/${session.id}/interactions/${packet.interaction.id}`, { approved: true }))
					.status,
				202,
			);
		}
		if (packet.event?.type === "tool_execution_end") {
			const result = packet.event.result as {
				content: unknown[];
				details: { outputs: { path: string; artifactRole: string }[] };
				outputs: { path: string; artifactRole: string }[];
			};
			assert.deepEqual(result.outputs, result.details.outputs);
			assert.equal(result.outputs[0].path, join(directory, "result.txt"));
			assert.equal(result.outputs[0].artifactRole, "final");
			break;
		}
		next = await stream.next();
	}
});

test("Pi models.json configuration persists, reloads atomically and drives a real SDK tool loop without external APIs", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-test-"));
	const modelInput = join(directory, "model-input.txt");
	await writeFile(modelInput, "MODEL_READ_OK");
	const cores: { close: () => Promise<void> }[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const calls: {
		url?: string;
		authorization?: string;
		header?: string;
		body: {
			model: string;
			max_tokens?: number;
			messages: { role: string; content?: string }[];
			tools: { function: { name: string } }[];
		};
	}[] = [];
	const endpoint = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			calls.push({
				url: req.url,
				authorization: req.headers.authorization,
				header: String(req.headers["x-model-test"]),
				body,
			});
			const toolDone = body.messages.some((message: { role: string }) => message.role === "tool");
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const delta = toolDone
				? { content: "配置模型调用成功" }
				: {
						tool_calls: [
							{
								index: 0,
								id: "call_read",
								type: "function",
								function: { name: "read", arguments: JSON.stringify({ path: modelInput }) },
							},
						],
					};
			res.write(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
			res.end(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolDone ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => {
			res.writeHead(500);
			res.end();
		});
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise<void>((resolve) => {
				endpoint.close(() => resolve());
				endpoint.closeAllConnections();
			}),
	);
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	const env = { PI_DATA_DIR: directory, PIE_TEST_KEY: "private-test-key", PIE_TEST_HEADER: "private-header" };
	const core = await start(env);
	cores.push(core);
	t.after(() => core.close());
	const put = (body: unknown) =>
		fetch(`${core.base}/models/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const input = {
		provider: "local-test",
		id: "my-model",
		apiKey: "$PIE_TEST_KEY",
		model: {
			api: "openai-completions",
			baseUrl,
			maxTokens: 1234,
			contextWindow: 8192,
			headers: { "X-Model-Test": "$PIE_TEST_HEADER" },
			compat: { maxTokensField: "max_tokens" },
		},
	};
	const configured = await put(input);
	assert.equal(configured.status, 200);
	const catalog = await configured.text();
	assert(
		!catalog.includes("private-test-key") && !catalog.includes("PIE_TEST_KEY") && !catalog.includes("private-header"),
	);
	const parsed: ModelCatalog = JSON.parse(catalog);
	assert.deepEqual(parsed.selected, { provider: "local-test", id: "my-model" });
	assert(parsed.models.some((model) => model.provider === "openai"));
	const assistant = (await (
		await core.post("/assistants", { name: "SDK 助手", systemPrompt: "只按指定角色读取文件。", toolIds: ["read"] })
	).json()) as Assistant;
	const old = (await (
		await core.post("/sessions", { mode: "real", assistantId: assistant.id, workspacePath: directory })
	).json()) as SessionSnapshot;
	assert.equal(old.model, "my-model");
	const before = await readFile(join(directory, "models.json"), "utf8");
	for (const invalid of [
		{ ...input, model: { ...input.model, maxTokens: 0 } },
		{ ...input, model: { ...input.model, maxTokens: "bad" } },
		{ ...input, apiKey: "!echo do-not-execute" },
		{ ...input, model: { ...input.model, baseUrl: "https://secret@example.com" } },
		{ ...input, model: { ...input.model, api: "unsupported" } },
		{ provider: "missing", id: "missing" },
	])
		assert.equal((await put(invalid)).status, 400);
	assert.equal(await readFile(join(directory, "models.json"), "utf8"), before);
	assert.equal(
		(
			await put({
				provider: input.provider,
				id: input.id,
				apiKey: "new-test-key",
				model: { baseUrl: `${baseUrl}/changed` },
			})
		).status,
		200,
	);
	assert.equal((await put({ provider: input.provider, id: input.id, apiKey: "" })).status, 200);
	const newer = (await (
		await core.post("/sessions", { mode: "real", workspacePath: directory })
	).json()) as SessionSnapshot;
	for (const session of [old, newer]) {
		const stream = events(`${core.base}/sessions/${session.id}/events`);
		await stream.next();
		assert.equal((await core.post(`/sessions/${session.id}/turns`, { text: "读取文件" })).status, 202);
		for await (const packet of stream) {
			assert(!JSON.stringify(packet).includes("private-test-key"));
			if (packet.type !== "turn.settled") continue;
			assert.equal(packet.snapshot.turn?.status, "completed", packet.snapshot.turn?.error);
			assert(
				packet.snapshot.messages.some((message) => message.role === "toolResult" && message.toolName === "read"),
			);
			break;
		}
	}
	assert.equal(calls.length, 4);
	assert(
		calls
			.slice(0, 2)
			.every((call) => call.body.messages.some((message) => message.content === assistant.systemPrompt)),
	);
	assert(
		calls.slice(0, 2).every((call) => call.body.tools.length === 1 && call.body.tools[0].function.name === "read"),
	);
	assert(
		calls
			.slice(0, 2)
			.every((call) => call.url === "/v1/chat/completions" && call.authorization === "Bearer private-test-key"),
	);
	assert(
		calls
			.slice(2)
			.every((call) => call.url === "/v1/changed/chat/completions" && call.authorization === "Bearer new-test-key"),
	);
	assert(
		calls.every(
			(call) => call.body.model === "my-model" && call.header === "private-header" && call.body.max_tokens === 1234,
		),
	);
	const external = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
	external.providers["local-test"].modelOverrides = { "my-model": { contextWindow: 4096 } };
	await writeFile(join(directory, "models.json"), `// upstream-style comments\n${JSON.stringify(external)}`);
	assert.equal((await put({ provider: input.provider, id: input.id })).status, 400);
	const reload = await core.post("/models/reload", {});
	assert.equal(reload.status, 200);
	assert.equal(
		((await reload.json()) as ModelCatalog).models.find((model) => model.provider === input.provider)?.contextWindow,
		4096,
	);
	const editedOverride = await put({ provider: input.provider, id: input.id, model: { contextWindow: 5120 } });
	assert.equal(editedOverride.status, 200);
	assert.equal(
		((await editedOverride.json()) as ModelCatalog).models.find((model) => model.provider === input.provider)
			?.contextWindow,
		5120,
	);
	await writeFile(join(directory, "models.json"), '{"providers": private-secret-invalid-json');
	const invalidReload = await core.post("/models/reload", {});
	assert.equal(invalidReload.status, 400);
	assert(!(await invalidReload.text()).includes("private-secret"));
	assert.equal(
		((await (await fetch(`${core.base}/models`)).json()) as ModelCatalog).models.find(
			(model) => model.provider === input.provider,
		)?.contextWindow,
		5120,
	);
	await writeFile(join(directory, "models.json"), before);
	await core.close();
	const restarted = await start(env);
	cores.push(restarted);
	t.after(() => restarted.close());
	assert.deepEqual(
		((await (await fetch(`${restarted.base}/models`)).json()) as ModelCatalog).selected,
		parsed.selected,
	);
	assert.deepEqual(
		((await (await fetch(`${restarted.base}/sessions/${old.id}`)).json()) as SessionSnapshot).assistant,
		assistant,
	);
});

test("assistant edits reconfigure existing durable sessions before their next turn", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-assistants-"));
	const cores: { close: () => Promise<void> }[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const env = { PI_DATA_DIR: directory };
	const readable = join(directory, "assistant-input.txt");
	await writeFile(readable, "ASSISTANT_READ_OK");
	const core = await start(env);
	cores.push(core);
	t.after(() => core.close());
	assert.throws(() => createCoreServer(env), /locked/);
	const draft = { name: "写作助手", systemPrompt: "按写作助手的身份回答。", toolIds: [] };
	for (const input of [
		{ ...draft, name: " " },
		{ ...draft, toolIds: ["unknown_tool"] },
		{ ...draft, systemPrompt: 123 },
	])
		assert.equal((await core.post("/assistants", input)).status, 400);
	const assistant = (await (await core.post("/assistants", draft)).json()) as Assistant;
	const a = (await (
		await core.post("/sessions", { assistantId: assistant.id, title: "周报", workspacePath: directory })
	).json()) as SessionSnapshot;
	const b = (await (
		await core.post("/sessions", { assistantId: assistant.id, title: "方案", workspacePath: directory })
	).json()) as SessionSnapshot;
	assert.equal((await core.post("/sessions", { assistantId: "missing" })).status, 400);
	assert.equal((await fetch(`${core.base}/assistants/${assistant.id}`, { method: "DELETE" })).status, 409);
	const update = await fetch(`${core.base}/assistants/${assistant.id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...draft, name: "新版写作助手", toolIds: ["read"] }),
	});
	assert.equal(update.status, 200);
	const updatedAssistant = (await update.json()) as Assistant;
	const c = (await (
		await core.post("/sessions", { assistantId: assistant.id, workspacePath: directory })
	).json()) as SessionSnapshot;
	assert(c.assistant);
	assert.deepEqual(c.assistant.toolIds, ["read"]);
	let completed: SessionSnapshot | undefined;
	for (const session of [a, c]) {
		const stream = events(`${core.base}/sessions/${session.id}/events`);
		await stream.next();
		const text = `调用工具 read ${JSON.stringify({ path: readable })}`;
		assert.equal((await core.post(`/sessions/${session.id}/turns`, { text })).status, 202);
		for await (const packet of stream) {
			if (packet.type !== "turn.settled") continue;
			assert.equal(packet.snapshot.turn?.status, "completed");
			const toolResult = packet.snapshot.messages.find((message) => message.role === "toolResult");
			assert(toolResult);
			assert.equal(toolResult.isError, false);
			if (session.id === a.id) completed = packet.snapshot;
			break;
		}
	}
	assert(completed);
	assert.deepEqual(completed.assistant, updatedAssistant);
	assert.equal(completed.assistantRevision, String(updatedAssistant.updatedAt));
	assert.equal(completed.runtimeSource, "local");
	assert.deepEqual(completed.runtime?.toolIds, ["read"]);
	assert.equal(
		(
			await fetch(`${core.base}/sessions/${a.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "本周周报" }),
			})
		).status,
		200,
	);
	const listing = (await (await fetch(`${core.base}/sessions?assistantId=${assistant.id}`)).json()) as {
		sessions: SessionSummary[];
	};
	assert.equal(listing.sessions.length, 3);
	assert(!JSON.stringify(listing).includes("systemPrompt"));
	await core.close();
	const restarted = await start(env);
	cores.push(restarted);
	t.after(() => restarted.close());
	const restored = (await (await fetch(`${restarted.base}/sessions/${a.id}`)).json()) as SessionSnapshot;
	assert.throws(() => createCoreServer(env), /locked/);
	assert.equal(restored.title, "本周周报");
	assert.deepEqual(restored.messages, completed.messages);
	assert.deepEqual(restored.assistant, updatedAssistant);
	assert.notEqual(restored.instanceId, completed.instanceId);
	assert.deepEqual(
		((await (await fetch(`${restarted.base}/sessions/${b.id}`)).json()) as SessionSnapshot).messages,
		[],
	);
	const continued = events(`${restarted.base}/sessions/${a.id}/events`);
	await continued.next();
	await restarted.post(`/sessions/${a.id}/turns`, { text: "继续" });
	for await (const packet of continued) {
		if (packet.type !== "turn.settled") continue;
		assert.equal(packet.snapshot.turn?.status, "completed");
		assert.equal(packet.snapshot.messages.filter((m) => m.role === "user").length, 2);
		break;
	}
	for (const session of [a, b, c])
		assert.equal((await fetch(`${restarted.base}/sessions/${session.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${restarted.base}/assistants/${assistant.id}`, { method: "DELETE" })).status, 200);
	await restarted.close();
	const final = await start(env);
	cores.push(final);
	t.after(() => final.close());
	assert.deepEqual(await (await fetch(`${final.base}/sessions`)).json(), { sessions: [] });
});

test("host runtime revisions rebuild the agent while preserving session messages", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-host-runtime-"));
	const cores: { close: () => Promise<void> }[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const readable = join(directory, "host-input.txt");
	await writeFile(readable, "HOST_RUNTIME_OK");
	const core = await start({ PI_DATA_DIR: directory });
	cores.push(core);
	assert.equal(
		(
			await core.put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "astron-assistant",
						assistantRevision: "1",
						runtime: { systemPrompt: "第一版", toolIds: [], skills: [], subagents: [] },
					},
				],
			})
		).status,
		200,
	);
	const created = await core.post("/sessions", {
		assistantId: "astron-assistant",
		workspacePath: directory,
	});
	assert.equal(created.status, 201, await created.clone().text());
	const session = (await created.json()) as SessionSnapshot;
	assert.equal(session.runtimeSource, "host");
	assert.equal(session.assistant, undefined);
	assert.equal(
		(
			await core.post(`/sessions/${session.id}/turns`, {
				assistantId: "other-assistant",
				text: "不应受理",
			})
		).status,
		409,
	);
	const stream = events(`${core.base}/sessions/${session.id}/events`);
	await stream.next();
	assert.equal(
		(
			await core.put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "astron-assistant",
						assistantRevision: "2",
						runtime: { systemPrompt: "第二版", toolIds: ["read"], skills: [], subagents: [] },
					},
				],
			})
		).status,
		200,
	);
	assert.equal(
		(
			await core.post(`/sessions/${session.id}/turns`, {
				text: `调用工具 read ${JSON.stringify({ path: readable })}`,
				systemPrompt: "第二版动态上下文",
			})
		).status,
		202,
	);
	let completed: SessionSnapshot | undefined;
	for await (const packet of stream) {
		if (packet.type !== "turn.settled") continue;
		completed = packet.snapshot;
		break;
	}
	assert(completed);
	assert.equal(completed.turn?.status, "completed");
	assert.equal(completed.assistantRevision, "2");
	assert.deepEqual(completed.runtime?.toolIds, ["read"]);
	const result = completed.messages.find((message) => message.role === "toolResult");
	assert(result);
	assert.equal(result.isError, false);
	await core.close();
	const legacyDb = new DatabaseSync(join(directory, "agent.sqlite"));
	legacyDb.exec("PRAGMA foreign_keys = OFF");
	legacyDb.exec(`
		BEGIN IMMEDIATE;
		ALTER TABLE sessions RENAME TO sessions_without_assistant_fk;
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			assistant_id TEXT NOT NULL REFERENCES assistants(id),
			payload TEXT NOT NULL
		);
		INSERT INTO sessions SELECT id, assistant_id, payload FROM sessions_without_assistant_fk;
		DROP TABLE sessions_without_assistant_fk;
		COMMIT;
	`);
	legacyDb.close();
	const restarted = await start({ PI_DATA_DIR: directory });
	cores.push(restarted);
	const restored = (await (await fetch(`${restarted.base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.runtimeSource, "host");
	assert.equal(restored.assistantRevision, "2");
	assert.equal(restored.assistant, undefined);
	assert.deepEqual(restored.messages, completed.messages);
});

test("task delegates to fresh child sessions using the latest host assistant binding", async (t) => {
	const core = await start();
	t.after(() => core.close());
	const registry = (assistantRevision: string, workerRevision: string) => ({
		runtimes: [
			{
				assistantId: "star",
				assistantRevision,
				runtime: {
					systemPrompt: "父助手",
					toolIds: [],
					skills: [],
					subagents: [
						{
							id: "assistant-worker-writer",
							name: "写作助手",
							description: "撰写文本",
							assistantId: "writer",
						},
					],
				},
			},
			{
				assistantId: "writer",
				assistantRevision: workerRevision,
				runtime: {
					systemPrompt: `写作助手 ${workerRevision}`,
					toolIds: [],
					skills: [],
					subagents: [],
				},
			},
		],
	});
	assert.equal((await core.put("/host-runtimes", registry("1", "worker-1"))).status, 200);
	const created = await core.post("/sessions", {
		assistantId: "star",
	});
	assert.equal(created.status, 201, await created.clone().text());
	const parent = (await created.json()) as SessionSnapshot;
	assert.equal(parent.kind, "root");

	async function delegate(
		assistantRevision: string,
		workerRevision: string,
		options: { taskId?: string; background?: boolean } = {},
	) {
		assert.equal((await core.put("/host-runtimes", registry(assistantRevision, workerRevision))).status, 200);
		const stream = events(`${core.base}/sessions/${parent.id}/events`);
		await stream.next();
		const response = await core.post(`/sessions/${parent.id}/turns`, {
			text: `调用工具 task ${JSON.stringify({
				description: `任务 ${workerRevision}`,
				prompt: `请处理 ${workerRevision}`,
				subagent_type: "assistant-worker-writer",
				task_id: options.taskId,
				background: options.background,
			})}`,
		});
		assert.equal(response.status, 202, await response.clone().text());
		for await (const packet of stream) {
			if (packet.type === "interaction.requested" && packet.interaction) {
				assert.equal(
					(await core.post(`/sessions/${parent.id}/interactions/${packet.interaction.id}`, { approved: true }))
						.status,
					202,
				);
				continue;
			}
			if (packet.type !== "turn.settled") continue;
			assert.equal(packet.snapshot.turn?.status, "completed", packet.snapshot.turn?.error);
			const result = [...packet.snapshot.messages]
				.reverse()
				.find((message) => message.role === "toolResult" && message.toolName === "task");
			assert(result?.role === "toolResult");
			return result.details as {
				childSessionId: string;
				targetAssistantId: string;
				subagentType: string;
				background?: boolean;
				jobId?: string;
			};
		}
		throw new Error("父会话未结算");
	}

	const first = await delegate("2", "worker-1");
	assert.equal(first.targetAssistantId, "writer");
	assert.equal(first.subagentType, "assistant-worker-writer");
	const firstChild = (await (await fetch(`${core.base}/sessions/${first.childSessionId}`)).json()) as SessionSnapshot;
	assert.equal(firstChild.kind, "subagent");
	assert.equal(firstChild.parentSessionId, parent.id);
	assert.equal(firstChild.subagentType, "assistant-worker-writer");
	assert.equal(firstChild.assistantRevision, "worker-1");
	assert.equal(firstChild.runtime?.systemPrompt, "写作助手 worker-1");
	assert.deepEqual(firstChild.runtime?.subagents, []);
	assert.deepEqual(
		firstChild.messages.map((message) => message.role),
		["user", "assistant"],
	);
	assert.equal((await core.post(`/sessions/${first.childSessionId}/turns`, { text: "继续" })).status, 409);
	const resumed = await delegate("2", "worker-1", { taskId: first.childSessionId });
	assert.equal(resumed.childSessionId, first.childSessionId);
	const resumedChild = (await (
		await fetch(`${core.base}/sessions/${first.childSessionId}`)
	).json()) as SessionSnapshot;
	assert.deepEqual(
		resumedChild.messages.map((message) => message.role),
		["user", "assistant", "user", "assistant"],
	);

	const second = await delegate("3", "worker-2");
	const secondChild = (await (
		await fetch(`${core.base}/sessions/${second.childSessionId}`)
	).json()) as SessionSnapshot;
	assert.equal(secondChild.assistantRevision, "worker-2");
	assert.equal(secondChild.runtime?.systemPrompt, "写作助手 worker-2");
	const background = await delegate("4", "worker-2", { background: true });
	assert.equal(background.background, true);
	assert.equal(background.jobId, background.childSessionId);
	const backgroundChild = (await (
		await fetch(`${core.base}/sessions/${background.childSessionId}`)
	).json()) as SessionSnapshot;
	assert.equal(backgroundChild.turn?.status, "completed");
	const roots = (await (await fetch(`${core.base}/sessions`)).json()) as { sessions: SessionSummary[] };
	assert.deepEqual(
		roots.sessions.map((session) => session.id),
		[parent.id],
	);
	const all = (await (await fetch(`${core.base}/sessions?includeSubagents=true`)).json()) as {
		sessions: SessionSummary[];
	};
	assert.equal(all.sessions.length, 4);
	assert.equal((await fetch(`${core.base}/sessions/${parent.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${core.base}/sessions/${first.childSessionId}`)).status, 404);
	assert.equal((await fetch(`${core.base}/sessions/${second.childSessionId}`)).status, 404);
});

test("local assistants expose selected assistants as dynamically refreshed subagents", async (t) => {
	const core = await start();
	t.after(() => core.close());
	const worker = (await (
		await core.post("/assistants", {
			name: "本地写作助手",
			systemPrompt: "写作助手 v1",
			toolIds: [],
		})
	).json()) as Assistant;
	const parent = (await (
		await core.post("/assistants", {
			name: "星小妙",
			systemPrompt: "按需委派任务",
			toolIds: [],
			subagentIds: [worker.id],
		})
	).json()) as Assistant;
	assert.deepEqual(parent.subagentIds, [worker.id]);
	assert.equal(
		(
			await fetch(`${core.base}/assistants/${parent.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...parent, subagentIds: [parent.id] }),
			})
		).status,
		400,
	);
	const created = (await (await core.post("/sessions", { assistantId: parent.id })).json()) as SessionSnapshot;
	assert.equal(created.runtime?.subagents[0].id, `assistant-worker-${worker.id}`);

	async function delegate(label: string) {
		const stream = events(`${core.base}/sessions/${created.id}/events`);
		await stream.next();
		assert.equal(
			(
				await core.post(`/sessions/${created.id}/turns`, {
					text: `调用工具 task ${JSON.stringify({
						description: label,
						prompt: label,
						subagent_type: `assistant-worker-${worker.id}`,
					})}`,
				})
			).status,
			202,
		);
		for await (const packet of stream) {
			if (packet.type === "interaction.requested" && packet.interaction) {
				assert.equal(
					(await core.post(`/sessions/${created.id}/interactions/${packet.interaction.id}`, { approved: true }))
						.status,
					202,
				);
				continue;
			}
			if (packet.type !== "turn.settled") continue;
			const result = [...packet.snapshot.messages]
				.reverse()
				.find((message) => message.role === "toolResult" && message.toolName === "task");
			assert(result?.role === "toolResult");
			return (result.details as { childSessionId: string }).childSessionId;
		}
		throw new Error("父会话未结算");
	}

	const firstId = await delegate("第一版任务");
	const first = (await (await fetch(`${core.base}/sessions/${firstId}`)).json()) as SessionSnapshot;
	assert.equal(first.runtimeSource, "local");
	assert.equal(first.runtime?.systemPrompt, "写作助手 v1");
	const updatedWorker = (await (
		await fetch(`${core.base}/assistants/${worker.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...worker, systemPrompt: "写作助手 v2" }),
		})
	).json()) as Assistant;
	const secondId = await delegate("第二版任务");
	const second = (await (await fetch(`${core.base}/sessions/${secondId}`)).json()) as SessionSnapshot;
	assert.equal(second.assistantRevision, String(updatedWorker.updatedAt));
	assert.equal(second.runtime?.systemPrompt, "写作助手 v2");
	assert.equal((await fetch(`${core.base}/assistants/${worker.id}`, { method: "DELETE" })).status, 409);
	assert.equal(
		(
			await fetch(`${core.base}/assistants/${parent.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...parent, subagentIds: [] }),
			})
		).status,
		200,
	);
	assert.equal((await fetch(`${core.base}/sessions/${created.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${core.base}/assistants/${parent.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${core.base}/assistants/${worker.id}`, { method: "DELETE" })).status, 200);
});

test("process crash keeps accepted input and closes unknown tool outcomes without replay", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-crash-"));
	const cores: { close: () => Promise<void> }[] = [];
	const child = spawn(
		process.execPath,
		["--conditions=source", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--port", "0"],
		{ env: { PI_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const lines = createInterface({ input: child.stdout });
	const [line] = await once(lines, "line", { signal: AbortSignal.timeout(15000) });
	lines.close();
	const { url } = JSON.parse(String(line)) as { url: string };
	const post = (path: string, body: unknown) =>
		fetch(`${url}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const put = (path: string, body: unknown) =>
		fetch(`${url}${path}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	assert.equal(
		(
			await put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "crash-host",
						assistantRevision: "1",
						runtime: {
							systemPrompt: "",
							toolIds: [shellTool],
							skills: [],
							subagents: [],
							permissions: { bash: "allow" },
						},
					},
				],
			})
		).status,
		200,
	);
	const session = (await (await post("/sessions", { assistantId: "crash-host" })).json()) as SessionSnapshot;
	const stream = events(`${url}/sessions/${session.id}/events`);
	await stream.next();
	assert.equal(
		(
			await post(`/sessions/${session.id}/turns`, {
				text: `调用工具 ${shellTool} ${JSON.stringify({ command: waitCommand })}`,
			})
		).status,
		202,
	);
	let reachedTool = false;
	for await (const packet of stream) {
		if (packet.event?.type !== "tool_execution_update") continue;
		reachedTool = true;
		break;
	}
	assert(reachedTool);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	const core = await start({ PI_DATA_DIR: directory });
	cores.push(core);
	t.after(() => core.close());
	const restored = (await (await fetch(`${core.base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.turn?.status, "failed");
	assert.equal(restored.messages[0].role, "user");
	assert(restored.messages.some((message) => message.role === "toolResult" && message.isError));
	assert.deepEqual(
		((await (await fetch(`${core.base}/sessions/${session.id}`)).json()) as SessionSnapshot).messages,
		restored.messages,
	);
	const continued = events(`${core.base}/sessions/${session.id}/events`);
	await continued.next();
	await core.post(`/sessions/${session.id}/turns`, { text: "继续" });
	for await (const packet of continued) {
		if (packet.type !== "turn.settled") continue;
		assert.equal(packet.snapshot.turn?.status, "completed");
		assert.equal(
			packet.snapshot.messages.filter((message) => message.role === "toolResult" && message.toolName === shellTool)
				.length,
			1,
		);
		break;
	}
});

test("cancel targets one turn, rejects concurrent submits, and permits another turn after settlement", async (t) => {
	const core = await start();
	t.after(() => core.close());
	assert.equal(
		(
			await core.put("/host-runtimes", {
				runtimes: [
					{
						assistantId: "cancel-host",
						assistantRevision: "1",
						runtime: {
							systemPrompt: "",
							toolIds: [shellTool],
							skills: [],
							subagents: [],
							permissions: { bash: "allow" },
						},
					},
				],
			})
		).status,
		200,
	);
	const a = (await (await core.post("/sessions", { assistantId: "cancel-host" })).json()) as SessionSnapshot;
	const b = (await (await core.post("/sessions", {})).json()) as SessionSnapshot;
	const stream = events(`${core.base}/sessions/${a.id}/events`);
	await stream.next();
	const { turnId } = (await (
		await core.post(`/sessions/${a.id}/turns`, {
			text: `调用工具 ${shellTool} ${JSON.stringify({ command: waitCommand })}`,
		})
	).json()) as {
		turnId: string;
	};
	assert.equal((await core.post(`/sessions/${a.id}/turns`, { text: "重复提交" })).status, 409);
	assert.equal((await core.post(`/sessions/${a.id}/cancel`, { turnId: "stale" })).status, 409);
	assert.equal((await fetch(`${core.base}/sessions/${a.id}`, { method: "DELETE" })).status, 409);
	const other = events(`${core.base}/sessions/${b.id}/events`);
	await other.next();
	assert.equal((await core.post(`/sessions/${b.id}/turns`, { text: "普通回复" })).status, 202);
	let cancelSent = false;
	for await (const packet of stream) {
		if (packet.event?.type === "tool_execution_update" && !cancelSent) {
			assert.equal((await core.post(`/sessions/${a.id}/cancel`, { turnId })).status, 202);
			cancelSent = true;
		}
		if (packet.type === "turn.settled") {
			assert.equal(packet.snapshot.turn?.status, "cancelled");
			break;
		}
	}
	assert(cancelSent);
	for await (const packet of other) {
		if (packet.type === "turn.settled") {
			assert.equal(packet.snapshot.turn?.status, "completed");
			break;
		}
	}
	const retry = events(`${core.base}/sessions/${a.id}/events`);
	await retry.next();
	assert.equal(
		(
			await core.post(`/sessions/${a.id}/turns`, {
				text: `调用工具 ${shellTool} ${JSON.stringify({ command: failCommand })}`,
			})
		).status,
		202,
	);
	for await (const packet of retry) {
		if (packet.type !== "turn.settled") continue;
		assert.equal(packet.snapshot.turn?.status, "completed");
		assert(packet.snapshot.messages.some((m) => m.role === "toolResult" && !m.isError));
		const message = packet.snapshot.messages.at(-1);
		assert(
			message?.role === "assistant" &&
				message.content.some((p) => p.type === "text" && p.text.includes("test failure")),
		);
		break;
	}
	assert.equal((await fetch(`${core.base}/sessions/${a.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${core.base}/sessions/${a.id}`)).status, 404);
});

test("local service rejects foreign origins, malformed input, unavailable models and unauthenticated clients", async (t) => {
	const core = await start();
	t.after(() => core.close());
	assert.equal((await fetch(`${core.base}/health`, { headers: { Origin: "https://example.com" } })).status, 403);
	assert.equal((await fetch(`${core.base}/sessions`, { method: "POST", body: "{}" })).status, 415);
	assert.equal((await core.post("/sessions", [])).status, 400);
	assert.equal((await core.post("/plugins/import", { padding: "x".repeat(70000) })).status, 413);
	assert.equal(
		(
			await core.post("/sessions", {
				assistantId: "inline-host",
				runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
			})
		).status,
		400,
	);
	assert.equal((await core.post("/sessions", { mode: "real" })).status, 400);
	assert.equal((await core.post("/sessions", { mode: "unknown" })).status, 400);
	const session = (await (await core.post("/sessions", {})).json()) as SessionSnapshot;
	assert.equal((await core.post(`/sessions/${session.id}/turns`, { text: " " })).status, 400);
	assert.equal((await core.post(`/sessions/${session.id}/turns`, { text: "x".repeat(16001) })).status, 400);
	assert.equal(
		(
			await core.post(`/sessions/${session.id}/turns`, {
				text: "继续",
				runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
			})
		).status,
		400,
	);
	const secured = await start({ PI_SERVER_TOKEN: "test-only-token" });
	t.after(() => secured.close());
	assert.equal((await fetch(`${secured.base}/health`)).status, 401);
	const response = await fetch(`${secured.base}/health`, { headers: { Authorization: "Bearer test-only-token" } });
	assert.equal(response.status, 200);
	assert(!(await response.text()).includes("test-only-token"));
});

test("host runtime registry can exceed the ordinary 64 KiB body limit", async (t) => {
	const core = await start();
	t.after(() => core.close());
	const runtime = {
		systemPrompt: "x".repeat(16000),
		toolIds: [],
		skills: Array.from({ length: 16 }, (_, index) => ({
			id: `skill-${index}`,
			name: `skill-${index}`,
			description: "x".repeat(4096),
			directory: join(tmpdir(), `skill-${index}`),
		})),
		subagents: [],
	};
	const registry = {
		runtimes: [{ assistantId: "host-assistant", assistantRevision: "1", runtime }],
	};
	assert(Buffer.byteLength(JSON.stringify(registry)) > 65536);
	assert.equal((await core.put("/host-runtimes", registry)).status, 200);
	const created = await core.post("/sessions", { assistantId: "host-assistant" });
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	assert.equal(
		(
			await core.post(`/sessions/${session.id}/turns`, {
				text: "继续",
			})
		).status,
		202,
	);
});

test("provider settings, multi-model selection and protocol discovery preserve credentials and isolate endpoint changes", async (t) => {
	const calls: { path: string; key?: string }[] = [];
	const endpoint = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		calls.push({
			path: url.pathname,
			key: String(req.headers.authorization ?? req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? ""),
		});
		res.setHeader("Content-Type", "application/json");
		if (url.pathname.startsWith("/redirect")) {
			res.writeHead(302, { Location: "/leak/models" });
			res.end();
			return;
		}
		if (url.pathname.startsWith("/invalid")) {
			res.end("{ private-api-key");
			return;
		}
		if (url.pathname.startsWith("/error")) {
			res.writeHead(401);
			res.end("private-api-key");
			return;
		}
		if (url.pathname === "/google/v1beta/models") {
			res.end(
				JSON.stringify(
					url.searchParams.has("pageToken")
						? { models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }
						: {
								models: [
									{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
									{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
								],
								nextPageToken: "next",
							},
				),
			);
			return;
		}
		if (url.pathname === "/anthropic/v1/models") {
			res.end(
				JSON.stringify(
					url.searchParams.has("after_id")
						? { data: [{ id: "claude-b" }], has_more: false }
						: { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
				),
			);
			return;
		}
		res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise<void>((resolve) => {
				endpoint.close(() => resolve());
				endpoint.closeAllConnections();
			}),
	);
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	const core = await start({ TEST_PROVIDER_KEY: "private-api-key" });
	t.after(() => core.close());
	const draft = {
		id: "test-provider",
		name: "测试提供商",
		api: "openai-completions",
		baseUrl: `${url}/v1`,
		apiKey: "$TEST_PROVIDER_KEY",
	};
	const put = (body: unknown) =>
		fetch(`${core.base}/providers/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const found = await core.post("/providers/discover", draft);
	assert.equal(found.status, 200);
	assert.deepEqual(await found.json(), { models: [{ id: "model-a" }, { id: "model-b" }] });
	assert.equal(calls[0].path, "/v1/models");
	assert.equal(calls[0].key, "Bearer private-api-key");
	assert.deepEqual(await (await fetch(`${core.base}/providers`)).json(), { providers: [] });
	const saved = await put({
		...draft,
		models: [{ id: "model-a", maxTokens: 1024 }, { id: "model-b" }],
		defaultModel: "model-b",
	});
	assert.equal(saved.status, 200);
	const catalog = (await saved.json()) as ProviderCatalog;
	assert.equal(catalog.providers[0].name, "测试提供商");
	assert.equal(catalog.providers[0].models.length, 2);
	assert(catalog.providers[0].keyConfigured);
	assert(!JSON.stringify(catalog).includes("TEST_PROVIDER_KEY"));
	assert.equal(((await (await core.post("/sessions", { mode: "real" })).json()) as SessionSnapshot).model, "model-b");
	assert.equal(
		(
			(await (
				await core.post("/sessions", { mode: "real", model: { provider: draft.id, id: "model-a" } })
			).json()) as SessionSnapshot
		).model,
		"model-a",
	);
	for (const invalid of [
		{ ...draft, models: [] },
		{ ...draft, models: [{ id: "same" }, { id: "same" }] },
		{ ...draft, name: " ", models: [{ id: "model-a" }] },
		{ ...draft, models: [{ id: "model-a", maxTokens: 0 }] },
		{ ...draft, apiKey: false, models: [{ id: "model-a" }] },
		{ ...draft, models: [{ id: "model-a" }], defaultModel: "missing" },
	])
		assert.equal((await put(invalid)).status, 400);
	assert.equal((await put({ ...draft, apiKey: "", name: "已改名", models: [{ id: "model-a" }] })).status, 200);
	assert.equal(
		(await core.post("/sessions", { mode: "real", model: { provider: draft.id, id: "model-b" } })).status,
		400,
	);
	assert.equal((await core.post("/providers/discover", { ...draft, apiKey: "" })).status, 200);
	assert.equal(calls.at(-1)?.key, "Bearer private-api-key");
	const count = calls.length;
	assert.equal(
		(await core.post("/providers/discover", { ...draft, baseUrl: `${url}/other`, apiKey: "" })).status,
		400,
	);
	assert.equal(calls.length, count);
	for (const [api, path, ids] of [
		["openai-responses", "/responses", ["model-a", "model-b"]],
		["anthropic-messages", "/anthropic", ["claude-a", "claude-b"]],
		["google-generative-ai", "/google", ["gemini-a", "gemini-b"]],
	] as const) {
		const result = await core.post("/providers/discover", { ...draft, api, baseUrl: `${url}${path}` });
		assert.equal(result.status, 200);
		assert.deepEqual(await result.json(), { models: ids.map((id) => ({ id })) });
		assert.equal(calls.at(-1)?.key, api === "openai-responses" ? "Bearer private-api-key" : "private-api-key");
	}
	for (const path of ["/redirect", "/invalid", "/error"]) {
		const result = await core.post("/providers/discover", { ...draft, baseUrl: `${url}${path}` });
		assert.equal(result.status, 400);
		assert(!(await result.text()).includes("private-api-key"));
	}
	assert(!calls.some((call) => call.path === "/leak/models"));
	const secured = await start({ PI_SERVER_TOKEN: "test-token" });
	t.after(() => secured.close());
	assert.equal((await secured.post("/providers/discover", draft)).status, 401);
	assert.equal(
		(await fetch(`${core.base}/providers/config`, { method: "PUT", headers: { Origin: "https://example.com" } }))
			.status,
		403,
	);
});
