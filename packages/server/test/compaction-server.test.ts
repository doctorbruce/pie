import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { SessionSnapshot } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

async function listen(core: ReturnType<typeof createCoreServer>) {
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

async function submitAndWait(base: string, sessionId: string, text: string) {
	const response = await fetch(`${base}/sessions/${sessionId}/turns`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	assert.equal(response.status, 202);
	for (let attempt = 0; attempt < 200; attempt++) {
		const snapshot = (await (await fetch(`${base}/sessions/${sessionId}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") return snapshot;
		await setTimeout(10);
	}
	throw new Error("turn did not settle");
}

test("real sessions compact before model calls and restore the checkpoint after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-compaction-test-"));
	const requests: { summary: boolean; body: string }[] = [];
	const endpoint = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString("utf8");
			const summary = body.includes("Summarize the supplied conversation into a context checkpoint");
			requests.push({ summary, body });
			const content = summary ? "## Goal\nContinue the compacted test conversation." : "reply";
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "tiny", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
			);
			res.end(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "tiny", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => {
			res.writeHead(500);
			res.end();
		});
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointAddress = endpoint.address();
	assert(endpointAddress && typeof endpointAddress !== "string");
	let core: ReturnType<typeof createCoreServer> | undefined;
	t.after(async () => {
		await core?.close();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		endpoint.closeAllConnections();
		await rm(directory, { recursive: true, force: true });
	});

	core = createCoreServer({ PI_DATA_DIR: directory });
	let base = await listen(core);
	const configure = await fetch(`${base}/providers/config`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: "local",
			name: "Local",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
			apiKey: "test-key",
			models: [{ id: "tiny", contextWindow: 600, maxTokens: 128 }],
			defaultModel: "tiny",
		}),
	});
	assert.equal(configure.status, 200);
	const created = await fetch(`${base}/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "real" }),
	});
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;

	let snapshot = session;
	for (let index = 0; index < 3; index++)
		snapshot = await submitAndWait(base, session.id, `turn-${index}-${"x".repeat(700)}`);
	assert.equal(snapshot.messages.length, 6);
	assert.equal(snapshot.compaction?.generation, 1);
	assert(requests.some((request) => request.summary));

	await core.close();
	core = createCoreServer({ PI_DATA_DIR: directory });
	base = await listen(core);
	const restored = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.deepEqual(restored.compaction, snapshot.compaction);

	const resumed = await submitAndWait(base, session.id, `turn-3-${"x".repeat(700)}`);
	assert.equal(resumed.messages.length, 8);
	assert.equal(resumed.compaction?.generation, 2);
	assert(
		requests.some(
			(request) =>
				request.summary && request.body.includes("<previous-summary>") && request.body.includes("compacted test"),
		),
	);
});
