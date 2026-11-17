import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { GlobalSessionEvent, SessionCompactionResult, SessionSnapshot } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (await predicate()) return;
		await delay(10);
	}
	assert.fail("manual compaction did not reach the expected state");
}

async function start(context: TestContext, retry = false) {
	const directory = await mkdtemp(join(tmpdir(), "pie-manual-compaction-"));
	const summaries: { model: string; body: string }[] = [];
	const ordinaryRequests: { model: string; body: string }[] = [];
	let summaryMode: "success" | "hold" | "failure" | "retry" = "success";
	const endpoint = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString("utf8");
			const summary = body.includes("You are a context summarization assistant");
			(summary ? summaries : ordinaryRequests).push({ model: (JSON.parse(body) as { model: string }).model, body });
			if (summary && (summaryMode === "failure" || summaryMode === "retry")) {
				response.writeHead(summaryMode === "retry" ? 503 : 400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "summary rejected", type: "test_error" } }));
				if (summaryMode === "retry") summaryMode = "success";
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (summary && summaryMode === "hold") {
				response.flushHeaders();
				return;
			}
			response.end(
				`data: ${JSON.stringify({
					id: "manual-test",
					object: "chat.completion.chunk",
					model: "primary",
					choices: [
						{ index: 0, delta: { content: summary ? "manual checkpoint" : "reply" }, finish_reason: "stop" },
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
					models: ["primary", "summary"].map((id) => ({ id, contextWindow: 10000, maxTokens: 256 })),
				},
			},
			defaultModel: { provider: "local", id: "primary" },
		}),
	);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 },
			retry: retry ? { maxRetries: 1, baseDelayMs: 1 } : { enabled: false },
		}),
	);
	const core = createCoreServer({ PI_DATA_DIR: directory });
	context.after(async () => {
		await core.close();
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: Record<string, unknown> = {}, signal?: AbortSignal) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	const assistantResponse = await post("/assistants", { name: "Manual compaction", systemPrompt: "", toolIds: [] });
	assert.equal(assistantResponse.status, 201);
	const assistant = (await assistantResponse.json()) as { id: string };
	const created = await post("/sessions", { mode: "real", assistantId: assistant.id });
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	const snapshot = async () => (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	const events: GlobalSessionEvent[] = [];
	const runtime = await core.ready;
	const unsubscribe = runtime.subscribeAll((event) => events.push(event));
	context.after(unsubscribe);
	async function populate() {
		for (let turn = 0; turn < 3; turn++) {
			const result = await post(`/sessions/${session.id}/turns`, {
				text: `turn-${turn}-${"history ".repeat(60)}`,
				toolAvailability: { communicate: false },
			});
			assert.equal(result.status, 202);
			await waitUntil(async () => (await snapshot()).turn?.status !== "running");
		}
	}
	return {
		core,
		post,
		session,
		snapshot,
		events,
		summaries,
		ordinaryRequests,
		populate,
		setSummaryMode(mode: typeof summaryMode) {
			summaryMode = mode;
		},
	};
}

test("manual HTTP compaction publishes a checkpoint without changing the Turn, original history or model selection", async (context) => {
	const server = await start(context);
	const path = `/sessions/${server.session.id}/compact`;
	const empty = await server.post(path);
	assert.equal(empty.status, 200);
	assert.deepEqual(await empty.json(), { completed: true, compacted: false });
	assert.equal(server.summaries.length, 0);
	await server.populate();
	const original = await server.snapshot();
	server.events.length = 0;
	const response = await server.post(path, { model: { provider: "local", id: "summary" } });
	assert.equal(response.status, 200, await response.clone().text());
	const result = (await response.json()) as SessionCompactionResult;
	assert.equal(result.completed, true);
	assert.equal(result.compacted, true);
	assert.equal(result.compaction?.summary, "manual checkpoint");
	assert.equal(server.summaries.length, 1);
	assert.equal(server.summaries[0].model, "summary");
	assert.deepEqual(
		server.events
			.filter((event) => event.type.startsWith("compaction."))
			.map((event) => [event.type, event.event?.reason]),
		[
			["compaction.started", "manual"],
			["compaction.updated", undefined],
			["compaction.finished", "manual"],
		],
	);
	assert(!server.events.some((event) => event.type === "agent.event" || event.type === "turn.settled"));
	assert.deepEqual(
		server.events.find((event) => event.type === "compaction.finished")?.event?.compaction,
		result.compaction,
	);
	const compacted = await server.snapshot();
	assert.deepEqual(compacted.messages, original.messages);
	assert.deepEqual(compacted.turn, original.turn);
	assert.equal(compacted.model, original.model);
	assert.deepEqual(compacted.modelOverride, original.modelOverride);
	assert.deepEqual(compacted.compaction, result.compaction);
	const repeated = await server.post(path);
	assert.deepEqual(await repeated.json(), { completed: true, compacted: false });
	assert.equal(server.summaries.length, 1);
	assert.equal((await server.post(path, { model: { provider: "local", id: "missing" } })).status, 400);
	const next = await server.post(`/sessions/${server.session.id}/turns`, {
		text: "continue after manual compaction",
		toolAvailability: { communicate: false },
	});
	assert.equal(next.status, 202);
	await waitUntil(async () => (await server.snapshot()).turn?.status !== "running");
	assert.equal(server.ordinaryRequests.at(-1)?.model, "primary");
	assert.match(server.ordinaryRequests.at(-1)?.body ?? "", /manual checkpoint/);
	assert(!server.ordinaryRequests.at(-1)?.body.includes("turn-0-"));
});

test("manual HTTP compaction rejects concurrent writes and releases its owner after request cancellation or summary failure", async (context) => {
	const server = await start(context);
	await server.populate();
	const before = await server.snapshot();
	const path = `/sessions/${server.session.id}/compact`;
	server.setSummaryMode("hold");
	const controller = new AbortController();
	const pending = server.post(path, {}, controller.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await waitUntil(() => server.summaries.length === 1);
	assert.equal((await server.post(path)).status, 409);
	assert.equal(
		(await server.post(`/sessions/${server.session.id}/turns`, { text: "must not enter history" })).status,
		409,
	);
	assert.equal((await server.post(`/sessions/${server.session.id}/tree`, { leafId: null })).status, 409);
	controller.abort();
	await rejected;
	await waitUntil(() =>
		server.events.some((event) => event.type === "compaction.finished" && event.event?.status === "cancelled"),
	);
	assert.deepEqual((await server.snapshot()).messages, before.messages);
	assert.equal((await server.snapshot()).compaction, undefined);
	server.setSummaryMode("failure");
	assert.equal((await server.post(path)).status, 500);
	assert.equal((await server.snapshot()).compaction, undefined);
	server.setSummaryMode("success");
	const recovered = await server.post(path);
	assert.equal(recovered.status, 200);
	assert.equal(((await recovered.json()) as SessionCompactionResult).compacted, true);
});

test("manual summary retry events keep their manual reason", async (context) => {
	const server = await start(context, true);
	await server.populate();
	server.setSummaryMode("retry");
	const response = await server.post(`/sessions/${server.session.id}/compact`);
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as SessionCompactionResult).compacted, true);
	assert.equal(server.summaries.length, 2);
	assert(
		server.events.some(
			(event) => event.type === "compaction.retry" && event.event?.reason === "manual" && event.event?.attempt === 1,
		),
	);
});
