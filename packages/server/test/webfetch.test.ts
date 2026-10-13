import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { type TestContext, test } from "node:test";
import { fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { BackgroundJobs } from "../src/tools/jobs.ts";
import type { ToolRuntime } from "../src/tools/runtime.ts";
import { MAX_BYTES } from "../src/tools/shared.ts";
import {
	convertHTMLToMarkdown,
	extractTextFromHTML,
	MAX_RESPONSE_BYTES,
	MAX_TIMEOUT_SECONDS,
	webFetchTool,
} from "../src/tools/webfetch.ts";
import { systemTools } from "../src/tools.ts";

function createTool(ask: ToolRuntime["ask"] = async () => {}) {
	return webFetchTool({ sessionId: "webfetch-test", directory: tmpdir(), jobs: new BackgroundJobs(), ask });
}

async function serve(context: TestContext, handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

test("webfetch is native and validates the Amio URL, format and timeout contract", () => {
	assert(systemTools({}).some((tool) => tool.name === "webfetch"));
	const tool = createTool();
	const url = "https://example.com";
	assert.deepEqual(validateToolArguments(tool, fauxToolCall("webfetch", { url })), { url });
	for (const format of ["text", "markdown", "html"]) {
		assert.deepEqual(validateToolArguments(tool, fauxToolCall("webfetch", { url, format, timeout: 0.5 })), {
			url,
			format,
			timeout: 0.5,
		});
	}
	for (const timeout of [0, -1, MAX_TIMEOUT_SECONDS + 1]) {
		assert.throws(() => validateToolArguments(tool, fauxToolCall("webfetch", { url, timeout })));
	}
	assert.throws(() => validateToolArguments(tool, fauxToolCall("webfetch", { url, format: "pdf" })));
});

test("HTML conversion preserves Amio Markdown options and excludes non-content text", () => {
	const html = "<h1>Hello</h1><p>world &amp; 中文</p><script>bad()</script><style>hidden</style>";
	assert.equal(convertHTMLToMarkdown(html), "# Hello\n\nworld & 中文");
	assert.equal(extractTextFromHTML(html), "Helloworld & 中文");
	assert.equal(extractTextFromHTML("before<noscript>skip</noscript><iframe><b>skip</b></iframe>after"), "beforeafter");
	assert.equal(
		convertHTMLToMarkdown('<p><a href="https://example.com">source</a></p>'),
		"[source](https://example.com)",
	);
});

test("webfetch approves the requested URL before transport and follows redirects", async (context) => {
	const requests: string[] = [];
	const base = await serve(context, (request, response) => {
		requests.push(request.url ?? "");
		if (request.url === "/redirect") {
			response.writeHead(302, { location: "/target" });
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<h1>Hello</h1><p>world</p>");
	});
	const approvals: Record<string, unknown>[] = [];
	const tool = createTool(async (request) => {
		assert.equal(requests.length, 0);
		approvals.push(request.metadata ?? {});
	});
	const url = `${base}/redirect`;
	const result = await tool.execute("fetch", { url });
	assert.deepEqual(result.content, [{ type: "text", text: "# Hello\n\nworld" }]);
	assert.deepEqual(result.details, {
		url,
		contentType: "text/html; charset=utf-8",
		format: "markdown",
		truncated: false,
		outputPath: undefined,
	});
	assert.deepEqual(requests, ["/redirect", "/target"]);
	assert.deepEqual(approvals, [{ permission: "webfetch", resources: [url], url, format: "markdown", timeout: 30 }]);
});

test("webfetch returns all formats, textual MIME types and streamed UTF-8", async (context) => {
	const html = "<h1>Hello</h1><p>world</p><script>bad()</script>";
	const accepts: string[] = [];
	const base = await serve(context, (request, response) => {
		accepts.push(request.headers.accept ?? "");
		if (request.url === "/unicode") {
			response.writeHead(200, { "content-type": "text/plain" });
			const bytes = Buffer.from("网页验证");
			response.write(bytes.subarray(0, 2));
			response.end(bytes.subarray(2));
			return;
		}
		const mime = request.url === "/json" ? "application/problem+json" : "text/html";
		response.writeHead(200, { "content-type": mime });
		response.end(request.url === "/json" ? '{"ok":true}' : html);
	});
	const tool = createTool();
	for (const [format, expected] of [
		["markdown", "# Hello\n\nworld"],
		["text", "Helloworld"],
		["html", html],
	] as const) {
		const result = await tool.execute("fetch", { url: base, format });
		assert.deepEqual(result.content, [{ type: "text", text: expected }]);
	}
	assert.match(accepts[0], /^text\/markdown/);
	assert.match(accepts[1], /^text\/plain/);
	assert.match(accepts[2], /^text\/html/);
	assert.deepEqual((await tool.execute("json", { url: `${base}/json` })).content, [
		{ type: "text", text: '{"ok":true}' },
	]);
	assert.deepEqual((await tool.execute("unicode", { url: `${base}/unicode` })).content, [
		{ type: "text", text: "网页验证" },
	]);
});

test("invalid URLs and denied permissions never reach transport", async (context) => {
	let requests = 0;
	let approvals = 0;
	const base = await serve(context, (_request, response) => {
		requests++;
		response.end("unexpected");
	});
	const tool = createTool(async () => {
		approvals++;
		throw new Error("denied");
	});
	for (const url of ["file:///etc/passwd", "ftp://example.com", "not-a-url"]) {
		await assert.rejects(tool.execute("invalid", { url }), /http:\/\/ or https:\/\/|Invalid URL/);
	}
	assert.equal(approvals, 0);
	await assert.rejects(tool.execute("denied", { url: base }), /denied/);
	assert.equal(approvals, 1);
	assert.equal(requests, 0);
});

test("Cloudflare challenges retry once with the Amio user agent; other failures do not retry", async (context) => {
	const agents: string[] = [];
	const base = await serve(context, (request, response) => {
		agents.push(request.headers["user-agent"] ?? "");
		if (request.url === "/challenge" && request.headers["user-agent"] === "opencode") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
			return;
		}
		response.writeHead(403, request.url === "/forbidden" ? {} : { "cf-mitigated": "challenge" });
		response.end("denied");
	});
	const tool = createTool();
	assert.deepEqual((await tool.execute("challenge", { url: `${base}/challenge` })).content, [
		{ type: "text", text: "ok" },
	]);
	assert.match(agents[0], /Mozilla\/5.0/);
	assert.equal(agents[1], "opencode");
	await assert.rejects(tool.execute("forbidden", { url: `${base}/forbidden` }), /status code: 403/);
	assert.equal(agents.length, 3);
	await assert.rejects(tool.execute("still-challenged", { url: `${base}/still-challenged` }), /status code: 403/);
	assert.equal(agents.length, 5);
});

test("declared and streamed response sizes are bounded, and binary content is rejected", async (context) => {
	const base = await serve(context, (request, response) => {
		if (request.url === "/declared") {
			response.writeHead(200, { "content-type": "text/plain", "content-length": MAX_RESPONSE_BYTES + 1 });
			response.end("small");
		} else if (request.url === "/streamed") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write(Buffer.alloc(MAX_RESPONSE_BYTES, "x"));
			response.end("x");
		} else {
			response.writeHead(200, { "content-type": request.url === "/image" ? "image/png" : "application/pdf" });
			response.end("binary");
		}
	});
	const tool = createTool();
	for (const path of ["declared", "streamed"]) {
		await assert.rejects(tool.execute(path, { url: `${base}/${path}` }), /Response too large/);
	}
	await assert.rejects(tool.execute("image", { url: `${base}/image` }), /Unsupported fetched image/);
	await assert.rejects(tool.execute("file", { url: `${base}/file` }), /Unsupported fetched file/);
});

test("large output has a bounded model preview and retains the complete result", async (context) => {
	const lines = "line\n".repeat(MAX_RESPONSE_BYTES / 5);
	const singleLine = "网页".repeat(50_000);
	const base = await serve(context, (request, response) => {
		const output = request.url === "/single" ? singleLine : lines;
		response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(output) });
		response.end(output);
	});
	for (const [path, output] of [
		["/lines", lines],
		["/single", singleLine],
	]) {
		const result = await createTool().execute("large", { url: `${base}${path}` });
		assert.equal(result.details.truncated, true);
		const outputPath = result.details.outputPath;
		assert(outputPath);
		const outputDirectory = dirname(outputPath);
		assert.equal(dirname(outputDirectory), tmpdir());
		assert(basename(outputDirectory).startsWith("pie-webfetch-"));
		context.after(() => rm(outputDirectory, { recursive: true, force: true }));
		assert.equal(await readFile(outputPath, "utf8"), output);
		assert(result.content[0].type === "text");
		assert.match(result.content[0].text, /^line|^网页/);
		assert.doesNotMatch(result.content[0].text, /\uFFFD/);
		assert.match(result.content[0].text, /Full output saved to:/);
		assert(Buffer.byteLength(result.content[0].text) < MAX_BYTES + 1024);
	}
});

test("timeouts cover stalled response headers and body consumption", async (context) => {
	const base = await serve(context, (request, response) => {
		if (request.url === "/body") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write("partial");
		}
	});
	for (const path of ["headers", "body"]) {
		await assert.rejects(createTool().execute(path, { url: `${base}/${path}`, timeout: 0.1 }), /Request timed out/);
	}
});

test("cancellation before execution and during permission confirmation prevents transport", async (context) => {
	let requests = 0;
	const base = await serve(context, (_request, response) => {
		requests++;
		response.end("unexpected");
	});
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(createTool().execute("cancelled", { url: base }, cancelled.signal), { name: "AbortError" });
	const controller = new AbortController();
	const pending = createTool(async (_request, signal) => {
		assert.equal(signal, controller.signal);
		controller.abort();
	}).execute("confirming", { url: base }, controller.signal);
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(requests, 0);
});

test("cancellation interrupts in-flight transport and response bodies", { timeout: 5_000 }, async (context) => {
	for (const sendBody of [false, true]) {
		let received: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			received = resolve;
		});
		const base = await serve(context, (_request, response) => {
			if (sendBody) {
				response.writeHead(200, { "content-type": "text/plain" });
				response.write("partial");
			}
			received();
		});
		const controller = new AbortController();
		const pending = createTool().execute("cancel", { url: base }, controller.signal);
		const rejected = assert.rejects(pending, { name: "AbortError" });
		await ready;
		if (sendBody) await new Promise<void>((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await rejected;
	}
});
