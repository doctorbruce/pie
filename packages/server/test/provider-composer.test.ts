import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { parseModelConfig } from "../src/models/model-config.ts";
import { composeModelProvider } from "../src/models/provider-composer.ts";

test("models.json explicitly supports a keyless local provider without relaxing other providers", async () => {
	const parsed = parseModelConfig({
		providers: {
			local: {
				auth: "none",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:13159/v1",
				models: [{ id: "local-model" }],
			},
			guarded: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:13159/v1",
				models: [{ id: "guarded-model" }],
			},
		},
	});
	const models = createModels();
	for (const [id, config] of Object.entries(parsed.providers)) {
		models.setProvider(composeModelProvider(id, undefined, config, {}));
	}

	const local = models.getModel("local", "local-model");
	assert(local);
	const auth = await models.getAuth(local);
	assert(auth);
	assert.equal(auth.auth.apiKey, "unused");
	assert.equal(await models.getAuth("guarded"), undefined);
});
