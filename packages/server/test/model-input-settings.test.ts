import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelCatalog, ProviderCatalog } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await core.ready;
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

test("provider image inputs survive HTTP edits, catalog reads, and a host restart", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-input-"));
	let running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const draft = {
		id: "local-vision",
		name: "Local vision fixture",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "fixture-only",
		models: [{ id: "vision", input: ["text", "image"] }],
		defaultModel: "vision",
	};
	async function save(body: Record<string, unknown>) {
		const response = await fetch(`${running.base}/providers/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 200);
		return (await response.json()) as ProviderCatalog;
	}
	async function checkCatalogs(input: ("text" | "image")[]) {
		const providers = (await (await fetch(`${running.base}/providers`)).json()) as ProviderCatalog;
		assert.deepEqual(providers.providers.find((provider) => provider.id === draft.id)?.models[0]?.input, input);
		const models = (await (await fetch(`${running.base}/models`)).json()) as ModelCatalog;
		assert.deepEqual(models.models.find((model) => model.provider === draft.id)?.input, input);
	}
	const saved = await save(draft);
	assert.deepEqual(saved.providers.find((provider) => provider.id === draft.id)?.models[0]?.input, ["text", "image"]);
	await checkCatalogs(["text", "image"]);
	// Resaving a provider draft that omitted capabilities must retain its existing model definition.
	await save({ ...draft, models: [{ id: "vision", maxTokens: 2048 }] });
	await running.core.close();
	running = await start(directory);
	await checkCatalogs(["text", "image"]);
	const persisted = JSON.parse(await readFile(join(directory, "models.json"), "utf8")) as {
		providers: Record<string, { models: { input?: string[] }[] }>;
	};
	assert.deepEqual(persisted.providers[draft.id].models[0]?.input, ["text", "image"]);
	await save({ ...draft, models: [{ id: "vision", input: ["text"] }] });
	await checkCatalogs(["text"]);
});

test("provider catalogs expose the effective input override and save checkbox changes over it", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-model-input-override-"));
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					models: [{ id: "overridden", input: ["text"] }],
					modelOverrides: { overridden: { input: ["text", "image"] } },
				},
			},
		}),
	);
	const running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const providers = (await (await fetch(`${running.base}/providers`)).json()) as ProviderCatalog;
	assert.deepEqual(providers.providers[0]?.models[0]?.input, ["text", "image"]);
	const models = (await (await fetch(`${running.base}/models`)).json()) as ModelCatalog;
	assert.deepEqual(models.models.find((model) => model.provider === "fixture" && model.id === "overridden")?.input, [
		"text",
		"image",
	]);
	const response = await fetch(`${running.base}/providers/config`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...providers.providers[0],
			keyConfigured: undefined,
			models: [{ id: "overridden", input: ["text"] }],
		}),
	});
	assert.equal(response.status, 200);
	const changed = (await response.json()) as ProviderCatalog;
	assert.deepEqual(changed.providers[0]?.models[0]?.input, ["text"]);
});
