import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionSnapshot, SessionTransfer } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, path: string, method: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

test("model override belongs to one session, survives restart and transfers, and null stays authoritative", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-override-"));
	let running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = (await (await request(running.base, "/sessions", "POST", {})).json()) as SessionSnapshot;
	const other = (await (await request(running.base, "/sessions", "POST", {})).json()) as SessionSnapshot;
	assert.equal(source.modelOverride, null);
	const selection = { providerId: "custom", model: "custom-model" };
	const path = `/sessions/${source.id}/model-override`;
	assert.equal((await request(running.base, path, "PUT", { modelOverride: selection })).status, 200);
	assert.equal((await request(running.base, path, "PUT", { modelOverride: {} })).status, 400);
	const transfer = (await (
		await request(running.base, `/sessions/${source.id}/export`, "GET")
	).json()) as SessionTransfer;
	assert.deepEqual(transfer.modelOverride, selection);
	assert.equal((await request(running.base, `/sessions/${other.id}/import`, "PUT", transfer)).status, 200);
	await running.core.close();
	running = await start(directory);
	const restored = (await (await request(running.base, `/sessions/${source.id}`, "GET")).json()) as SessionSnapshot;
	assert.deepEqual(restored.modelOverride, selection);
	const imported = (await (await request(running.base, `/sessions/${other.id}`, "GET")).json()) as SessionSnapshot;
	assert.deepEqual(imported.modelOverride, selection);
	assert.equal((await request(running.base, path, "PUT", { modelOverride: null })).status, 200);
	await request(running.base, path, "PUT", { modelOverride: selection, initializeOnly: true });
	const cleared = (await (await request(running.base, `/sessions/${source.id}`, "GET")).json()) as SessionSnapshot;
	assert.equal(cleared.modelOverride, null);
	assert.deepEqual(
		((await (await request(running.base, `/sessions/${other.id}`, "GET")).json()) as SessionSnapshot).modelOverride,
		selection,
	);
	assert.equal((await request(running.base, `/sessions/${source.id}`, "DELETE")).status, 200);
	assert.equal((await request(running.base, `/sessions/${source.id}`, "GET")).status, 404);
});

test("each turn uses the explicit model, session override, or current default without pinning the default", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-turn-"));
	let running: Awaited<ReturnType<typeof start>> | undefined;
	const calls: string[] = [];
	const endpoint = createServer((incoming, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
			calls.push(body.model);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({
					id: "local-model-test",
					object: "chat.completion.chunk",
					model: body.model,
					choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => response.destroy());
	});
	context.after(async () => {
		await running?.core.close();
		await new Promise<void>((resolve, reject) => endpoint.close((error) => (error ? reject(error) : resolve())));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	const providers = {
		fixture: {
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			apiKey: "local",
			models: ["model-a", "model-b"].map((id) => ({ id, contextWindow: 100000, maxTokens: 100 })),
		},
	};
	const saveDefault = (id: string) =>
		writeFile(
			join(directory, "models.json"),
			JSON.stringify({ providers, defaultModel: { provider: "fixture", id } }),
		);
	await saveDefault("model-a");
	running = await start(directory);
	const base = running.base;
	const source = (await (await request(base, "/sessions", "POST", { mode: "real" })).json()) as SessionSnapshot;
	async function turn(model?: { provider: string; id: string }) {
		const submitted = await request(base, `/sessions/${source.id}/turns`, "POST", { text: "Hello", model });
		assert.equal(submitted.status, 202);
		for (let attempt = 0; attempt < 200; attempt++) {
			const snapshot = (await (await request(base, `/sessions/${source.id}`, "GET")).json()) as SessionSnapshot;
			if (snapshot.turn?.status !== "running") {
				assert.equal(snapshot.turn?.status, "completed", snapshot.turn?.error);
				return snapshot;
			}
			await delay(10);
		}
		throw new Error("Turn did not settle");
	}
	assert.equal((await turn()).model, "model-a");
	const selection = { providerId: "fixture", model: "model-b" };
	const path = `/sessions/${source.id}/model-override`;
	assert.equal((await request(base, path, "PUT", { modelOverride: selection })).status, 200);
	assert.equal((await turn()).model, "model-b");
	const explicit = await turn({ provider: "fixture", id: "model-a" });
	assert.equal(explicit.model, "model-a");
	assert.deepEqual(explicit.modelOverride, selection);
	assert.equal((await request(base, path, "PUT", { modelOverride: null })).status, 200);
	await saveDefault("model-b");
	assert.equal((await request(base, "/models/reload", "POST", {})).status, 200);
	const following = await turn();
	assert.equal(following.model, "model-b");
	assert.equal(following.modelOverride, null);
	await saveDefault("model-a");
	assert.equal((await request(base, "/models/reload", "POST", {})).status, 200);
	assert.equal((await turn()).model, "model-a");
	assert.deepEqual(calls, ["model-a", "model-b", "model-a", "model-b", "model-a"]);
});
