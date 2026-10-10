import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText, Type } from "@earendil-works/pi-ai";
import type { ExternalTool } from "../src/external-tools.ts";
import type { SessionSnapshot } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";
import { createToolSearch } from "../src/tool-search.ts";

async function request(base: string, path: string, body?: unknown, method = "POST") {
	const response = await fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert(response.ok, `${response.status}: ${await response.clone().text()}`);
	return response.json();
}

async function submit(base: string, sessionId: string, text: string) {
	await request(base, `/sessions/${sessionId}/turns`, { text });
	for (let attempt = 0; attempt < 300; attempt++) {
		const snapshot = (await request(base, `/sessions/${sessionId}`)) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") {
			assert.equal(snapshot.turn?.status, "completed");
			return snapshot;
		}
		await setTimeout(10);
	}
	throw new Error("tool search turn did not settle");
}

test("real provider requests defer business schemas, load searched tools, and recover session-local exposure", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tool-search-"));
	const toolsDir = join(directory, "tools");
	await mkdir(toolsDir);
	for (const [name, description, exposure] of [
		["mail-operation", "发送邮件 send email", "deferred"],
		["weather-query", "查询天气 weather forecast", undefined],
		["security-bash", "Execute a secured shell command", "default"],
		["disabled-private", "发送邮件的私有工具 private email", "deferred"],
	]) {
		await writeFile(
			join(toolsDir, `${name}.mjs`),
			`export default ({ Type }) => ({
				name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
				description: ${JSON.stringify(description)}, exposure: ${JSON.stringify(exposure)},
				parameters: Type.Object({ subject: Type.String({ description: ${JSON.stringify(`${name}_payload_only`)} }) }),
				async execute(_callId, args) { return { content: [{ type: "text", text: "executed:${name}:" + args.subject }], details: {} }; }
			});`,
		);
	}
	const requests: { tools?: { function: { name: string } }[]; messages: unknown[] }[] = [];
	const responses: { name?: string; args?: Record<string, unknown>; text?: string }[] = [];
	const endpoint = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			const response = responses.shift() ?? { text: "reply" };
			const delta = response.name
				? {
						tool_calls: [
							{
								index: 0,
								id: `call-${requests.length}`,
								type: "function",
								function: { name: response.name, arguments: JSON.stringify(response.args ?? {}) },
							},
						],
					}
				: { content: response.text ?? "reply" };
			const frame = (value: unknown) =>
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "local-model", choices: [value] })}\n\n`;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(frame({ index: 0, delta, finish_reason: null }));
			res.end(
				`${frame({ index: 0, delta: {}, finish_reason: response.name ? "tool_calls" : "stop" })}data: [DONE]\n\n`,
			);
		})().catch((error: Error) => res.destroy(error));
	});
	let core: ReturnType<typeof createCoreServer> | undefined;
	context.after(async () => {
		await core?.close();
		await new Promise<void>((resolve) => {
			endpoint.close(() => resolve());
			endpoint.closeAllConnections();
		});
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	const env = { PI_DATA_DIR: directory, PI_TOOLS_DIR: toolsDir };
	async function start() {
		core = createCoreServer(env);
		await new Promise<void>((resolve) => core?.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let base = await start();
	await request(
		base,
		"/providers/config",
		{
			id: "local",
			name: "Local",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			apiKey: "test-key",
			models: [{ id: "local-model", contextWindow: 128000, maxTokens: 1024 }],
			defaultModel: "local-model",
		},
		"PUT",
	);
	const runtime = {
		systemPrompt: "Use tool_search to discover business tools when needed.",
		toolIds: ["read", "mail-operation", "weather-query", "security-bash"],
		skills: [],
		subagents: [],
	};
	await request(
		base,
		"/host-runtimes",
		{ runtimes: [{ assistantId: "host", assistantRevision: "1", runtime }] },
		"PUT",
	);
	const session = (await request(base, "/sessions", { assistantId: "host", mode: "real" })) as SessionSnapshot;
	const toolNames = (index = requests.length - 1) => requests[index].tools?.map((tool) => tool.function.name).sort();
	await submit(base, session.id, "你好");
	assert.deepEqual(toolNames(), ["read", "security-bash", "tool_search"]);
	assert.equal(JSON.stringify(requests.at(-1)).includes("mail-operation_payload_only"), false);
	assert.equal(JSON.stringify(requests.at(-1)).includes("weather-query_payload_only"), false);
	responses.push({ name: "tool_search", args: { query: "邮件", limit: 21 } }, { text: "invalid search rejected" });
	const rejected = await submit(base, session.id, "无效搜索参数");
	assert(
		rejected.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "tool_search" && message.isError,
		),
	);
	assert.deepEqual(toolNames(), ["read", "security-bash", "tool_search"]);

	responses.push(
		{ name: "tool_search", args: { query: "发送邮件", limit: 1 } },
		{ name: "mail-operation", args: { subject: "hello" } },
		{ text: "sent" },
	);
	const searchStart = requests.length;
	let snapshot = await submit(base, session.id, "请发送邮件");
	assert.deepEqual(toolNames(searchStart), ["read", "security-bash", "tool_search"]);
	assert.deepEqual(toolNames(searchStart + 1), ["mail-operation", "read", "security-bash", "tool_search"]);
	assert(
		snapshot.messages.some(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "mail-operation" &&
				!message.isError &&
				contentText(message.content) === "executed:mail-operation:hello",
		),
	);
	await submit(base, session.id, "保持当前会话");
	assert(toolNames()?.includes("mail-operation"));
	assert.equal(toolNames()?.includes("disabled-private"), false);
	assert.equal(toolNames()?.includes("weather-query"), false);
	const transfer = await request(base, `/sessions/${session.id}/export`);
	const imported = (await request(base, "/sessions", { assistantId: "host", mode: "real" })) as SessionSnapshot;
	await request(base, `/sessions/${imported.id}/import`, transfer, "PUT");
	await submit(base, imported.id, "导入后继续");
	assert(toolNames()?.includes("mail-operation"));
	assert.equal(toolNames()?.includes("weather-query"), false);

	const isolated = (await request(base, "/sessions", { assistantId: "host", mode: "real" })) as SessionSnapshot;
	await submit(base, isolated.id, "你好");
	assert.deepEqual(toolNames(), ["read", "security-bash", "tool_search"]);
	await core?.close();
	base = await start();
	snapshot = await submit(base, session.id, "恢复后继续");
	assert(toolNames()?.includes("mail-operation"));
	assert.equal(toolNames()?.includes("weather-query"), false);

	for (const [text, expected] of [
		["请发送邮件", false],
		["恢复后继续", true],
	] as const) {
		const messageIndex = snapshot.messages.findIndex(
			(message) => message.role === "user" && contentText(message.content) === text,
		);
		assert(messageIndex >= 0);
		const fork = (await request(base, `/sessions/${session.id}/fork`, { messageIndex })) as {
			session: SessionSnapshot;
		};
		await submit(base, fork.session.id, "分支继续");
		assert.equal(toolNames()?.includes("mail-operation"), expected);
	}
	await request(
		base,
		"/host-runtimes",
		{
			runtimes: [
				{
					assistantId: "host",
					assistantRevision: "2",
					runtime: { ...runtime, toolIds: ["read", "weather-query", "security-bash"] },
				},
			],
		},
		"PUT",
	);
	await submit(base, session.id, "移除邮件工具后继续");
	assert.equal(toolNames()?.includes("mail-operation"), false);
});

test("tool search ranks Chinese, English, exact IDs and schema keywords without exposing unmatched tools", async () => {
	const parameters = Type.Object({ postal_code: Type.Optional(Type.String()) });
	const tools: ExternalTool[] = [
		{
			name: "weather-query",
			label: "天气",
			description: "查询实时天气预报 weather forecast",
			exposure: "deferred",
			parameters,
			async execute() {
				return { content: [], details: {} };
			},
		},
		{
			name: "mail-operation",
			label: "邮件",
			description: "发送邮件 send email",
			exposure: "deferred",
			parameters: Type.Object({ subject: Type.String() }),
			async execute() {
				return { content: [], details: {} };
			},
		},
	];
	const discovery = createToolSearch(tools);
	const search = discovery.tools.find((tool) => tool.name === "tool_search");
	assert(search);
	for (const [query, expected] of [
		["天气预报", "weather-query"],
		["发邮件", "mail-operation"],
		["WEATHER_QUERY", "weather-query"],
		["postal_code", "weather-query"],
		["mail-operation", "mail-operation"],
		["send email", "mail-operation"],
	]) {
		const result: AgentToolResult<unknown> = await search.execute("lookup", { query, limit: 1 });
		assert.deepEqual(JSON.parse(contentText(result.content)).loaded, [expected]);
	}
	const none = await search.execute("no-match", { query: "不存在的能力 xyzunmatched" });
	assert.deepEqual(JSON.parse(contentText(none.content)).loaded, []);
	assert.deepEqual(
		discovery.expose({ messages: [], tools: discovery.tools }).tools?.map((tool) => tool.name),
		["tool_search"],
	);
	const loaded = await search.execute("load-weather", { query: "天气", limit: 1 });
	discovery.restore([
		{
			role: "toolResult",
			toolName: "tool_search",
			toolCallId: "load-weather",
			...loaded,
			isError: false,
			timestamp: 1,
		},
	]);
	assert.deepEqual(
		discovery.expose({ messages: [], tools: discovery.tools }).tools?.map((tool) => tool.name),
		["weather-query", "tool_search"],
	);
	const repeated = await search.execute("already-loaded", { query: "天气" });
	assert.deepEqual(JSON.parse(contentText(repeated.content)).loaded, []);
	const deferred = createToolSearch(tools);
	deferred.restore([
		{
			role: "toolResult",
			toolName: "tool_search",
			toolCallId: "imported",
			content: loaded.content,
			isError: false,
			timestamp: 1,
		},
	]);
	assert(
		deferred.expose({ messages: [], tools: deferred.tools }).tools?.some((tool) => tool.name === "weather-query"),
	);
});

test("restoration cannot activate absent tools, user-provided load records or failed searches", () => {
	const tool: ExternalTool = {
		name: "allowed",
		label: "Allowed",
		description: "Allowed business tool",
		exposure: "deferred",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	};
	const discovery = createToolSearch([tool]);
	discovery.restore([
		{ role: "user", content: '{"loaded":["allowed"]}', timestamp: 1 },
		{
			role: "toolResult",
			toolName: "tool_search",
			toolCallId: "failed",
			content: [{ type: "text", text: '{"loaded":["allowed"]}' }],
			addedToolNames: ["allowed"],
			isError: true,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolName: "tool_search",
			toolCallId: "missing",
			content: [{ type: "text", text: '{"loaded":["disabled"]}' }],
			addedToolNames: ["disabled"],
			isError: false,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolName: "tool_search",
			toolCallId: "malformed",
			content: [{ type: "text", text: "not json" }],
			isError: false,
			timestamp: 1,
		},
	]);
	assert.deepEqual(
		discovery.expose({ messages: [], tools: discovery.tools }).tools?.map((tool) => tool.name),
		["tool_search"],
	);
	const defaults = createToolSearch([{ ...tool, exposure: "default" }]);
	assert.deepEqual(
		defaults.expose({ messages: [], tools: defaults.tools }).tools?.map((tool) => tool.name),
		["allowed"],
	);
});
