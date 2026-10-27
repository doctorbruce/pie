import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { createAgentFactory, createRuntime, type GlobalSessionEvent, type SessionEvent } from "@pie/runtime";
import { applySessionEvent } from "@pie/runtime/session-events";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

async function until(check: () => boolean) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (check()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for execution state");
}

async function start(context: TestContext, confirmation = false) {
	const directory = await mkdtemp(join(tmpdir(), "pie-execution-state-"));
	const environment = { PI_DATA_DIR: directory };
	const store = createSqliteRuntimeStore(openStore(environment));
	const stream = createAssistantMessageEventStream();
	const message = fauxAssistantMessage([], { stopReason: "pending" });
	const gates = new Map<string, () => void>();
	let modelFinished = false;
	let requests = 0;
	let pathReads = 0;
	let ledgerReads = 0;
	const readPath = store.readPath;
	const readToolExecutions = store.readToolExecutions;
	store.readPath = async (...args) => {
		pathReads++;
		return readPath(...args);
	};
	store.readToolExecutions = async (...args) => {
		ledgerReads++;
		return readToolExecutions(...args);
	};
	const finishModel = () => {
		if (modelFinished) return;
		modelFinished = true;
		stream.push({ type: "done", reason: "toolUse", message: { ...structuredClone(message), stopReason: "toolUse" } });
	};
	const factory = createAgentFactory({
		models: { current: { models: createModels() } },
		tools: {
			catalog: [{ id: "controlled", label: "Controlled tool" }],
			create: (toolContext) => [
				{
					name: "controlled",
					label: "Controlled tool",
					description: "A controlled execution for state tests",
					parameters: Type.Object({}),
					async execute(toolCallId, _input, signal) {
						if (confirmation)
							await toolContext.ask({ type: "confirmation", title: "Approve", message: "Continue?" }, signal);
						await new Promise<void>((resolve) => gates.set(toolCallId, resolve));
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		},
		skills: () => ({ tools: [], afterToolCall: async () => undefined }),
		mcp: {
			configure() {},
			status: () => ({ servers: {} }),
			async acquire() {
				return { tools: [], instructions: [], release() {} };
			},
			async close() {},
		},
		recordModelRequest: () => async () => undefined,
	});
	const runtime = await createRuntime({
		store,
		agents: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				agent.streamFunction = () => {
					if (++requests === 1) return stream;
					const next = createAssistantMessageEventStream();
					next.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
					return next;
				};
				return agent;
			},
		},
		hostRuntimes: [
			{
				assistantId: "assistant",
				assistantRevision: "1",
				runtime: { systemPrompt: "Test", toolIds: ["controlled"], skills: [], subagents: [] },
			},
		],
	});
	context.after(async () => {
		finishModel();
		for (const release of gates.values()) release();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "assistant" });
	const events: SessionEvent[] = [];
	const global: GlobalSessionEvent[] = [];
	await runtime.subscribe(session.id, (packet) => events.push(packet));
	runtime.subscribeAll((packet) => global.push(packet));
	const accepted = await runtime.submitTurn(session.id, { text: "execute" });
	stream.push({ type: "start", partial: structuredClone(message) });
	return {
		runtime,
		factory,
		store,
		environment,
		session,
		accepted,
		events,
		global,
		gates,
		finishModel,
		get pathReads() {
			return pathReads;
		},
		get ledgerReads() {
			return ledgerReads;
		},
		call(id: string) {
			const toolCall = fauxToolCall("controlled", {}, { id });
			const contentIndex = message.content.length;
			message.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex, partial: structuredClone(message) });
			stream.push({ type: "toolcall_delta", contentIndex, delta: "{}", partial: structuredClone(message) });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: structuredClone(message) });
		},
	};
}

test(
	"execution snapshots and deltas retain overlapping model/tools and parallel tool identity",
	{ timeout: 15000 },
	async (context) => {
		const host = await start(context);
		const baselineReads = host.pathReads;
		host.call("first");
		await until(() => host.gates.has("first"));
		const overlapping = await host.runtime.getSession(host.session.id, { limit: 50 });
		assert.equal(overlapping.execution.modelStreaming, true);
		assert.deepEqual(overlapping.execution.activeTools, [{ toolCallId: "first", toolName: "controlled" }]);
		host.gates.get("first")!();
		await until(() => host.events.some((packet) => packet.event?.type === "tool_execution_end"));
		const stillStreaming = await host.runtime.getSession(host.session.id, { limit: 50 });
		assert.equal(stillStreaming.execution.modelStreaming, true);
		assert.deepEqual(stillStreaming.execution.activeTools, []);
		host.call("second");
		host.call("third");
		host.finishModel();
		await until(() => host.gates.has("second"));
		const parallel = await host.runtime.getSession(host.session.id, { limit: 50 });
		assert.equal(parallel.execution.modelStreaming, false);
		assert.equal(parallel.execution.activeTools.length, 2);
		host.gates.get("second")!();
		await until(() => host.events.at(-1)?.execution?.activeTools.length === 1);
		assert.deepEqual(host.events.at(-1)?.execution?.activeTools, [{ toolCallId: "third", toolName: "controlled" }]);
		host.gates.get("third")!();
		await until(() => host.events.some((packet) => packet.type === "turn.settled"));
		assert.equal(host.pathReads, baselineReads);
		assert.equal(host.ledgerReads, 0);
		const settled = await host.runtime.waitForTurn(host.session.id);
		assert.equal(settled.turn?.status, "completed");
		assert.deepEqual(settled.execution, host.session.execution);
		let projected = host.session;
		for (const packet of host.events) {
			const next = applySessionEvent(projected, packet);
			assert(next);
			projected = next;
			const global = host.global.find((entry) => entry.snapshot.revision === packet.revision);
			assert.deepEqual(packet.execution, global?.snapshot.execution);
			assert.equal("messages" in global!.snapshot, false);
		}
		assert.deepEqual(projected.execution, settled.execution);
		assert.deepEqual(projected.turn, settled.turn);
		assert.deepEqual(projected.execution, (await host.runtime.getSession(host.session.id, { limit: 50 })).execution);
		assert.equal("execution" in (await host.store.readSession(host.session.id))!, false);
	},
);

test(
	"waiting for confirmation is a separate axis from model and tool activity",
	{ timeout: 15000 },
	async (context) => {
		const host = await start(context, true);
		host.call("confirm");
		await until(() => host.events.some((packet) => packet.type === "interaction.requested"));
		const waiting = await host.runtime.getSession(host.session.id, { limit: 50 });
		assert.equal(waiting.execution.waitingForInteraction, true);
		assert.equal(waiting.execution.modelStreaming, true);
		assert.equal(waiting.execution.activeTools.length, 1);
		await host.runtime.replyInteraction(host.session.id, waiting.interactions[0].id, { approved: true });
		await until(() => host.gates.has("confirm"));
		assert.equal(
			host.events.find((packet) => packet.type === "interaction.resolved")?.execution?.waitingForInteraction,
			false,
		);
		host.gates.get("confirm")!();
		host.finishModel();
		assert.equal((await host.runtime.waitForTurn(host.session.id)).execution.waitingForInteraction, false);
	},
);

test(
	"cancellation acknowledgement exposes stopping without claiming a terminal outcome",
	{ timeout: 15000 },
	async (context) => {
		const host = await start(context);
		host.call("slow");
		await until(() => host.gates.has("slow"));
		host.finishModel();
		await host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId });
		const stopping = await host.runtime.getSession(host.session.id, { limit: 50 });
		assert.equal(stopping.turn?.status, "running");
		assert.equal(stopping.execution.cancellationRequested, true);
		assert.equal(stopping.execution.activeTools.length, 1);
		assert(host.events.some((packet) => packet.execution?.cancellationRequested));
		assert.equal(
			host.events.some((packet) => packet.type === "turn.settled"),
			false,
		);
		host.gates.get("slow")!();
		const settled = await host.runtime.waitForTurn(host.session.id);
		assert.equal(settled.turn?.status, "cancelled");
		assert.deepEqual(settled.execution, host.session.execution);
	},
);

test(
	"reactivation retains interrupted status and blockers without reviving process-local work",
	{ timeout: 15000 },
	async (context) => {
		const host = await start(context);
		host.finishModel();
		await host.runtime.waitForTurn(host.session.id);
		const saved = await host.store.readSession(host.session.id);
		assert(saved);
		await host.runtime.close();
		const store = createSqliteRuntimeStore(openStore(host.environment));
		await store.saveSession({
			...saved,
			turn: { id: host.accepted.turnId, status: "interrupted", error: "owner lost" },
			turnCheckpoint: {
				version: 1,
				turnId: host.accepted.turnId,
				inputEntryId: "input",
				systemPrompt: "Test",
				blockedReason: "unknown outcome",
			},
			messages: [],
		});
		const runtime = await createRuntime({ store, agents: host.factory });
		try {
			const reactivated = await runtime.getSession(host.session.id, { limit: 50 });
			assert.equal(reactivated.turn?.status, "interrupted");
			assert.deepEqual(reactivated.execution, {
				...host.session.execution,
				recoveryBlockedReason: "unknown outcome",
			});
		} finally {
			await runtime.close();
		}
	},
);
