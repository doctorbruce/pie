import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/runtime/agent";
import type { WorkerEnqueueResult } from "@pie/runtime/coordination";
import type { RuntimeConfig } from "@pie/runtime/protocol";
import type {
	WorkerSessionCommunication,
	WorkerWaitOptions,
	WorkerWaitResult,
} from "@pie/runtime/worker-communication";

function fixture(
	communication?: WorkerSessionCommunication,
	toolAvailability?: Record<string, boolean>,
	workerWaitMode?: RuntimeConfig["workerWaitMode"],
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const factory = createAgentFactory({
		models: { current: { models, selected: { provider: model.provider, id: model.id } } },
		recordModelRequest: () => async () => undefined,
		skills: () => ({ tools: [], afterToolCall: async () => undefined }),
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			acquire: async () => ({ tools: [], instructions: [], release() {} }),
			async close() {},
		},
		tools: { catalog: [], create: () => [] },
	});
	const runtime: RuntimeConfig = {
		systemPrompt: "Communicate through tools without a real provider.",
		toolIds: [],
		skills: [],
		subagents: [
			{
				id: "legacy-task-id",
				assistantId: "legacy-assistant",
				name: "Old assistant",
				description: "Old task target",
				runtime: { systemPrompt: "target", toolIds: [], skills: [] },
			},
		],
		toolAvailability,
		workerWaitMode,
		permissions: { task: "allow" },
	};
	const agent = factory.create(
		"real",
		"source-session",
		runtime,
		undefined,
		[],
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		communication,
	);
	return { agent, faux, factory };
}

function savedReceipt(): WorkerEnqueueResult {
	return {
		message: {
			messageId: "saved-message",
			deliveryId: "saved-delivery",
			workerId: "target-assistant",
			sourceWorkerId: "source-assistant",
			sourceSessionId: "source-session",
			sourceTurnId: "source-turn",
			kind: "request",
			content: "review",
			sequence: 1,
			status: "queued",
			createdAt: 1,
		},
		delivery: {
			deliveryId: "saved-delivery",
			messageId: "saved-message",
			workerId: "target-assistant",
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

function results(messages: AgentMessage[]) {
	return messages.filter((message) => message.role === "toolResult");
}

function waitingRecord(): WorkerWaitResult["wait"] {
	return {
		waitId: "communicate-wait",
		workerId: "source-assistant",
		sessionId: "source-session",
		turnId: "source-turn",
		toolCallId: "communicate-call",
		messageId: "saved-message",
		status: "waiting",
		createdAt: 1,
		updatedAt: 1,
	};
}

test("Worker sessions expose one communicate tool and can send without waiting", async () => {
	let sent: unknown;
	let waited = false;
	const { agent, faux } = fixture({
		targets: [{ assistantId: "target-assistant", name: "Reviewer", description: "Review contracts" }],
		async send(_toolCallId, input) {
			sent = input;
			return savedReceipt();
		},
		async wait() {
			waited = true;
			throw new Error("wait=false must not wait");
		},
	});
	assert.deepEqual(
		agent.state.tools.map((tool) => tool.name),
		["communicate"],
	);
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"communicate",
					{ to: "target-assistant", content: "review", wait: false },
					{ id: "communicate-call" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("message saved"),
	]);
	await agent.prompt("Send a one-way Worker message");
	assert.deepEqual(sent, { to: "target-assistant", content: "review" });
	assert.equal(waited, false);
	const saved = results(agent.state.messages)[0];
	assert(saved && !saved.isError);
	assert.deepEqual(saved.details, { sent: savedReceipt() });
});

test("communicate waits for request replies using the host default", async () => {
	let waitOptions: WorkerWaitOptions | undefined;
	const waiting: WorkerWaitResult = {
		wait: { ...waitingRecord(), mode: "sync", status: "ready" },
		messages: [],
	};
	const { agent, faux } = fixture(
		{
			targets: [{ assistantId: "target-assistant", name: "Reviewer", description: "Review contracts" }],
			async send() {
				return savedReceipt();
			},
			async wait(toolCallId, messageId, _signal, options) {
				assert.equal(toolCallId, "communicate-call");
				assert.equal(messageId, "saved-message");
				waitOptions = options;
				return waiting;
			},
		},
		undefined,
		"sync",
	);
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("communicate", { to: "target-assistant", content: "review" }, { id: "communicate-call" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("review complete"),
	]);
	await agent.prompt("Send and wait in one operation");
	assert.deepEqual(waitOptions, { mode: "sync" });
	const saved = results(agent.state.messages)[0];
	assert(saved && !saved.isError);
	assert.deepEqual(saved.details, { sent: savedReceipt(), wait: waiting });
});

test("communicate publishes its saved receipt while the synchronous tool is still waiting", async () => {
	let startWait!: () => void;
	const started = new Promise<void>((resolve) => {
		startWait = resolve;
	});
	let finishWait!: (result: WorkerWaitResult) => void;
	const response = new Promise<WorkerWaitResult>((resolve) => {
		finishWait = resolve;
	});
	const updates: unknown[] = [];
	const { agent, faux } = fixture(
		{
			targets: [],
			async send() {
				return savedReceipt();
			},
			async wait() {
				startWait();
				return response;
			},
		},
		undefined,
		"sync",
	);
	agent.subscribe((event) => {
		if (event.type === "tool_execution_update") updates.push(event.partialResult.details);
	});
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("communicate", { to: "target-assistant", content: "review" }, { id: "communicate-call" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("review complete"),
	]);
	const prompt = agent.prompt("Send and keep waiting for the reviewer");
	await started;
	try {
		assert.deepEqual(updates, [{ sent: savedReceipt() }]);
		assert.deepEqual(results(agent.state.messages), []);
	} finally {
		finishWait({ wait: { ...waitingRecord(), mode: "sync", status: "ready" }, messages: [] });
		await prompt;
	}
	assert.equal(results(agent.state.messages).length, 1);
});

test("communicate schema rejects forged execution fields before calling communication", async () => {
	let calls = 0;
	const { agent, faux } = fixture({
		targets: [],
		async send() {
			calls++;
			return savedReceipt();
		},
		async wait() {
			calls++;
			throw new Error("not called");
		},
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("communicate", { to: "target-assistant", content: "review", sourceWorkerId: "forged" }),
				fauxToolCall("communicate", { to: "target-assistant", content: "review", kind: "invalid" }),
				fauxToolCall("communicate", { to: "target-assistant", content: "review", wait: { mode: "invalid" } }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("invalid calls rejected"),
	]);
	await agent.prompt("Attempt invalid arguments");
	assert.equal(results(agent.state.messages).length, 3);
	assert(results(agent.state.messages).every((result) => result.isError));
	assert.equal(calls, 0);
});

test("communicate sends trusted reverse replies without waiting", async () => {
	let sent: unknown;
	const { agent, faux } = fixture({
		targets: [],
		async send(_call, input) {
			sent = input;
			return savedReceipt();
		},
		async wait() {
			throw new Error("reply defaults to one-way");
		},
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("communicate", {
					to: "original-sender",
					content: "answer",
					kind: "reply",
					reply_to: "original-message",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("reply saved"),
	]);
	await agent.prompt("Reply using the trusted message association");
	assert.deepEqual(sent, { to: "original-sender", content: "answer", kind: "reply", reply_to: "original-message" });
	assert.equal(results(agent.state.messages)[0]?.isError, false);
});

test("communicate supports explicit async waiting", async () => {
	let options: WorkerWaitOptions | undefined;
	const { agent, faux } = fixture(
		{
			targets: [],
			async send() {
				return savedReceipt();
			},
			async wait(_toolCallId, _messageId, _signal, waitOptions) {
				options = waitOptions;
				return { wait: { ...waitingRecord(), mode: "async", status: "waiting" }, messages: [] };
			},
		},
		undefined,
		"sync",
	);
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("communicate", { to: "target-assistant", content: "review", wait: { mode: "async" } })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("waiting for the reviewer"),
	]);
	await agent.prompt("Wait asynchronously");
	assert.deepEqual(options, { mode: "async" });
	assert.equal(results(agent.state.messages)[0]?.isError, false);
});

test("tool availability can disable communicate without restoring task", () => {
	const { agent } = fixture(
		{
			targets: [],
			async send() {
				return savedReceipt();
			},
			async wait() {
				throw new Error("not called");
			},
		},
		{ communicate: false },
	);
	assert.deepEqual(agent.state.tools, []);
});

test("sessions without communication never restore task from subagent bindings", async () => {
	const { agent, faux } = fixture();
	assert.deepEqual(agent.state.tools, []);
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("task", { description: "Review", prompt: "review", subagent_type: "legacy-task-id" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("unsupported tool rejected"),
	]);
	await agent.prompt("Attempt a removed task call");
	assert.equal(results(agent.state.messages)[0]?.isError, true);
});
