import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxToolCall, Type, validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/local/agent";
import { loadExternalTools } from "@pie/local/external-tools";
import { systemTools } from "@pie/local/tools";
import type { ToolContext } from "@pie/runtime/tools";

test("copied DeepSeek search extension validates requests, results, permissions and transport limits", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie deepseek tools "));
	await copyFile(
		fileURLToPath(new URL("../../../examples/tools/deepseek-web-search.ts", import.meta.url)),
		join(directory, "deepseek-web-search.ts"),
	);
	await writeFile(
		join(directory, "env-probe.ts"),
		`import type { AgentTool } from "@earendil-works/pi-agent-core";\nimport type { ToolContext } from "@pie/runtime/tools";\nexport default function createProbe({ Type, env }: ToolContext) {\n  const parameters = Type.Object({}, { additionalProperties: false });\n  const tool: AgentTool<typeof parameters> = { name: "env-probe", label: "环境探针", description: "测试环境隔离", parameters, async execute() { return { content: [{ type: "text", text: env.DEEPSEEK_API_KEY ? "leaked" : "clean" }] }; } };\n  return tool;\n}\n`,
	);
	const secret = "deepseek-fixture-secret";
	const env = { PI_DATA_DIR: join(directory, "data"), PI_TOOLS_DIR: directory, DEEPSEEK_API_KEY: secret };
	const hit = {
		rerank_score: 2.4,
		title: "搜索结果",
		url: "https://example.com/article",
		snippet: "短摘要",
		summary: "供模型阅读的摘要",
		content: "网页正文",
		site_name: null,
		site_icon: null,
		date: null,
		authority: -1,
	};
	let body = JSON.stringify({ results: [hit] });
	let status = 200;
	let declaredSize: number | undefined;
	let stall: "headers" | "body" | undefined;
	let receivedRequest = () => {};
	const calls: { method?: string; authorization?: string; contentType?: string; body: unknown }[] = [];
	const service = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			calls.push({
				method: request.method,
				authorization: request.headers.authorization,
				contentType: request.headers["content-type"],
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			if (stall !== "headers") {
				response.writeHead(status, {
					"Content-Type": "application/json",
					...(declaredSize === undefined ? {} : { "Content-Length": declaredSize }),
				});
				if (stall === "body") response.write('{"results":');
				else {
					response.write(body);
					response.end();
				}
			}
			receivedRequest();
		})().catch((error: Error) => response.destroy(error));
	});
	t.after(async () => {
		service.closeAllConnections();
		await new Promise<void>((resolve) => service.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	const address = service.address();
	assert(address && typeof address !== "string");
	const originalFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(input), "https://api.deepseek.com/v1/tools/search");
		assert.equal(init?.redirect, "error");
		return originalFetch(`http://127.0.0.1:${address.port}/v1/tools/search`, init);
	});
	const create = loadExternalTools(env, []).get("deepseek-web-search");
	assert(create);
	const approvals: Omit<Parameters<ToolContext["ask"]>[0], "id">[] = [];
	const context: ToolContext = {
		sessionId: "deepseek-test",
		directory,
		env,
		Type,
		ask: async (request) => {
			approvals.push(request);
		},
	};
	const tool = create(context);
	assert.equal(calls.length, 0, "loading and creating tools must not use the API");

	await t.test("registers the copied module and enables it only through toolIds", async () => {
		const agents = createAgentFactory(env);
		assert(agents.toolCatalog.some((entry) => entry.id === tool.name));
		assert(!JSON.stringify(agents.toolCatalog).includes(secret));
		const runtime = { systemPrompt: "", skills: [], subagents: [], permissions: { websearch: "allow" as const } };
		const disabled = agents.create("faux", "disabled", { ...runtime, toolIds: [] });
		assert(!disabled.state.tools.some((entry) => entry.name === tool.name));
		const enabled = agents.create("faux", "enabled", { ...runtime, toolIds: [tool.name] });
		assert(enabled.state.tools.some((entry) => entry.name === "tool_search"));
		await enabled.prompt(`调用工具 ${tool.name} {"query":"Pie Core"}`);
		const result = enabled.state.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError);
		assert.match(JSON.stringify(result.content), /搜索结果/);
		assert.equal(calls.length, 1);
	});

	await t.test("uses the stored DeepSeek provider key when the process environment is empty", async () => {
		const storedData = join(directory, "stored model data");
		await mkdir(storedData);
		await writeFile(
			join(storedData, "models.json"),
			JSON.stringify({
				providers: {
					deepseek: {
						name: "DeepSeek",
						api: "openai-completions",
						baseUrl: "https://api.deepseek.com",
						apiKey: "stored-deepseek-key",
					},
				},
			}),
		);
		const storedAgents = createAgentFactory({ PI_DATA_DIR: storedData, PI_TOOLS_DIR: directory });
		const runtime = { systemPrompt: "", skills: [], subagents: [], permissions: { websearch: "allow" as const } };
		const stored = storedAgents.create("faux", "stored-key", { ...runtime, toolIds: [tool.name] });
		await stored.prompt(`调用工具 ${tool.name} {"query":"stored key"}`);
		assert.equal(calls.at(-1)?.authorization, "Bearer stored-deepseek-key");
		const probe = storedAgents.create("faux", "stored-key-probe", { ...runtime, toolIds: ["env-probe"] });
		await probe.prompt("调用工具 env-probe {}");
		const probeResult = probe.state.messages.find((message) => message.role === "toolResult");
		assert(probeResult?.role === "toolResult");
		assert.match(JSON.stringify(probeResult.content), /clean/);
	});

	await t.test("preserves search syntax and optional fields with server-only Bearer authentication", async () => {
		const args = {
			query: 'DeepSeek "release notes" site:github.com lang:zh,en after:2026-01-01',
			count: 5,
			ori_question: "DeepSeek 最近更新了什么？",
			localization: "1.1.1.1",
			need_content: true,
		};
		const before = calls.length;
		const result = await tool.execute("search", args);
		assert.equal(calls.length, before + 1);
		assert.deepEqual(calls.at(-1), {
			method: "POST",
			authorization: `Bearer ${secret}`,
			contentType: "application/json",
			body: args,
		});
		assert.equal(approvals.at(-1)?.metadata?.permission, "websearch");
		assert.equal(approvals.at(-1)?.metadata?.provider, "deepseek");
		assert.deepEqual(approvals.at(-1)?.metadata?.resources, [args.query]);
		assert.equal(result.details.query, args.query);
		assert.equal(result.details.count, 1);
		assert.equal(result.details.truncated, false);
		assert.match(JSON.stringify(result.content), /example.com\/article/);
		assert.match(JSON.stringify(result.content), /网页正文/);
		assert(!JSON.stringify(result).includes(secret));
		await tool.execute("defaults", { query: "DeepSeek", ori_question: null });
		assert.deepEqual(calls.at(-1)?.body, {
			query: "DeepSeek",
			count: 10,
			ori_question: null,
			need_content: false,
		});
	});

	await t.test("validates official parameter boundaries before transport", async () => {
		for (const args of [
			{},
			{ query: "" },
			{ query: "x".repeat(129) },
			{ query: "DeepSeek", count: 0 },
			{ query: "DeepSeek", count: 51 },
			{ query: "DeepSeek", ori_question: "x".repeat(129) },
			{ query: "DeepSeek", unknown: true },
		]) {
			assert.throws(
				() => validateToolArguments(tool, fauxToolCall(tool.name, args)),
				`Expected invalid parameters: ${JSON.stringify(args)}`,
			);
		}
		const unicode = { query: "\u{1F600}".repeat(128), count: 50, ori_question: null };
		assert.deepEqual(validateToolArguments(tool, fauxToolCall(tool.name, unicode)), unicode);
		const before = calls.length;
		await assert.rejects(tool.execute("whitespace", { query: " \t\n " }));
		assert.equal(calls.length, before);
	});

	await t.test("missing credentials, denied permission and pre-cancellation never reach transport", async () => {
		const before = calls.length;
		const missing = create({ ...context, env: {} });
		await assert.rejects(missing.execute("missing", { query: "DeepSeek" }), /DEEPSEEK_API_KEY/);
		const denied = create({
			...context,
			ask: async () => {
				throw new Error("search denied");
			},
		});
		await assert.rejects(denied.execute("denied", { query: "DeepSeek" }), /search denied/);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tool.execute("cancelled", { query: "DeepSeek" }, controller.signal), { name: "AbortError" });
		assert.equal(calls.length, before);
	});

	await t.test(
		"empty searches succeed; HTTP failures retain status without exposing credentials or retrying",
		async () => {
			body = '{"results":[]}';
			const empty = await tool.execute("empty", { query: "DeepSeek" });
			assert.equal(empty.details.count, 0);
			for (status of [401, 402, 429, 500]) {
				body = JSON.stringify({ error: { message: `upstream error ${secret}`, code: "fixture_error" } });
				const before = calls.length;
				await assert.rejects(tool.execute("failed", { query: "DeepSeek" }), (error: unknown) => {
					assert(error instanceof Error);
					assert(error.message.includes(String(status)));
					assert(!error.message.includes(secret));
					return true;
				});
				assert.equal(calls.length, before + 1);
			}
			body = JSON.stringify({ error: { message: `${"x".repeat(500)}${secret}` } });
			await assert.rejects(tool.execute("truncated-error", { query: "DeepSeek" }), (error: unknown) => {
				assert(error instanceof Error);
				assert(error.message.includes("500"));
				assert(error.message.includes("[REDACTED]"));
				assert(!error.message.includes(secret.slice(0, 12)));
				return true;
			});
			status = 200;
		},
	);

	await t.test("invalid JSON and malformed result fields are errors, never successful empty searches", async () => {
		for (const invalid of [
			"not JSON",
			"{}",
			'{"results":null}',
			JSON.stringify({ results: [{ ...hit, summary: null }] }),
			JSON.stringify({ results: [{ ...hit, rerank_score: 4 }] }),
			JSON.stringify({ results: [{ ...hit, authority: 5 }] }),
			JSON.stringify({ results: [{ ...hit, site_name: 123 }] }),
		]) {
			body = invalid;
			await assert.rejects(tool.execute("invalid", { query: "DeepSeek" }));
		}
	});

	await t.test("long Unicode results retain their full content through native read pagination", async () => {
		const marker = "unique-search-content-after-preview";
		const longHit = { ...hit, content: `正文第一行\n${"\u{1F600}".repeat(30_000)}\n${marker}` };
		body = JSON.stringify({ results: [longHit] });
		const result = await tool.execute("long", { query: "DeepSeek", need_content: true });
		assert.equal(result.details.truncated, true);
		assert.equal(typeof result.details.logPath, "string");
		const logPath: string = result.details.logPath;
		t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
		const saved = await readFile(logPath, "utf8");
		assert(saved.replaceAll("\n", "").includes(longHit.content.replaceAll("\n", "")));
		assert(saved.includes(hit.url));
		assert(saved.includes(marker));
		assert(result.content[0].type === "text");
		assert(Buffer.byteLength(result.content[0].text) < 50 * 1024 + 1024);
		assert(!result.content[0].text.includes("\uFFFD"));
		assert(result.content[0].text.includes(logPath));
		assert(!result.content[0].text.includes(marker));
		const read = systemTools(env, directory).find((entry) => entry.name === "read");
		assert(read);
		const pages: string[] = [];
		for (let offset = 1; offset <= saved.trimEnd().split("\n").length; offset += 5) {
			const page = await read.execute("read-search", { path: logPath, offset, limit: 5 });
			assert(page.content[0].type === "text");
			assert(!page.content[0].text.includes("line truncated"));
			assert(!page.content[0].text.includes("\uFFFD"));
			pages.push(page.content[0].text);
		}
		assert(!pages[0].includes(marker));
		assert(pages.slice(1).some((page) => page.includes(marker)));
	});

	await t.test("rejects oversized declared and streamed response bodies", async () => {
		for (const declared of [true, false]) {
			declaredSize = declared ? 5 * 1024 * 1024 + 1 : undefined;
			body = declared ? "small" : JSON.stringify({ results: [{ ...hit, content: "x".repeat(5 * 1024 * 1024) }] });
			await assert.rejects(tool.execute("oversized", { query: "DeepSeek" }), /5 MiB/);
		}
		declaredSize = undefined;
	});

	await t.test("cancels stalled headers and body reads", { timeout: 5_000 }, async () => {
		for (stall of ["headers", "body"] as const) {
			const received = new Promise<void>((resolve) => {
				receivedRequest = resolve;
			});
			const controller = new AbortController();
			const pending = assert.rejects(tool.execute("cancel", { query: "DeepSeek" }, controller.signal), {
				name: "AbortError",
			});
			await received;
			controller.abort();
			await pending;
		}
		stall = undefined;
	});

	await t.test("the 30-second timeout covers stalled headers and response bodies", { timeout: 5_000 }, async (st) => {
		const originalTimeout = AbortSignal.timeout;
		st.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
			assert.equal(milliseconds, 30_000);
			return originalTimeout(50);
		});
		for (stall of ["headers", "body"] as const) {
			await assert.rejects(tool.execute("timeout", { query: "DeepSeek" }), { name: "TimeoutError" });
		}
		stall = undefined;
	});
});
