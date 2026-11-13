import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("copied DeepSeek fetch extension validates requests, results and transport limits", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie deepseek fetch "));
	await copyFile(
		fileURLToPath(new URL("../../../examples/tools/deepseek-web-fetch.ts", import.meta.url)),
		join(directory, "deepseek-web-fetch.ts"),
	);
	const secret = "deepseek-fetch-fixture-secret";
	const env = { PI_DATA_DIR: join(directory, "data"), PI_TOOLS_DIR: directory, DEEPSEEK_API_KEY: secret };
	let body = JSON.stringify({ title: "测试页面", content: "# 页面标题\n\n网页正文" });
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
				if (stall === "body") response.write('{"title":"');
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
		assert.equal(String(input), "https://api.deepseek.com/v1/tools/fetch");
		assert.equal(init?.redirect, "error");
		return originalFetch(`http://127.0.0.1:${address.port}/v1/tools/fetch`, init);
	});
	const create = loadExternalTools(env, []).get("deepseek-web-fetch");
	assert(create);
	const approvals: Omit<Parameters<ToolContext["ask"]>[0], "id">[] = [];
	const context: ToolContext = {
		sessionId: "deepseek-fetch-test",
		directory,
		env,
		Type,
		ask: async (request) => {
			approvals.push(request);
		},
	};
	const tool = create(context);
	assert.equal(calls.length, 0, "loading and creating tools must not use the API");

	await t.test("registers and enables only through toolIds", async () => {
		const agents = createAgentFactory(env);
		assert(agents.toolCatalog.some((entry) => entry.id === tool.name));
		const runtime = { systemPrompt: "", skills: [], subagents: [], permissions: { webfetch: "allow" as const } };
		const disabled = agents.create("faux", "disabled", { ...runtime, toolIds: [] });
		assert(!disabled.state.tools.some((entry) => entry.name === tool.name));
		const enabled = agents.create("faux", "enabled", { ...runtime, toolIds: [tool.name] });
		assert(enabled.state.tools.some((entry) => entry.name === "tool_search"));
	});

	await t.test("sends the official request and returns Markdown content", async () => {
		const url = "https://example.com/article";
		const result = await tool.execute("fetch", { url });
		assert.deepEqual(calls.at(-1), {
			method: "POST",
			authorization: `Bearer ${secret}`,
			contentType: "application/json",
			body: { url },
		});
		assert.equal(approvals.at(-1)?.metadata?.permission, "webfetch");
		assert.equal(approvals.at(-1)?.metadata?.provider, "deepseek");
		assert.deepEqual(approvals.at(-1)?.metadata?.resources, [url]);
		assert.equal(result.details.title, "测试页面");
		assert.equal(result.details.contentEmpty, false);
		assert.equal(result.details.truncated, false);
		assert.match(JSON.stringify(result.content), /网页正文/);
		assert(!JSON.stringify(result).includes(secret));
	});

	await t.test("validates URL boundaries before transport", async () => {
		for (const args of [{}, { url: "" }, { url: "x".repeat(8193) }]) {
			assert.throws(
				() => validateToolArguments(tool, fauxToolCall(tool.name, args)),
				`Expected invalid parameters: ${JSON.stringify(args)}`,
			);
		}
		const before = calls.length;
		for (const url of ["ftp://example.com/file", "https://user:pass@example.com/private", "https://"]) {
			await assert.rejects(tool.execute("invalid", { url }));
		}
		assert.equal(calls.length, before);
	});

	await t.test("missing credentials, denied permission and cancellation never reach transport", async () => {
		const before = calls.length;
		const missing = create({ ...context, env: {} });
		await assert.rejects(missing.execute("missing", { url: "https://example.com" }), /DEEPSEEK_API_KEY/);
		const denied = create({
			...context,
			ask: async () => {
				throw new Error("fetch denied");
			},
		});
		await assert.rejects(denied.execute("denied", { url: "https://example.com" }), /fetch denied/);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tool.execute("cancelled", { url: "https://example.com" }, controller.signal), {
			name: "AbortError",
		});
		assert.equal(calls.length, before);
	});

	await t.test("reports empty content and redacted HTTP errors", async () => {
		body = JSON.stringify({ title: "", content: "" });
		const empty = await tool.execute("empty", { url: "https://example.com/empty" });
		assert.equal(empty.details.contentEmpty, true);
		for (status of [401, 402, 403, 404, 408, 429, 500]) {
			body = JSON.stringify({ error: { message: `upstream error ${secret}` } });
			await assert.rejects(tool.execute("failed", { url: "https://example.com" }), (error: unknown) => {
				assert(error instanceof Error);
				assert.match(error.message, new RegExp(String(status)));
				assert(!error.message.includes(secret));
				return true;
			});
		}
		status = 200;
		body = JSON.stringify({ title: "测试页面", content: "# 页面标题\n\n网页正文" });
	});

	await t.test("rejects malformed successful responses", async () => {
		for (const invalid of ["not JSON", "{}", '{"title":null,"content":"x"}', '{"title":"x","content":null}']) {
			body = invalid;
			await assert.rejects(tool.execute("invalid", { url: "https://example.com" }), /JSON|格式无效/);
		}
		body = JSON.stringify({ title: "测试页面", content: "# 页面标题\n\n网页正文" });
	});

	await t.test("preserves long Unicode content through native read pagination", async () => {
		const marker = "unique-fetch-content-after-preview";
		const content = `正文第一行\n${"\u{1F600}".repeat(30_000)}\n${marker}`;
		body = JSON.stringify({ title: "长页面", content });
		const result = await tool.execute("long", { url: "https://example.com/long" });
		assert.equal(result.details.truncated, true);
		assert.equal(typeof result.details.logPath, "string");
		const logPath: string = result.details.logPath;
		t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
		const saved = await readFile(logPath, "utf8");
		assert(saved.includes(marker));
		assert(saved.includes("长页面"));
		assert(result.content[0].type === "text");
		assert(!result.content[0].text.includes("\uFFFD"));
		assert(result.content[0].text.includes(logPath));
		assert(!result.content[0].text.includes(marker));
		const read = systemTools(env, directory).find((entry) => entry.name === "read");
		assert(read);
		const pages: string[] = [];
		for (let offset = 1; offset <= saved.trimEnd().split("\n").length; offset += 5) {
			const page = await read.execute("read-fetch", { path: logPath, offset, limit: 5 });
			assert(page.content[0].type === "text");
			assert(!page.content[0].text.includes("line truncated"));
			assert(!page.content[0].text.includes("\uFFFD"));
			pages.push(page.content[0].text);
		}
		assert(pages.slice(1).some((page) => page.includes(marker)));
	});

	await t.test("rejects oversized responses", async () => {
		declaredSize = 5 * 1024 * 1024 + 1;
		body = "small";
		await assert.rejects(tool.execute("declared", { url: "https://example.com" }), /5 MiB/);
		declaredSize = undefined;
		body = JSON.stringify({ title: "大页面", content: "x".repeat(5 * 1024 * 1024) });
		await assert.rejects(tool.execute("streamed", { url: "https://example.com" }), /5 MiB/);
		body = JSON.stringify({ title: "测试页面", content: "# 页面标题\n\n网页正文" });
	});

	await t.test("cancels stalled headers and body reads", { timeout: 5_000 }, async () => {
		for (stall of ["headers", "body"] as const) {
			const received = new Promise<void>((resolve) => {
				receivedRequest = resolve;
			});
			const controller = new AbortController();
			const pending = assert.rejects(tool.execute("cancel", { url: "https://example.com" }, controller.signal), {
				name: "AbortError",
			});
			await received;
			controller.abort();
			await pending;
		}
		stall = undefined;
	});

	await t.test("the 30-second timeout covers stalled requests", { timeout: 5_000 }, async (st) => {
		const originalTimeout = AbortSignal.timeout;
		st.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
			assert.equal(milliseconds, 30_000);
			return originalTimeout(50);
		});
		for (stall of ["headers", "body"] as const) {
			await assert.rejects(tool.execute("timeout", { url: "https://example.com" }), { name: "TimeoutError" });
		}
		stall = undefined;
	});
});
