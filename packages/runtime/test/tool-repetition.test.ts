import assert from "node:assert/strict";
import { test } from "node:test";
import type { AfterToolCallResult, Agent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/runtime";

function fixture(
	options: {
		language?: string;
		execute?: (toolCallId: string) => Promise<AgentToolResult<unknown>>;
		afterToolCall?: AfterToolCallResult;
	} = {},
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const calls: string[] = [];
	const parameters = Type.Object({ value: Type.Unknown() });
	const factory = createAgentFactory({
		models: { current: { models, selected: { provider: model.provider, id: model.id } } },
		recordModelRequest: () => async () => undefined,
		skills: () => ({ tools: [], afterToolCall: async () => options.afterToolCall }),
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			acquire: async () => ({ tools: [], instructions: [], release() {} }),
			async close() {},
		},
		tools: {
			catalog: [
				{ id: "echo", label: "Echo" },
				{ id: "other", label: "Other" },
			],
			create: () =>
				["echo", "other"].map((name) => {
					const tool: AgentTool = {
						name,
						label: name,
						description: "Test tool",
						parameters,
						async execute(toolCallId, args) {
							calls.push(toolCallId);
							if (options.execute) return options.execute(toolCallId);
							return {
								content: [{ type: "text", text: JSON.stringify(args) }],
								details: { toolCallId },
							};
						},
					};
					return tool;
				}),
		},
	});
	const agent = factory.create("real", "repetition-test", {
		systemPrompt: "Test tool repetition without real model calls.",
		language: options.language,
		toolIds: ["echo", "other"],
		skills: [],
		subagents: [],
	});
	return { agent, faux, calls };
}

function reply(value: unknown, name = "echo") {
	return fauxAssistantMessage([fauxToolCall(name, { value })], { stopReason: "toolUse" });
}

function results(agent: Agent) {
	return agent.state.messages.filter((message) => message.role === "toolResult");
}

function reminders(agent: Agent) {
	return results(agent).map((result) => contentText(result.content).includes("<tool-repetition-reminder>"));
}

test("repeated calls across model turns append advisory text from the third call and reach the next request", async () => {
	const { agent, faux, calls } = fixture();
	let nextMessages: Message[] = [];
	faux.setResponses([
		reply("same"),
		reply("same"),
		reply("same"),
		reply("same"),
		(context) => {
			nextMessages = structuredClone(context.messages);
			return fauxAssistantMessage("done");
		},
	]);
	await agent.prompt("Run the test");
	assert.deepEqual(reminders(agent), [false, false, true, true]);
	assert.equal(calls.length, 4);
	for (const result of results(agent)) {
		assert.deepEqual(result.content[0], { type: "text", text: '{"value":"same"}' });
		assert.deepEqual(result.details, { toolCallId: result.toolCallId });
		assert.equal(result.isError, false);
	}
	const lastResult = nextMessages.filter((message) => message.role === "toolResult").at(-1);
	assert(lastResult);
	assert.match(contentText(lastResult.content), /polling or retrying is justified/);
	assert.deepEqual(agent.state.messages.at(-1)?.content, [{ type: "text", text: "done" }]);
});

for (const scenario of [
	{
		name: "nested object key order does not affect equality",
		values: [
			{ filters: { first: 1, second: [{ left: true, right: false }] }, limit: 2 },
			{ limit: 2, filters: { second: [{ right: false, left: true }], first: 1 } },
			{ filters: { second: [{ left: true, right: false }], first: 1 }, limit: 2 },
		],
		expected: [false, false, true],
	},
	{
		name: "distinct Unicode object keys are ordered without locale normalization",
		values: [
			{ é: 1, "e\u0301": 2 },
			{ "e\u0301": 2, é: 1 },
			{ é: 1, "e\u0301": 2 },
		],
		expected: [false, false, true],
	},
	{
		name: "array order changes break the streak",
		values: [
			[1, 2],
			[2, 1],
			[1, 2],
		],
		expected: [false, false, false],
	},
	{
		name: "different arguments start a fresh streak",
		values: [1, 1, 1, 2, 1, 1, 1],
		expected: [false, false, true, false, false, false, true],
	},
	{
		name: "an additional object property changes the arguments",
		values: [{ value: 1 }, { value: 1, extra: true }, { value: 1 }],
		expected: [false, false, false],
	},
]) {
	test(scenario.name, async () => {
		const { agent, faux } = fixture();
		faux.setResponses([...scenario.values.map((value) => reply(value)), fauxAssistantMessage("done")]);
		await agent.prompt("Run the test");
		assert.deepEqual(reminders(agent), scenario.expected);
	});
}

test("a different tool breaks the streak even when the arguments are unchanged", async () => {
	const { agent, faux } = fixture();
	faux.setResponses([reply(1), reply(1, "other"), reply(1), reply(1), reply(1), fauxAssistantMessage("done")]);
	await agent.prompt("Run the test");
	assert.deepEqual(reminders(agent), [false, false, false, false, true]);
});

test("parallel calls use model order rather than completion order", async () => {
	const completed: string[] = [];
	let releaseFirst = () => {};
	let releaseSecond = () => {};
	const firstReady = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const secondReady = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	const { agent, faux } = fixture({
		execute: async (toolCallId) => {
			if (toolCallId === "first") await firstReady;
			if (toolCallId === "second") await secondReady;
			completed.push(toolCallId);
			if (toolCallId === "third") releaseSecond();
			if (toolCallId === "second") releaseFirst();
			return { content: [{ type: "text", text: toolCallId }], details: {} };
		},
	});
	faux.setResponses([
		fauxAssistantMessage(
			["first", "second", "third"].map((id) => fauxToolCall("echo", { value: 1 }, { id })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("Run the test");
	assert.deepEqual(completed, ["third", "second", "first"]);
	assert.deepEqual(
		results(agent).map((result) => result.toolCallId),
		["first", "second", "third"],
	);
	assert.deepEqual(reminders(agent), [false, false, true]);
});

test("a new user prompt resets repetition detection in the same session", async () => {
	const { agent, faux } = fixture();
	faux.setResponses([reply(1), reply(1), fauxAssistantMessage("done")]);
	await agent.prompt("First task");
	faux.setResponses([reply(1), reply(1), reply(1), fauxAssistantMessage("done")]);
	await agent.prompt("Second task");
	assert.deepEqual(reminders(agent), [false, false, false, false, true]);
});

test("a steering user message resets the streak before the next model turn", async () => {
	const { agent, faux } = fixture();
	faux.setResponses([
		reply(1),
		() => {
			agent.steer({ role: "user", content: "New instructions", timestamp: Date.now() });
			return reply(1);
		},
		reply(1),
		reply(1),
		reply(1),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("First task");
	assert.deepEqual(reminders(agent), [false, false, false, false, true]);
});

test("repetition reminders preserve tool errors and use the runtime language", async () => {
	const { agent, faux, calls } = fixture({
		language: "zh-CN",
		execute: async () => {
			throw new Error("tool unavailable");
		},
	});
	faux.setResponses([reply(1), reply(1), reply(1), fauxAssistantMessage("done")]);
	await agent.prompt("Run the test");
	assert.deepEqual(reminders(agent), [false, false, true]);
	assert.equal(calls.length, 3);
	assert(results(agent).every((result) => result.isError));
	const lastResult = results(agent).at(-1);
	assert(lastResult);
	assert.deepEqual(lastResult.content[0], { type: "text", text: "tool unavailable" });
	assert.match(contentText(lastResult.content), /连续至少 3 次/);
});

test("repetition reminders preserve skill hook overrides and do not mutate their content", async () => {
	const override: AfterToolCallResult = {
		content: [
			{ type: "text", text: "skill override" },
			{ type: "image", data: "AQ==", mimeType: "image/png" },
		],
		details: { from: "skill" },
		isError: true,
		usage: fauxAssistantMessage("").usage,
		terminate: false,
	};
	const { agent, faux } = fixture({ afterToolCall: override });
	faux.setResponses([reply(1), reply(1), reply(1), fauxAssistantMessage("done")]);
	await agent.prompt("Run the test");
	assert.deepEqual(reminders(agent), [false, false, true]);
	const lastResult = results(agent).at(-1);
	assert(lastResult);
	assert.deepEqual(lastResult.content.slice(0, 2), override.content);
	assert.equal(override.content?.length, 2);
	assert.deepEqual(lastResult.details, override.details);
	assert.deepEqual(lastResult.usage, override.usage);
	assert.equal(lastResult.isError, true);
});
