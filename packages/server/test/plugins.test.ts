import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentFactory } from "../src/agent.ts";
import { createPlugins } from "../src/plugins.ts";
import type { Assistant, Plugin, RuntimeConfig, SessionEvent, SessionSnapshot, ToolActivity } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";
import { systemTools } from "../src/tools.ts";

const shellName = process.platform === "win32" ? "powershell" : "bash";

test("Astron manifest paths flatten to skills; assistant mounting survives restart and executes through the original loop", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-plugin-test-"));
	const cores: ReturnType<typeof createCoreServer>[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = join(directory, "source");
	await mkdir(join(source, "custom", "nested"), { recursive: true });
	await mkdir(join(source, "root"));
	const manifest = {
		schemaVersion: 1,
		id: "sample",
		name: "示例插件",
		summary: "本地测试",
		skills: { route: { path: "root" } },
		apa: {
			worker: {
				path: "custom",
				skills: { differentKey: { path: "custom/nested" }, disabled: { path: "missing", enabled: false } },
			},
		},
		apps: { disabled: { enabled: false, skills: { ignored: { path: "missing" } } } },
		mcp: { ignored: { server: { command: "must-not-execute" } } },
	};
	await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
	await writeFile(
		join(source, "root", "SKILL.md"),
		"---\nname: route\ndescription: Route tasks\n---\nROOT_BODY_ONLY_AFTER_LOAD",
	);
	await writeFile(
		join(source, "custom", "nested", "SKILL.md"),
		"---\nname: nested\ndescription: >\n  Run the local script\n  when requested.\n---\nNESTED_BODY_ONLY_AFTER_LOAD\nRead reference.txt, then run run.mjs in this skill directory.",
	);
	await writeFile(join(source, "custom", "nested", "reference.txt"), "REFERENCE_OK");
	await writeFile(
		join(source, "custom", "nested", "run.mjs"),
		'import { writeFileSync } from "node:fs"; writeFileSync("result.txt", "SCRIPT_OK"); console.log("SCRIPT_OK");',
	);
	const env = { PI_DATA_DIR: join(directory, "data") };
	async function start() {
		const core = createCoreServer(env);
		cores.push(core);
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return {
			core,
			call: (path: string, method = "GET", body?: unknown) =>
				fetch(`http://127.0.0.1:${address.port}${path}`, {
					method,
					headers: { "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
		};
	}
	const first = await start();
	assert.equal((await first.call("/plugins/import", "POST", { path: join(directory, "missing") })).status, 400);
	const imported = await first.call("/plugins/import", "POST", { path: source });
	assert.equal(imported.status, 201, await imported.clone().text());
	const plugin = (await imported.json()) as Plugin;
	assert.deepEqual(
		plugin.skills.map((skill) => skill.id),
		["sample/route", "sample/nested"],
	);
	assert.match(plugin.skills[1].description, /local script when requested/);
	assert.equal(plugin.skills[0].source.pluginId, "sample");
	assert.deepEqual(plugin.skills[1].source, {
		pluginId: "sample",
		pluginName: "示例插件",
	});
	assert.equal((await first.call("/plugins/import", "POST", { path: source })).status, 400);
	const assistant = (await (
		await first.call("/assistants", "POST", {
			name: "带插件",
			systemPrompt: "",
			toolIds: ["read", shellName],
			pluginIds: ["sample"],
		})
	).json()) as Assistant;
	assert.deepEqual(assistant.pluginIds, ["sample"]);
	const session = (await (
		await first.call("/sessions", "POST", { assistantId: assistant.id })
	).json()) as SessionSnapshot;
	assert.equal((await first.call("/plugins/sample", "DELETE")).status, 409);
	assert.equal((await first.call(`/assistants/${assistant.id}`, "PUT", { ...assistant, pluginIds: [] })).status, 200);
	assert.equal((await first.call("/plugins/sample", "DELETE")).status, 409);
	await first.core.close();
	await writeFile(join(source, "root", "SKILL.md"), "source modification must not affect installed copy");
	const second = await start();
	const restored = (await (await second.call(`/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert(restored.assistant);
	assert.deepEqual(restored.assistant.pluginIds, ["sample"]);
	const factory = createAgentFactory(env);
	assert(restored.runtime);
	const activityLog: ToolActivity[] = [];
	const agent = factory.create(
		"faux",
		"plugin-loop",
		restored.runtime,
		undefined,
		[],
		(activity) => activityLog.push(activity),
		async () => {},
	);
	assert.match(agent.state.systemPrompt, /sample\/nested/);
	assert.doesNotMatch(agent.state.systemPrompt, /NESTED_BODY_ONLY_AFTER_LOAD/);
	const skillTool = agent.state.tools.find((tool) => tool.name === "load_skill");
	assert(skillTool);
	await assert.rejects(skillTool.execute("bad", { id: "other/nested" }), /未挂载/);
	const empty = factory.create("faux", "empty", { systemPrompt: "", skills: [], toolIds: [], subagents: [] });
	assert.equal(empty.state.tools.length, 0);
	assert.doesNotMatch(empty.state.systemPrompt, /sample\/nested/);
	const skillDirectory = join(env.PI_DATA_DIR, "plugins", "sample", "custom", "nested");
	const node = `${process.platform === "win32" ? "& " : ""}'${process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
	const escapedDirectory = skillDirectory.replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
	const runScript =
		process.platform === "win32"
			? `Set-Location -LiteralPath '${escapedDirectory}'; ${node} run.mjs`
			: `cd '${escapedDirectory}' && ${node} run.mjs`;
	const faux = fauxProvider({ tokensPerSecond: 100000 });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("load_skill", { id: "sample/nested" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: join(skillDirectory, "reference.txt") })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall(shellName, { command: runScript })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("完成"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	agent.streamFunction = models.streamSimple.bind(models);
	await agent.prompt("测试插件脚本");
	assert.equal(agent.state.errorMessage, undefined);
	const results = agent.state.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(
		results.map((message) => [message.toolName, message.isError]),
		[
			["load_skill", false],
			["read", false],
			[shellName, false],
		],
	);
	assert.match(JSON.stringify(results[0]), /NESTED_BODY_ONLY_AFTER_LOAD/);
	assert.deepEqual(
		activityLog.map((item) => [item.kind, item.status]),
		[
			["skill_load", "running"],
			["skill_load", "succeeded"],
		],
	);
	assert.equal(activityLog[1].binding.source?.pluginId, "sample");
	assert.match(JSON.stringify(results[0].details), /"pluginId":"sample"/);
	assert.match(JSON.stringify(results[2].details), /"outputs":\[\]/);
	assert.equal(await readFile(join(skillDirectory, "result.txt"), "utf8"), "SCRIPT_OK");
	assert.equal((await second.call(`/sessions/${session.id}`, "DELETE")).status, 200);
	assert.equal((await second.call("/plugins/sample", "DELETE")).status, 200);
	assert.equal((await second.call("/assistants", "POST", { ...assistant, pluginIds: ["sample"] })).status, 400);
});

async function api(base: string, path: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function registerRuntime(base: string, assistantRevision: string, runtime: RuntimeConfig) {
	return fetch(`${base}/host-runtimes`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			runtimes: [{ assistantId: "host-provenance", assistantRevision, runtime }],
		}),
	});
}

async function submit(
	base: string,
	sessionId: string,
	text: string,
	onPacket?: (packet: SessionEvent) => Promise<void>,
) {
	const response = await fetch(`${base}/sessions/${sessionId}/events`, { signal: AbortSignal.timeout(30000) });
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		assert.equal((await api(base, `/sessions/${sessionId}/turns`, { text })).status, 202);
		while (true) {
			const { value, done } = await reader.read();
			assert(!done, "stream ended before settlement");
			buffer += decoder.decode(value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (line.startsWith("data: ")) {
					const packet = JSON.parse(line.slice(6)) as SessionEvent;
					if (packet.type === "interaction.requested" && packet.interaction)
						assert.equal(
							(
								await api(base, `/sessions/${sessionId}/interactions/${packet.interaction.id}`, {
									approved: true,
								})
							).status,
							202,
						);
					await onPacket?.(packet);
					if (packet.type === "turn.settled") return packet.snapshot;
				}
				end = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel();
	}
}

test("shared host bindings preserve distinct provenance through SSE, load failures and restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-provenance-"));
	const cores: ReturnType<typeof createCoreServer>[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const skillDir = join(directory, "shared");
	await mkdir(skillDir);
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: pdf\ndescription: Shared PDF helper\n---\nPRIVATE_BODY");
	const runtime: RuntimeConfig = {
		systemPrompt: "Use the selected binding.",
		toolIds: [],
		subagents: [],
		skills: ["A", "B"].map((id) => ({
			id: `${id}/pdf`,
			name: "pdf",
			description: `PDF via ${id}`,
			directory: skillDir,
			source: {
				pluginId: id,
				pluginName: `Plugin ${id}`,
				pluginVersion: "1",
			},
		})),
	};
	async function start() {
		const core = createCoreServer({ PI_DATA_DIR: join(directory, "data") });
		cores.push(core);
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return { core, base: `http://127.0.0.1:${address.port}` };
	}
	const first = await start();
	assert.deepEqual(await (await api(first.base, "/plugins")).json(), { plugins: [] });
	for (const invalid of [
		{ ...runtime, skills: [runtime.skills[0], runtime.skills[0]] },
		{ ...runtime, toolIds: ["invented"] },
		{ ...runtime, skills: [{ ...runtime.skills[0], directory: "relative/path" }] },
	])
		assert.equal((await registerRuntime(first.base, "invalid", invalid)).status, 400);
	assert.equal((await registerRuntime(first.base, "1", runtime)).status, 200);
	const created = await api(first.base, "/sessions", { assistantId: "host-provenance" });
	assert.equal(created.status, 201, await created.clone().text());
	const session = (await created.json()) as SessionSnapshot;
	const updates: SessionEvent[] = [];
	const loadedB = await submit(first.base, session.id, "加载技能 B/pdf", async (packet) => {
		if (packet.activity) updates.push(packet);
	});
	assert.deepEqual(
		updates.map((packet) => packet.activity?.status),
		["running", "succeeded"],
	);
	assert.equal(updates[0].activity?.id, updates[1].activity?.id);
	assert.equal(loadedB.activities?.[0].binding.source?.pluginId, "B");
	assert.equal(loadedB.activities?.[0].turnId, loadedB.turn?.id);
	assert.equal(loadedB.activities?.[0].sessionId, session.id);
	assert.match(
		JSON.stringify(loadedB.messages.find((message) => message.role === "toolResult")?.details),
		/"pluginId":"B"/,
	);
	const loadedA = await submit(first.base, session.id, "加载技能 A/pdf");
	assert.equal(loadedA.activities?.length, 2);
	assert.equal(loadedA.activities?.[1].binding.source?.pluginId, "A");
	assert.equal(loadedA.activities?.[0].contentHash, loadedA.activities?.[1].contentHash);
	const rejected = await submit(first.base, session.id, "加载技能 other/pdf");
	assert.equal(rejected.activities?.length, 2);
	assert(rejected.messages.some((message) => message.role === "toolResult" && message.isError));
	await rm(join(skillDir, "SKILL.md"));
	const missing = await submit(first.base, session.id, "加载技能 A/pdf");
	assert.equal(missing.activities?.at(-1)?.status, "failed");
	assert.equal(missing.activities?.at(-1)?.binding.source?.pluginId, "A");
	const failedResult = missing.messages.filter((message) => message.role === "toolResult").at(-1);
	assert.equal(failedResult?.isError, true);
	assert.match(JSON.stringify(failedResult?.details), /"pluginId":"A"/);
	await writeFile(join(skillDir, "SKILL.md"), "x".repeat(65537));
	const oversized = await submit(first.base, session.id, "加载技能 B/pdf");
	assert.equal(oversized.activities?.at(-1)?.status, "failed");
	assert.equal(oversized.activities?.at(-1)?.binding.source?.pluginId, "B");
	assert.equal(oversized.activities?.at(-1)?.contentHash, undefined);
	assert.match(oversized.activities?.at(-1)?.error ?? "", /64 KiB/);
	await first.core.close();
	await writeFile(join(skillDir, "SKILL.md"), "Changed content");
	runtime.skills[1].source!.pluginVersion = "2";
	const second = await start();
	const restored = (await (await api(second.base, `/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.deepEqual(restored.activities, oversized.activities);
	assert.deepEqual(restored.runtime, oversized.runtime);
	assert.deepEqual(restored.messages, oversized.messages);
	const reloaded = await submit(second.base, session.id, "加载技能 B/pdf");
	assert.equal(reloaded.activities?.at(-1)?.binding.source?.pluginVersion, "1");
	assert.notEqual(reloaded.activities?.at(-1)?.contentHash, reloaded.activities?.[0].contentHash);
	assert.equal((await registerRuntime(second.base, "2", runtime)).status, 200);
	const fresh = (await (
		await api(second.base, "/sessions", { assistantId: "host-provenance" })
	).json()) as SessionSnapshot;
	assert.equal(fresh.runtime?.skills[1].source?.pluginVersion, "2");
});

test("plugin import rejects escapes and duplicate runtime names without publishing partial packages", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-plugin-validation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = join(directory, "source");
	await mkdir(join(source, "skill"), { recursive: true });
	await writeFile(join(source, "skill", "SKILL.md"), "---\nname: example\ndescription: Example\n---\nInstructions");
	const plugins = createPlugins({ PI_DATA_DIR: join(directory, "data") });
	const manifest = {
		schemaVersion: 1,
		id: "validation",
		name: "Validation",
		summary: "Validation",
		skills: { example: { path: "../source/skill" } },
	};
	for (const path of ["../source/skill", "C:\\escape", "/escape"]) {
		manifest.skills.example.path = path;
		await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
		assert.throws(() => plugins.import(source), /必须位于插件目录内/);
	}
	manifest.skills.example.path = "skill";
	await writeFile(
		join(source, "plugin.json"),
		JSON.stringify({ ...manifest, skills: { ...manifest.skills, duplicate: { path: "skill" } } }),
	);
	assert.throws(() => plugins.import(source), /重复/);
	await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
	await symlink(join(source, "skill"), join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => plugins.import(source), /符号链接|目录联接/);
	assert.deepEqual(plugins.list(), []);
});

test("shell reports nonzero exit, output limits, timeout and cancellation of descendants", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-shell-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const shell = systemTools({}, directory).find((tool) => tool.name === shellName);
	assert(shell);
	await assert.rejects(shell.execute("exit", { command: "exit 7" }), /code 7/);
	const node = `${process.platform === "win32" ? "& " : ""}'${process.execPath.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
	await writeFile(join(directory, "flood.mjs"), 'console.log("x".repeat(70000));');
	const flooded = await shell.execute("limit", { command: `${node} flood.mjs` });
	assert.match(JSON.stringify(flooded.details), /fullOutputPath/);
	await writeFile(
		join(directory, "wait.mjs"),
		'import { writeFileSync } from "node:fs"; console.log("ready"); setTimeout(() => writeFileSync("leaked.txt", "leak"), 2000);',
	);
	await assert.rejects(shell.execute("timeout", { command: `${node} wait.mjs`, timeout: 0.5 }), /timed out/);
	const controller = new AbortController();
	const pending = shell.execute("cancel", { command: `${node} wait.mjs` }, controller.signal);
	setTimeout(800).then(() => controller.abort());
	await assert.rejects(pending, /aborted/);
	await setTimeout(2200);
	await assert.rejects(readFile(join(directory, "leaked.txt")), { code: "ENOENT" });
});
