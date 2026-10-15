import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { Assistant, SessionSnapshot } from "@pie/runtime/protocol";
import { createModelRequestRecorder, type ModelRequestRecord } from "../../local/src/model-requests.ts";
import { createCoreServer } from "../src/server.ts";

const model: Model<Api> = {
	id: "fixture-model",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 128,
};

async function temporaryDirectory(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-requests-"));
	context.after(async () => {
		assert.equal(dirname(directory), resolve(tmpdir()));
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

async function records(directory: string, sessionId: string) {
	const path = join(directory, "model-requests", createHash("sha256").update(sessionId).digest("hex"));
	const files = (await readdir(path)).filter((file) => file.endsWith(".json")).sort();
	return Promise.all(
		files.map(async (file) => JSON.parse(await readFile(join(path, file), "utf8")) as ModelRequestRecord),
	);
}

test("records the complete payload without truncating, mutating or persisting model credentials", async (context) => {
	const directory = await temporaryDirectory(context);
	const recorder = createModelRequestRecorder({ PI_DATA_DIR: directory, SECRET: "private-test-key" });
	const payload = {
		messages: [
			{ role: "system", content: "完整系统指令" },
			{ role: "user", content: "x".repeat(1024 * 1024) },
		],
		tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
		model: model.id,
	};
	const original = structuredClone(payload);
	assert.equal(
		await recorder("session-a", "turn")(payload, { ...model, headers: { Authorization: "private-test-key" } }),
		undefined,
	);
	assert.deepEqual(payload, original);
	const saved = await records(directory, "session-a");
	assert.equal(saved.length, 1);
	assert.deepEqual(saved[0].payload, original);
	assert.equal(saved[0].sessionId, "session-a");
	assert.equal(saved[0].purpose, "turn");
	assert.equal(JSON.stringify(saved).includes("private-test-key"), false);
	assert.deepEqual((await readdir(join(directory, "model-requests"))).length, 1);
});

test("preserves asynchronous payload replacements and isolates compaction and sibling sessions", async (context) => {
	const directory = await temporaryDirectory(context);
	const recorder = createModelRequestRecorder({ PI_DATA_DIR: directory });
	const payload = { messages: ["original"] };
	const replaced = { messages: ["replaced"], tools: [] };
	assert.equal(await recorder("session-a", "turn", async () => replaced)(payload, model), replaced);
	assert.equal(await recorder("session-a", "compaction")(payload, model), undefined);
	await recorder("session-b", "turn")({ messages: ["sibling"] }, model);
	const saved = await records(directory, "session-a");
	assert.equal(saved.length, 2);
	assert.deepEqual(saved.find((record) => record.purpose === "turn")?.payload, replaced);
	assert.deepEqual(saved.find((record) => record.purpose === "compaction")?.payload, payload);
	assert.equal((await records(directory, "session-b")).length, 1);
	assert.equal((await records(directory, "session-a")).length, 2);
});

test("recording failures do not prevent sending and do not leak payloads into warnings", async (context) => {
	const directory = await temporaryDirectory(context);
	await writeFile(join(directory, "model-requests"), "blocked");
	const warnings: unknown[][] = [];
	context.mock.method(console, "warn", (...values: unknown[]) => warnings.push(values));
	const hook = createModelRequestRecorder({ PI_DATA_DIR: directory })("session-a", "turn");
	assert.equal(await hook({ messages: ["private input"] }, model), undefined);
	assert.equal(await hook({ messages: ["private input"] }, model), undefined);
	assert.equal(warnings.length, 1);
	assert.equal(JSON.stringify(warnings).includes("private input"), false);
});

async function fixtureCore(context: TestContext, toolLoop: boolean, thresholdTokens = 9000) {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-request-core-"));
	const requests: unknown[] = [];
	const endpoint = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push(payload);
			const summary = JSON.stringify(payload).includes("You are a context summarization assistant");
			const useTool = toolLoop && requests.length === 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({
					id: "request-fixture",
					object: "chat.completion.chunk",
					model: "fixture-model",
					choices: [
						{
							index: 0,
							delta: useTool
								? {
										tool_calls: [
											{
												index: 0,
												id: "read-1",
												type: "function",
												function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) },
											},
										],
									}
								: { content: summary ? "checkpoint" : "fixture reply" },
							finish_reason: useTool ? "tool_calls" : "stop",
						},
					],
				})}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	await writeFile(join(directory, "input.txt"), "fixture tool result");
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "private-fixture-key",
					models: [{ id: "fixture-model", input: ["text", "image"], contextWindow: 10000, maxTokens: 128 }],
				},
			},
			defaultModel: { provider: "fixture", id: "fixture-model" },
		}),
	);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			compaction: { thresholdTokens, reserveTokens: 1000, keepRecentTokens: 150 },
			retry: { maxRetries: 0 },
		}),
	);
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((done) => core.server.listen(0, "127.0.0.1", done));
	const coreAddress = core.server.address();
	assert(coreAddress && typeof coreAddress !== "string");
	const base = `http://127.0.0.1:${coreAddress.port}`;
	context.after(async () => {
		await core.close();
		endpoint.closeAllConnections();
		await new Promise<void>((done) => endpoint.close(() => done()));
		assert.equal(dirname(directory), resolve(tmpdir()));
		await rm(directory, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const assistant = (await (
		await post("/assistants", { name: "Fixture", systemPrompt: "fixture-system", toolIds: toolLoop ? ["read"] : [] })
	).json()) as Assistant;
	const session = (await (
		await post("/sessions", { mode: "real", assistantId: assistant.id, workspacePath: directory })
	).json()) as SessionSnapshot;
	async function submit(text: string, images?: ImageContent[]) {
		assert.equal((await post(`/sessions/${session.id}/turns`, { text, images })).status, 202);
		for (let attempt = 0; attempt < 300; attempt++) {
			const snapshot = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
			if (snapshot.turn?.status !== "running") {
				assert.equal(snapshot.turn?.status, "completed", snapshot.turn?.error);
				return;
			}
			await delay(10);
		}
		throw new Error("fixture turn did not settle");
	}
	return { directory, requests, session, submit };
}

test("real SDK tool-loop records match exactly the JSON bodies received by a local provider", async (context) => {
	const core = await fixtureCore(context, true);
	const image: ImageContent = { type: "image", data: "Zml4dHVyZSBpbWFnZQ==", mimeType: "image/png" };
	await core.submit("读取 input.txt 并回答", [image]);
	const saved = await records(core.directory, core.session.id);
	assert.equal(core.requests.length, 2);
	assert.deepEqual(
		saved.map((record) => record.payload),
		core.requests,
	);
	assert(saved.every((record) => record.purpose === "turn"));
	assert(JSON.stringify(saved[0].payload).includes("fixture-system"));
	assert(JSON.stringify(saved[0].payload).includes('"tools"'));
	assert(JSON.stringify(saved[1].payload).includes("fixture tool result"));
	assert(JSON.stringify(saved[0].payload).includes(`data:image/png;base64,${image.data}`));
	assert.equal(JSON.stringify(saved).includes("private-fixture-key"), false);
});

test("real SDK compaction requests are recorded separately from conversational calls", async (context) => {
	const core = await fixtureCore(context, false, 300);
	await core.submit(`older-${"x".repeat(600)}`);
	await core.submit(`current-${"y".repeat(600)}`);
	const saved = await records(core.directory, core.session.id);
	assert(saved.some((record) => record.purpose === "compaction"));
	assert(saved.some((record) => record.purpose === "turn"));
	assert.deepEqual(
		saved.map((record) => record.payload),
		core.requests,
	);
	assert(saved.every((record) => record.sessionId === core.session.id));
});
