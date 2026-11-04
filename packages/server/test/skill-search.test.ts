import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/local/agent";
import type { RuntimeConfig, ToolActivity } from "@pie/runtime/protocol";

type SearchResult = {
	skills: { id: string; name: string; description: string }[];
	total: number;
	shown: number;
	truncated: boolean;
};

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-skill-search-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const factory = createAgentFactory(
		{ PI_DATA_DIR: directory },
		{
			tools: { catalog: [], create: () => [] },
			skills: () => ({ tools: [], afterToolCall: async () => undefined }),
		},
	);
	const runtime: RuntimeConfig = {
		systemPrompt: "Host instructions",
		language: "zh",
		toolIds: [],
		subagents: [],
		skills: [
			{
				id: "plugin-a:shared",
				name: "shared",
				description: "Search a knowledge base.",
				descriptions: { "zh-CN": "检索知识库", fr: "Chercher des archives" },
				directory: join(directory, "never-created"),
			},
			{
				id: "plugin-b:shared",
				name: "shared",
				description: "Write documents; complements plugin-a:shared.",
				directory: join(directory, "also-missing"),
			},
		],
	};
	return { factory, runtime, directory };
}

async function search(agent: Agent, query: string, limit?: number): Promise<SearchResult> {
	const tool = agent.state.tools.find((candidate) => candidate.name === "skill_search");
	assert(tool, "Mounted skills must expose skill_search");
	const result = await tool.execute("search", { query, ...(limit === undefined ? {} : { limit }) });
	return JSON.parse(contentText(result.content));
}

test("skill search discovers mounted IDs, names and multilingual descriptions without reading skill files", async (context) => {
	const { factory, runtime, directory } = await fixture(context);
	const activities: ToolActivity[] = [];
	const agent = factory.create("faux", "discovery", runtime, undefined, [], (activity) => activities.push(activity));
	for (const query of ["知识库", "KNOWLEDGE", "archives", "plugin-a:shared"]) {
		assert.deepEqual(await search(agent, query), {
			skills: [{ id: "plugin-a:shared", name: "shared", description: "检索知识库" }],
			total: 1,
			shown: 1,
			truncated: false,
		});
	}
	assert.equal((await search(agent, "shared")).total, 2);
	assert.deepEqual(await search(agent, "unavailable payroll"), {
		skills: [],
		total: 0,
		shown: 0,
		truncated: false,
	});
	assert.equal(JSON.stringify(await search(agent, "list")).includes(directory), false);
	assert.deepEqual(activities, []);
	const english = factory.create("faux", "english", { ...runtime, language: "en-US" });
	assert.equal((await search(english, "知识库")).skills[0]?.description, "Search a knowledge base.");
	const beyondIndex = factory.create("faux", "full-description", {
		...runtime,
		language: "en-US",
		skills: [{ ...runtime.skills[0], description: `${"x".repeat(170)} retained-keyword`, descriptions: undefined }],
	});
	assert.doesNotMatch(beyondIndex.state.systemPrompt, /retained-keyword/);
	assert.equal((await search(beyondIndex, "retained-keyword")).skills[0]?.id, "plugin-a:shared");
	const caseSensitive = factory.create("faux", "case-sensitive-ids", {
		...runtime,
		skills: ["A/pdf", "a/pdf"].map((id) => ({ ...runtime.skills[0], id })),
	});
	for (const id of ["A/pdf", "a/pdf"])
		assert.deepEqual(
			(await search(caseSensitive, id)).skills.map((skill) => skill.id),
			[id],
		);
});

test("skill search inventories are bounded and isolated to each session's mounted skills", async (context) => {
	const { factory, runtime } = await fixture(context);
	const skills = Array.from({ length: 105 }, (_, index) => ({
		id: `plugin:skill-${String(index).padStart(3, "0")}`,
		name: `skill-${index}`,
		description: "Search records",
		directory: runtime.skills[0].directory,
	}));
	const agent = factory.create("faux", "many-skills", { ...runtime, skills });
	for (const query of ["", "list"]) {
		const result = await search(agent, query);
		assert.equal(result.total, 105);
		assert.equal(result.shown, 100);
		assert.equal(result.skills.length, 100);
		assert.equal(result.truncated, true);
	}
	assert.equal((await search(agent, "records")).shown, 20);
	const limited = await search(agent, "records", 1);
	assert.deepEqual(
		limited.skills.map((skill) => skill.id),
		["plugin:skill-000"],
	);
	assert.equal(limited.total, 105);
	assert.equal(limited.shown, 1);
	assert.equal(limited.truncated, true);
	const isolated = factory.create("faux", "one-skill", { ...runtime, skills: [skills[104]] });
	assert.deepEqual(
		(await search(isolated, "list")).skills.map((skill) => skill.id),
		["plugin:skill-104"],
	);
});

test("skill discovery guidance and tool availability agree for mounted, empty and disabled runtimes", async (context) => {
	const { factory, runtime } = await fixture(context);
	for (const language of ["zh", "en-US"]) {
		const enabled = factory.create("faux", `enabled-${language}`, { ...runtime, language });
		assert(enabled.state.tools.some((tool) => tool.name === "skill_search"));
		assert.doesNotMatch(enabled.state.systemPrompt, /skill_search/);
		assert.match(factory.composeCapabilityCatalog({ ...runtime, language }), /skill_search/);
		const disabled = factory.create("faux", `disabled-${language}`, {
			...runtime,
			language,
			toolAvailability: { skill_search: false },
		});
		assert.equal(
			disabled.state.tools.some((tool) => tool.name === "skill_search"),
			false,
		);
		assert.doesNotMatch(disabled.state.systemPrompt, /skill_search/);
		assert.doesNotMatch(
			factory.composeCapabilityCatalog({ ...runtime, language, toolAvailability: { skill_search: false } }),
			/skill_search/,
		);
	}
	const empty = factory.create("faux", "no-skills", { ...runtime, skills: [] });
	assert.equal(
		empty.state.tools.some((tool) => tool.name === "skill_search"),
		false,
	);
	assert.doesNotMatch(empty.state.systemPrompt, /skill_search/);
});

test("the Agent loop validates skill-search arguments before execution", async (context) => {
	const { factory, runtime } = await fixture(context);
	for (const [index, args] of [
		{},
		{ query: { invalid: true } },
		{ query: "list", limit: 0 },
		{ query: "list", limit: 101 },
	].entries()) {
		const agent = factory.create("faux", `invalid-${index}`, runtime);
		await agent.prompt(`调用工具 skill_search ${JSON.stringify(args)}`);
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		assert(result && result.role === "toolResult");
		assert.equal(result.toolName, "skill_search");
		assert.equal(result.isError, true, JSON.stringify(args));
		assert.match(contentText(result.content), /validation|invalid|query|limit/i);
	}
});

test("host catalogs and external files cannot shadow the built-in skill search", async (context) => {
	const { directory } = await fixture(context);
	assert.throws(
		() =>
			createAgentFactory(
				{ PI_DATA_DIR: directory },
				{ tools: { catalog: [{ id: "skill_search", label: "Shadowed search" }], create: () => [] } },
			),
		/保留名称/,
	);
	const tools = join(directory, "tools");
	await mkdir(tools);
	await writeFile(join(tools, "skill_search.ts"), 'throw new Error("reserved file must not load");');
	assert.throws(() => createAgentFactory({ PI_DATA_DIR: directory, PI_TOOLS_DIR: tools }), /工具 ID 重复/);
});
