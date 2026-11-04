import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Static,
	Type,
} from "@earendil-works/pi-ai";
import { createSqliteRuntimeStore, openStore } from "@pie/local";
import { createSkillTools } from "@pie/local/skills";
import { createAgentFactory, createRuntime } from "@pie/runtime";
import type { Assistant, HostRuntimeDefinition, RuntimeConfig, SkillBinding } from "@pie/runtime/protocol";
import { isCapabilityCatalog } from "../../runtime/src/capability-catalog.ts";

async function fixture(context: TestContext, source: "host" | "local" = "host") {
	const directory = await mkdtemp(join(tmpdir(), "pie-skill-refresh-"));
	const skills: SkillBinding[] = [];
	for (const version of [1, 2]) {
		const skillDirectory = join(directory, `skill-${version}`);
		await mkdir(skillDirectory);
		await writeFile(join(skillDirectory, "SKILL.md"), `SKILL_BODY_V${version}`);
		skills.push({
			id: "official:document",
			name: "document",
			description: `DOCUMENT_DESCRIPTION_V${version}`,
			directory: skillDirectory,
			source: { pluginId: "official", pluginName: "Official", pluginVersion: String(version) },
		});
	}
	const config: RuntimeConfig = {
		systemPrompt: "HOST_PROMPT",
		toolIds: ["publish_skills"],
		skills: [],
		subagents: [],
	};
	const definitions: HostRuntimeDefinition[] = ["target", "other"].map((assistantId) => ({
		assistantId,
		assistantRevision: "0",
		runtime: structuredClone(config),
	}));
	const assistants: Assistant[] = definitions.map(({ assistantId }) => ({
		id: assistantId,
		name: assistantId,
		systemPrompt: config.systemPrompt,
		toolIds: config.toolIds,
		pluginIds: [],
		subagentIds: [],
		createdAt: 1,
		updatedAt: 1,
	}));
	const faux = fauxProvider({ tokensPerSecond: 100000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const selected = { provider: faux.getModel().provider, id: faux.getModel().id };
	const parameters = Type.Object({ version: Type.Integer({ minimum: 0, maximum: 2 }) });
	const mcp = { acquired: 0, released: 0, calls: 0 };
	const agents = createAgentFactory({
		models: { current: { models, selected } },
		skills: createSkillTools,
		tools: {
			catalog: [{ id: "publish_skills", label: "Publish skills" }],
			create: () => [
				{
					name: "publish_skills",
					label: "Publish skills",
					description: "Publish the installed official document skill binding.",
					exposure: "deferred",
					executionMode: "sequential",
					parameters,
					async execute(_callId, input) {
						const { version } = input as Static<typeof parameters>;
						definitions[0].runtime.skills = version ? [skills[version - 1]] : [];
						definitions[0].assistantRevision = String(version);
						assistants[0].updatedAt++;
						if (source === "host") await runtime.registerHostRuntimes(definitions);
						return { content: [{ type: "text", text: `Published ${version}` }], details: {} };
					},
				},
			],
		},
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			async acquire() {
				mcp.acquired++;
				return {
					tools: [
						{
							name: "mcp__fixture__echo",
							label: "Echo",
							description: "Echo fixture",
							parameters: Type.Object({}),
							async execute() {
								mcp.calls++;
								return { content: [{ type: "text", text: "MCP_RESULT" }], details: {} };
							},
						},
					],
					instructions: [{ server: "fixture", content: "MCP_GUIDANCE", toolNames: ["mcp__fixture__echo"] }],
					release() {
						mcp.released++;
					},
				};
			},
			async close() {},
		},
		recordModelRequest: () => async () => undefined,
	});
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = await createRuntime({
		agents,
		store,
		hostRuntimes: source === "host" ? definitions : [],
		assistants:
			source === "local"
				? {
						list: () => assistants,
						runtime: (assistant) =>
							structuredClone({
								...config,
								skills: definitions.find((item) => item.assistantId === assistant.id)!.runtime.skills,
							}),
					}
				: undefined,
	});
	context.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { runtime, store, faux, skills, mcp, definitions };
}

const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const source of ["host", "local"] as const) {
	test(`${source} skill bindings refresh between model calls in the same Turn`, async (context) => {
		const { runtime, store, faux, skills, mcp } = await fixture(context, source);
		const session = await runtime.createSession({ assistantId: "target", mode: "real" });
		const other = await runtime.createSession({ assistantId: "other", mode: "real" });
		faux.setResponses([
			call("tool_search", { query: "mcp__fixture__echo" }),
			call("tool_search", { query: "publish_skills" }),
			fauxAssistantMessage(
				[fauxToolCall("publish_skills", { version: 1 }), fauxToolCall("skill", { id: skills[0].id })],
				{ stopReason: "toolUse" },
			),
			async (request) => {
				const last = [...request.messages].reverse().find((message) => !isCapabilityCatalog(message));
				assert.equal(last?.role, "toolResult");
				assert.equal(Reflect.get(last!, "isError"), true, "current batch must keep its original tools");
				assert.equal(request.systemPrompt, "TURN_CONTEXT\n\nHOST_PROMPT");
				assert.match(contentText(request.messages.at(-1)!.content), /DOCUMENT_DESCRIPTION_V1/);
				assert.equal(request.messages.filter(isCapabilityCatalog).length, 2);
				assert(
					request.tools?.some((tool) => tool.name === "publish_skills"),
					"loaded deferred tools must survive",
				);
				assert(request.tools?.some((tool) => tool.name === "skill"));
				assert(request.tools?.some((tool) => tool.name === "skill_search"));
				assert(request.tools?.some((tool) => tool.name === "mcp__fixture__echo"));
				assert.equal(mcp.acquired, 1, "skill updates must retain the current MCP lease");
				const saved = await store.readSession(session.id);
				assert.deepEqual(saved?.runtime?.skills, [skills[0]]);
				assert.equal(saved?.turnCheckpoint?.systemPrompt, request.systemPrompt);
				return call("skill_search", { query: "list" });
			},
			(request) => {
				assert.match(contentText(request.messages.at(-1)!.content), /official:document/);
				return call("skill", { id: skills[0].id });
			},
			(request) => {
				assert.match(contentText(request.messages.at(-1)!.content), /SKILL_BODY_V1/);
				return call("mcp__fixture__echo", {});
			},
			(request) => {
				assert.match(contentText(request.messages.at(-1)!.content), /MCP_RESULT/);
				return call("publish_skills", { version: 2 });
			},
			(request) => {
				assert.equal(request.systemPrompt, "TURN_CONTEXT\n\nHOST_PROMPT");
				const catalog = contentText(request.messages.at(-1)!.content);
				assert.match(catalog, /DOCUMENT_DESCRIPTION_V2/);
				assert.doesNotMatch(catalog, /DOCUMENT_DESCRIPTION_V1/);
				assert.equal(request.messages.filter(isCapabilityCatalog).length, 3);
				return call("skill", { id: skills[0].id });
			},
			(request) => {
				assert.match(contentText(request.messages.at(-1)!.content), /SKILL_BODY_V2/);
				return call("publish_skills", { version: 0 });
			},
			(request) => {
				assert.equal(request.systemPrompt, "TURN_CONTEXT\n\nHOST_PROMPT");
				assert.match(contentText(request.messages.at(-1)!.content), /No specialized skills/);
				assert.equal(request.messages.filter(isCapabilityCatalog).length, 4);
				assert(!request.tools?.some((tool) => ["skill", "skill_search"].includes(tool.name)));
				return call("skill", { id: skills[0].id });
			},
			(request) => {
				assert.equal(Reflect.get(request.messages.at(-1)!, "isError"), true);
				return fauxAssistantMessage("Done");
			},
		]);
		const receipt = await runtime.submitTurn(session.id, {
			text: "Install and use the document plugin",
			systemPrompt: "TURN_CONTEXT",
		});
		const settled = await runtime.waitForTurn(session.id);
		assert.equal(settled.turn?.status, "completed", settled.turn?.error);
		assert.equal(settled.turn.id, receipt.turnId);
		assert.deepEqual(settled.runtime?.skills, []);
		assert.equal(settled.messages.filter((message) => message.role === "user").length, 1);
		assert.deepEqual(
			settled.activities?.map((activity) => [activity.status, activity.binding.source?.pluginVersion]),
			[
				["succeeded", "1"],
				["succeeded", "2"],
			],
		);
		assert.deepEqual((await runtime.getSession(other.id)).runtime?.skills, []);
		assert.deepEqual(mcp, { acquired: 1, released: 1, calls: 1 });
	});
}

test("host plugin lists publish only on change across Turns and preserve the model history prefix", async (context) => {
	const { runtime, faux, definitions } = await fixture(context);
	definitions[0].runtime.capabilityCatalog = "- document: Official document plugin";
	await runtime.registerHostRuntimes(definitions);
	const session = await runtime.createSession({ assistantId: "target", mode: "real" });
	let prefix: unknown[] = [];
	for (const [index, catalog] of [
		"- document: Official document plugin",
		"- document: Official document plugin",
		"- document: Updated summary",
		undefined,
	].entries()) {
		definitions[0].runtime.capabilityCatalog = catalog;
		definitions[0].assistantRevision = String(index + 1);
		await runtime.registerHostRuntimes(definitions);
		faux.setResponses([
			(request) => {
				assert.equal(request.systemPrompt, "HOST_PROMPT");
				assert.deepEqual(request.messages.slice(0, prefix.length), prefix);
				const catalogs = request.messages.filter(isCapabilityCatalog);
				assert.equal(catalogs.length, index < 2 ? 1 : index);
				const latest = contentText(catalogs[catalogs.length - 1].content);
				if (catalog) assert(latest.includes(catalog));
				else assert.doesNotMatch(latest, /Official document|Updated summary/);
				prefix = structuredClone(request.messages);
				return fauxAssistantMessage("Done");
			},
		]);
		await runtime.submitTurn(session.id, { text: `Request ${index}` });
		const settled = await runtime.waitForTurn(session.id);
		assert.equal(settled.turn?.status, "completed", settled.turn?.error);
		assert.equal(settled.messages.filter((message) => message.role === "user").length, index + 1);
	}
});

test("same-Turn skill refresh retains per-turn tool restrictions", async (context) => {
	const { runtime, faux } = await fixture(context);
	const session = await runtime.createSession({ assistantId: "target", mode: "real" });
	faux.setResponses([
		call("tool_search", { query: "publish_skills" }),
		call("publish_skills", { version: 1 }),
		(request) => {
			assert.doesNotMatch(request.systemPrompt ?? "", /DOCUMENT_DESCRIPTION_V1/);
			assert.equal(request.messages.filter(isCapabilityCatalog).length, 1);
			assert.match(contentText(request.messages.find(isCapabilityCatalog)!.content), /No specialized skills/);
			assert(!request.tools?.some((tool) => ["skill", "skill_search"].includes(tool.name)));
			return fauxAssistantMessage("Done");
		},
	]);
	await runtime.submitTurn(session.id, { text: "Install", toolAvailability: { skill: false, skill_search: false } });
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(settled.turn?.status, "completed", settled.turn?.error);
	assert.deepEqual(settled.runtime?.toolAvailability, { skill: false, skill_search: false });
});

test("a failed skill refresh checkpoint prevents the next model call", async (context) => {
	const { runtime, store, faux } = await fixture(context);
	const session = await runtime.createSession({ assistantId: "target", mode: "real" });
	const save = store.saveSession.bind(store);
	store.saveSession = async (...args) => {
		if (args[0].runtime?.skills.length) throw new Error("skill checkpoint rejected");
		return save(...args);
	};
	let continued = false;
	faux.setResponses([
		call("tool_search", { query: "publish_skills" }),
		call("publish_skills", { version: 1 }),
		() => {
			continued = true;
			return fauxAssistantMessage("Must not run");
		},
	]);
	await runtime.submitTurn(session.id, { text: "Install" });
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(continued, false);
	assert.equal(settled.turn?.status, "failed");
	assert.equal(runtime.storageAvailable, false);
	assert.deepEqual((await store.readSession(session.id))?.runtime?.skills, []);
});

test("cancellation during a skill refresh cannot start the next model call", async (context) => {
	const saving = deferred();
	const release = deferred();
	context.after(() => release.resolve());
	const { runtime, store, faux } = await fixture(context);
	const session = await runtime.createSession({ assistantId: "target", mode: "real" });
	const save = store.saveSession.bind(store);
	let blocked = false;
	store.saveSession = async (...args) => {
		if (!blocked && args[0].runtime?.skills.length) {
			blocked = true;
			saving.resolve();
			await release.promise;
		}
		return save(...args);
	};
	let continued = false;
	faux.setResponses([
		call("tool_search", { query: "publish_skills" }),
		call("publish_skills", { version: 1 }),
		() => {
			continued = true;
			return fauxAssistantMessage("Must not run");
		},
	]);
	const receipt = await runtime.submitTurn(session.id, { text: "Install" });
	await saving.promise;
	const cancellation = runtime.cancelTurn(session.id, { turnId: receipt.turnId });
	release.resolve();
	await cancellation;
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(continued, false);
	assert.equal(settled.turn?.status, "cancelled");
});
