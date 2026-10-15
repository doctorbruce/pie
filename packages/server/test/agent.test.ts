import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentFactory } from "@pie/local/agent";
import { hydrateHostRuntime } from "@pie/runtime/config";
import type { HostRuntimeDefinition, RuntimeConfig, ToolActivity } from "@pie/runtime/protocol";

test("host subagents keep the target runtime language for their skill index", () => {
	const definition: HostRuntimeDefinition = {
		assistantId: "star",
		assistantRevision: "1",
		runtime: {
			systemPrompt: "父助手",
			language: "zh",
			toolIds: [],
			skills: [],
			subagents: [{ id: "worker", name: "worker", description: "写作", assistantId: "writer" }],
		},
	};
	const registry = new Map<string, HostRuntimeDefinition>([
		[
			"writer",
			{
				assistantId: "writer",
				assistantRevision: "worker-1",
				runtime: {
					systemPrompt: "写作助手",
					language: "zh",
					toolIds: [],
					skills: [
						{
							id: "writer-skill",
							name: "writer-skill",
							description: "Write documents.",
							descriptions: { "zh-CN": "撰写文档" },
							directory: process.cwd(),
						},
					],
					subagents: [],
				},
			},
		],
	]);
	const child = hydrateHostRuntime(definition, registry).subagents[0];
	assert(child);
	assert.equal(child.assistantRevision, "worker-1");
	assert.equal(child.runtime.language, "zh");
	assert.deepEqual(child.runtime.skills[0]?.descriptions, { "zh-CN": "撰写文档" });
});

test("agent prompts preserve assistant instructions with turn context and a sorted, bounded skill index", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-skill-index-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const factory = createAgentFactory({ PI_DATA_DIR: directory });
	const runtime: RuntimeConfig = {
		systemPrompt: "# 市场商品调研助手\n你负责商品调研、选购和比价。",
		toolIds: [],
		subagents: [],
		skills: [
			{
				id: "z-plugin:shared",
				name: "shared",
				description: "\r\n  \r\n  First useful line.  \r\nFull detailed description stays out of the index.",
				directory,
				source: { pluginId: "z-plugin", pluginName: "Verbose plugin source", pluginVersion: "1" },
			},
			{ id: "limit", name: "limit", description: "b".repeat(160), directory },
			{ id: "long", name: "long", description: "c".repeat(161), directory },
			{ id: "empty", name: "empty", description: " \r\n\t", directory },
			{ id: "a-plugin:shared", name: "shared", description: "Another skill.", directory },
		],
	};
	const original = structuredClone(runtime);
	const prompt = factory.composeSystemPrompt(runtime);
	assert.deepEqual(
		prompt.split("\n").filter((line) => line.startsWith("- ")),
		[
			"- a-plugin:shared: Another skill.",
			"- empty: No description provided.",
			`- limit: ${"b".repeat(160)}`,
			`- long: ${"c".repeat(157)}...`,
			"- z-plugin:shared: First useful line.",
		],
	);
	assert.match(prompt, /full instructions are loaded only after calling the skill tool/);
	assert.match(prompt, /do not assume missing host dependencies are installed/);
	assert.equal(prompt.includes("Full detailed description"), false);
	assert.equal(prompt.includes("Verbose plugin source"), false);
	assert.equal(factory.create("faux", "skill-index", runtime).state.systemPrompt, prompt);
	assert.equal(factory.composeSystemPrompt(runtime, "Turn context"), `Turn context\n\n${prompt}`);
	assert.equal(factory.composeSystemPrompt(runtime, runtime.systemPrompt), prompt);
	assert.equal(factory.composeSystemPrompt(runtime, " \n\t"), prompt);
	assert.deepEqual(runtime, original);
	const empty = { ...runtime, skills: [] };
	assert.equal(factory.composeSystemPrompt(empty), runtime.systemPrompt);
	assert.equal(factory.composeSystemPrompt(empty, "Turn context"), `Turn context\n\n${runtime.systemPrompt}`);
	assert.equal(factory.composeSystemPrompt({ ...empty, systemPrompt: "" }, "Turn context"), "Turn context");
});

test("the skill index prefers the host language's localized summary over the binding description", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-skill-language-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const factory = createAgentFactory({ PI_DATA_DIR: directory });
	const skills: RuntimeConfig["skills"] = [
		{
			id: "localized",
			name: "localized",
			description: "Search the web with Astron.",
			descriptions: { "zh-CN": "使用 Astron 联网搜索", "en-US": "Search the web with Astron." },
			directory,
		},
		{
			id: "partial",
			name: "partial",
			description: "Fallback description.",
			descriptions: { "zh-CN": "中文说明" },
			directory,
		},
		{
			id: "plain",
			name: "plain",
			description: "No localized summary.",
			directory,
		},
	];
	for (const language of ["zh", "ZH-CN"]) {
		const localizedPrompt = factory.composeSystemPrompt({
			systemPrompt: "Host system prompt",
			toolIds: [],
			subagents: [],
			skills: [...skills, { id: "empty", name: "empty", description: " ", directory }],
			language,
		});
		assert.match(localizedPrompt, /## 可用技能\n/);
		assert.match(localizedPrompt, /完整指引仅在调用 skill 工具后加载/);
		assert.match(localizedPrompt, /不要默认认为技能所需的程序或依赖已安装/);
		assert.match(localizedPrompt, /- empty: 未提供描述。/);
		assert.equal(localizedPrompt.includes("Available skills"), false);
	}
	for (const language of ["en-US", "ja-JP", undefined]) {
		const fallbackPrompt = factory.composeSystemPrompt({
			systemPrompt: "Host system prompt",
			toolIds: [],
			subagents: [],
			skills,
			language,
		});
		assert.match(fallbackPrompt, /## Available Skills\n/);
		assert.equal(fallbackPrompt.includes("## 可用技能"), false);
	}
	const prompt = (language?: string) =>
		factory
			.composeSystemPrompt({ systemPrompt: "Host system prompt", toolIds: [], subagents: [], skills, language })
			.split("\n")
			.filter((line) => line.startsWith("- "));

	assert.deepEqual(prompt("zh"), [
		"- localized: 使用 Astron 联网搜索",
		"- partial: 中文说明",
		"- plain: No localized summary.",
	]);
	assert.deepEqual(prompt("en-US"), [
		"- localized: Search the web with Astron.",
		"- partial: Fallback description.",
		"- plain: No localized summary.",
	]);
	assert.deepEqual(prompt("ja-JP"), [
		"- localized: Search the web with Astron.",
		"- partial: Fallback description.",
		"- plain: No localized summary.",
	]);
	assert.deepEqual(prompt(), [
		"- localized: Search the web with Astron.",
		"- partial: Fallback description.",
		"- plain: No localized summary.",
	]);
});

test("the skill tool still loads complete instructions and preserves skill provenance", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-skill-load-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const body = "# Full skill\n\nFollow this complete workflow.\n\nFinal required step is never truncated.";
	await writeFile(join(directory, "SKILL.md"), body);
	const runtime: RuntimeConfig = {
		systemPrompt: "Host system prompt",
		toolIds: [],
		subagents: [],
		skills: [
			{
				id: "plugin:full-skill",
				name: "full-skill",
				description: "Short discovery line.\nLong description retained in the binding.",
				directory,
				source: { pluginId: "plugin", pluginName: "Skill plugin", pluginVersion: "1" },
			},
		],
	};
	const activities: ToolActivity[] = [];
	const factory = createAgentFactory({ PI_DATA_DIR: directory });
	const agent = factory.create("faux", "skill-load", runtime, undefined, [], (activity) => activities.push(activity));
	assert.equal(agent.state.systemPrompt.includes(body), false);
	assert.equal(agent.state.systemPrompt.includes("Long description retained"), false);
	const skill = agent.state.tools.find((tool) => tool.name === "skill");
	assert(skill);
	const result = await skill.execute("load-complete-skill", { id: "plugin:full-skill" });
	assert(result.content.some((block) => block.type === "text" && block.text.includes(body)));
	assert.equal(activities.at(-1)?.status, "succeeded");
	assert.deepEqual(activities.at(-1)?.binding, runtime.skills[0]);
});
