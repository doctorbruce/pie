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
import {
	createAgentFactory,
	createRuntime,
	type ExecutionStreamEvent,
	type GlobalSessionEvent,
	type SessionAction,
	type SessionEvent,
	type Turn,
} from "@pie/runtime";
import { applySessionEvent } from "@pie/runtime/session-events";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

async function until(check: () => boolean) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (check()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for execution state");
}

async function start(context: TestContext, confirmation = false, sessionRetention?: "release-after-turn") {
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
		sessionRetention,
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
		get requests() {
			return requests;
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
		assert.equal(settled.execution.actions.submit.available, true);
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
		assert(Array.isArray(stopping.execution.activeTools));
		assert(host.events.some((packet) => packet.execution?.cancellationRequested));
		assert.equal(
			host.events.some((packet) => packet.type === "turn.settled"),
			false,
		);
		host.gates.get("slow")!();
		const settled = await host.runtime.waitForTurn(host.session.id);
		assert.equal(settled.turn?.status, "cancelled");
		assert.equal(settled.execution.actions.submit.available, true);
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
				modelStreaming: false,
				activeTools: [],
				waitingForInteraction: false,
				cancellationRequested: false,
				actions: {
					submit: { available: false, reason: "turn_interrupted" },
					steer: { available: false, reason: "turn_interrupted" },
					cancel: { available: true },
					resume: { available: false, reason: "recovery_blocked" },
				},
				recoveryBlockedReason: "unknown outcome",
			});
		} finally {
			await runtime.close();
		}
	},
);

for (const boundary of ["tool start", "assistant end", "cancel"] as const) {
	test(
		`published revision keeps its execution and Turn while ${boundary} persistence is blocked`,
		{ timeout: 15000 },
		async (context) => {
			const host = await start(context);
			await until(() => host.events.some((packet) => packet.event?.type === "message_start"));
			let release = () => {};
			let entered = false;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			context.after(() => release());
			const save = host.store.saveSession;
			host.store.saveSession = async (...args) => {
				const [session, , records] = args;
				if (
					(boundary === "tool start" && records?.some((record) => record.phase === "started")) ||
					(boundary === "assistant end" && session.messages.some((message) => message.role === "assistant")) ||
					(boundary === "cancel" && session.turnCheckpoint?.cancelRequested)
				) {
					entered = true;
					await blocked;
				}
				return save(...args);
			};
			let cancellation: Promise<unknown> | undefined;
			if (boundary === "tool start") host.call("blocked");
			else if (boundary === "assistant end") host.finishModel();
			else cancellation = host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId });
			try {
				await until(() => entered);
				const snapshot = await host.runtime.getSession(host.session.id, { limit: 50 });
				const published = host.events.find((packet) => packet.revision === snapshot.revision);
				assert(published);
				assert.deepEqual(snapshot.execution, published.execution);
				assert.deepEqual(snapshot.turn, published.turn);
				assert.deepEqual(
					snapshot.execution,
					host.global.find((packet) => packet.snapshot.revision === snapshot.revision)?.snapshot.execution,
				);
			} finally {
				release();
				await cancellation;
				if (boundary === "tool start") {
					await until(() => host.gates.has("blocked"));
					host.gates.get("blocked")!();
				}
			}
		},
	);
}

test(
	"complete asynchronous snapshots pin the same history leaf as their execution revision",
	{ timeout: 15000 },
	async (context) => {
		const host = await start(context);
		host.call("history");
		await until(() => host.gates.has("history"));
		const baseline = await host.runtime.getSession(host.session.id);
		let release = () => {};
		let entered = false;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = host.store.readPath;
		host.store.readPath = async (...args) => {
			entered = true;
			await blocked;
			return read(...args);
		};
		const pending = host.runtime.getSession(host.session.id);
		try {
			await until(() => entered);
			host.gates.get("history")!();
			host.finishModel();
			await until(() => host.events.some((packet) => packet.type === "turn.settled"));
		} finally {
			release();
		}
		const snapshot = await pending;
		assert.equal(snapshot.revision, baseline.revision);
		assert.deepEqual(snapshot.execution, baseline.execution);
		assert.deepEqual(snapshot.messages, baseline.messages);
	},
);

test("storage failure publishes a new execution revision for another idle session", async (context) => {
	const host = await start(context);
	host.finishModel();
	await host.runtime.waitForTurn(host.session.id);
	const idle = await host.runtime.createSession({ assistantId: "assistant" });
	const events: SessionEvent[] = [];
	await host.runtime.subscribe(idle.id, (packet) => events.push(packet));
	const save = host.store.saveSession;
	host.store.saveSession = async (...args) => {
		if (args[0].id === host.session.id) throw new Error("storage unavailable");
		return save(...args);
	};
	await assert.rejects(host.runtime.submitTurn(host.session.id, { text: "fail" }), /storage unavailable/);
	const snapshot = await host.runtime.getSession(idle.id, { limit: 1 });
	assert(snapshot.revision > idle.revision);
	assert.deepEqual(snapshot.execution.actions.submit, { available: false, reason: "storage_unavailable" });
	assert.deepEqual(events.find((packet) => packet.revision === snapshot.revision)?.execution, snapshot.execution);
	for (const operation of [
		() => host.runtime.submitTurn(idle.id, { text: "new" }),
		() => host.runtime.steer(idle.id, { text: "new", turnId: "turn" }),
		() => host.runtime.cancelTurn(idle.id, { turnId: "turn" }),
		() => host.runtime.resumeTurn(idle.id, { turnId: "turn" }),
	])
		await assert.rejects(operation(), { status: 503, reason: "storage_unavailable" });
});

test("an admitted command keeps the storage rejection contract if another session fails during its history read", async (context) => {
	const host = await start(context);
	const saved = await host.store.readSession(host.session.id);
	assert(saved);
	await host.store.saveSession({
		...saved,
		id: "delayed-admission",
		turn: undefined,
		turnCheckpoint: undefined,
		messages: [],
		tree: { nodes: [], leafId: null },
	});
	let entered = false;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const read = host.store.readWorkingPath;
	host.store.readWorkingPath = async (...args) => {
		if (args[0] === "delayed-admission") {
			entered = true;
			await blocked;
		}
		return read(...args);
	};
	const save = host.store.saveSession;
	host.store.saveSession = async (...args) => {
		if (args[0].id === host.session.id) throw new Error("another session failed");
		return save(...args);
	};
	const admission = host.runtime.submitTurn("delayed-admission", { text: "must not start" });
	try {
		await until(() => entered);
		host.finishModel();
		await until(() => !host.runtime.storageAvailable);
	} finally {
		release();
	}
	await assert.rejects(admission, { status: 503, reason: "storage_unavailable" });
	assert.equal(
		host.global.some((packet) => packet.sessionId === "delayed-admission" && packet.event?.type === "agent_start"),
		false,
	);
	assert.equal((await host.store.readSession("delayed-admission"))?.turn, undefined);
	assert.equal((await host.runtime.getSession("delayed-admission", { limit: 1 })).turn, undefined);
});

test("storage failure fanout waits for another command to roll back its uncommitted Turn", async (context) => {
	const host = await start(context);
	const idle = await host.runtime.createSession({ assistantId: "assistant" });
	let entered = false;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	host.store.saveSession = async (session) => {
		if (session.id === idle.id) {
			entered = true;
			await blocked;
		}
		throw new Error("write rejected");
	};
	const admission = host.runtime.submitTurn(idle.id, { text: "not committed" });
	try {
		await until(() => entered);
		host.finishModel();
		await until(() => host.events.some((packet) => packet.type === "turn.settled"));
	} finally {
		release();
	}
	await assert.rejects(admission, { reason: "storage_unavailable" });
	const snapshot = await host.runtime.getSession(idle.id, { limit: 1 });
	assert.equal(snapshot.turn, undefined);
	assert.deepEqual(snapshot.execution.actions.submit, { available: false, reason: "storage_unavailable" });
	assert.equal(
		host.global.some((packet) => packet.sessionId === idle.id && packet.snapshot.turn !== undefined),
		false,
	);
	assert.equal((await host.store.readSession(idle.id))?.turn, undefined);
});

test("storage failure during another Turn's MCP preparation cannot start a new model request", async (context) => {
	const host = await start(context);
	await until(() => host.requests === 1);
	const idle = await host.runtime.createSession({ assistantId: "assistant" });
	let entered = false;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const acquire = host.factory.mcp.acquire;
	host.factory.mcp.acquire = async (...args) => {
		entered = true;
		await blocked;
		return acquire(...args);
	};
	await host.runtime.submitTurn(idle.id, { text: "committed before storage failed" });
	try {
		await until(() => entered);
		host.store.saveSession = async () => {
			throw new Error("storage failed");
		};
		host.finishModel();
		await until(() => !host.runtime.storageAvailable);
	} finally {
		release();
	}
	const settled = await host.runtime.waitForTurn(idle.id);
	assert.equal(settled.turn?.status, "failed");
	assert.equal(host.requests, 1, "No new provider call may cross the failed storage barrier");
});

test("control entry decisions match projected availability across cold lifecycle and recovery states", async (context) => {
	const host = await start(context);
	host.finishModel();
	await host.runtime.waitForTurn(host.session.id);
	const saved = await host.store.readSession(host.session.id);
	assert(saved);
	const actions: SessionAction[] = ["submit", "steer", "cancel", "resume"];
	let index = 0;
	for (const status of [undefined, "completed", "cancelled", "failed", "interrupted"] satisfies (
		| Turn["status"]
		| undefined
	)[]) {
		for (const blocked of status === "interrupted" ? [false, true] : [false]) {
			for (const kind of ["root", "subagent"] as const) {
				for (const action of actions) {
					const id = `matrix-${++index}`;
					const inputId = `input-${index}`;
					const message = { role: "user" as const, content: "input", timestamp: 1 };
					await host.store.saveSession({
						...saved,
						id,
						kind,
						turn: status ? { id: "turn", status } : undefined,
						turnCheckpoint:
							status === "interrupted"
								? {
										version: 1,
										turnId: "turn",
										inputEntryId: inputId,
										systemPrompt: "test",
										...(blocked ? { blockedReason: "unknown work" } : {}),
									}
								: undefined,
						messages: [message],
						tree: { leafId: inputId, nodes: [{ id: inputId, parentId: null, message }] },
					});
					const snapshot = await host.runtime.getSession(id, { limit: 1 });
					const operation = () =>
						action === "submit"
							? host.runtime.submitTurn(id, { text: "next" })
							: action === "steer"
								? host.runtime.steer(id, { turnId: "turn", text: "next" })
								: action === "cancel"
									? host.runtime.cancelTurn(id, { turnId: "turn" })
									: host.runtime.resumeTurn(id, { turnId: "turn" });
					const availability = snapshot.execution.actions[action];
					if (kind === "root" && action === "cancel" && status && status !== "interrupted") {
						assert.equal((await operation()).accepted, false, "Terminal cancellation is an explicit no-op");
					} else if (availability.available) {
						assert.equal((await operation()).accepted, true, `${kind}/${status}/${action}`);
						await host.runtime.waitForTurn(id);
					} else {
						await assert.rejects(operation(), { status: 409, reason: availability.reason });
					}
				}
			}
		}
	}
	await host.runtime.close();
	for (const operation of [
		() => host.runtime.submitTurn(host.session.id, { text: "next" }),
		() => host.runtime.steer(host.session.id, { text: "next", turnId: host.accepted.turnId }),
		() => host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId }),
		() => host.runtime.resumeTurn(host.session.id, { turnId: host.accepted.turnId }),
	])
		await assert.rejects(operation(), { status: 503, reason: "runtime_closing" });
});

test("failed storage distinguishes a retry, a rejected new command and explicit best-effort stop", async (context) => {
	const host = await start(context);
	host.call("stop");
	await until(() => host.gates.has("stop"));
	await host.runtime.steer(host.session.id, { turnId: host.accepted.turnId, text: "queued", requestId: "retry" });
	const idle = await host.runtime.createSession({ assistantId: "assistant" });
	host.store.saveSession = async () => {
		throw new Error("disk failed");
	};
	await assert.rejects(host.runtime.submitTurn(idle.id, { text: "fail" }), /disk failed/);
	assert.equal(
		(await host.runtime.submitTurn(host.session.id, { text: "queued", requestId: "retry" })).turnId,
		host.accepted.turnId,
	);
	await assert.rejects(host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId }), {
		reason: "storage_unavailable",
	});
	await assert.rejects(host.runtime.cancelTurn(host.session.id, { turnId: "stale", bestEffort: true }), {
		reason: "turn_mismatch",
	});
	const receipt = await host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId, bestEffort: true });
	assert.equal(receipt.accepted, true);
	assert.equal(receipt.cancellationRequested, true);
	assert.equal(receipt.durable, false);
	host.gates.get("stop")!();
	assert.equal(
		(await host.runtime.waitForTurn(host.session.id)).turn?.status,
		"failed",
		"Failed persistence cannot acknowledge a durable cancelled outcome",
	);
});

test("four controls follow running and cancellation decisions while cancellation retries share acknowledgement", async (context) => {
	const host = await start(context);
	host.call("control");
	await until(() => host.gates.has("control"));
	const running = await host.runtime.getSession(host.session.id, { limit: 1 });
	assert.equal(running.execution.actions.steer.available, true);
	assert.equal(running.execution.actions.cancel.available, true);
	for (const [action, operation] of [
		["submit", () => host.runtime.submitTurn(host.session.id, { text: "new" })],
		["resume", () => host.runtime.resumeTurn(host.session.id, { turnId: host.accepted.turnId })],
	] as const)
		await assert.rejects(operation(), { reason: running.execution.actions[action].reason });
	assert.equal(
		(await host.runtime.steer(host.session.id, { turnId: host.accepted.turnId, text: "queued" })).queued,
		true,
	);
	let release = () => {};
	let entered = false;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const save = host.store.saveSession;
	host.store.saveSession = async (...args) => {
		entered = true;
		await blocked;
		return save(...args);
	};
	const cancellation = host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId });
	try {
		await until(() => entered && host.events.some((packet) => packet.execution?.cancellationRequested));
		const stopping = await host.runtime.getSession(host.session.id, { limit: 1 });
		for (const [action, operation] of [
			["submit", () => host.runtime.submitTurn(host.session.id, { text: "new" })],
			["steer", () => host.runtime.steer(host.session.id, { turnId: host.accepted.turnId, text: "late" })],
			["resume", () => host.runtime.resumeTurn(host.session.id, { turnId: host.accepted.turnId })],
		] as const)
			await assert.rejects(operation(), { reason: stopping.execution.actions[action].reason });
		assert.equal(stopping.execution.actions.cancel.available, false);
		const retry = host.runtime.cancelTurn(host.session.id, { turnId: host.accepted.turnId });
		release();
		assert.deepEqual(await retry, await cancellation);
	} finally {
		release();
		host.gates.get("control")?.();
		host.finishModel();
		await cancellation;
	}
	assert.equal((await host.runtime.waitForTurn(host.session.id)).turn?.status, "cancelled");
});

test("resume availability is a preflight boundary and invalid history returns a stable rejection", async (context) => {
	const host = await start(context);
	host.finishModel();
	await host.runtime.waitForTurn(host.session.id);
	const saved = await host.store.readSession(host.session.id);
	assert(saved);
	await host.store.saveSession({
		...saved,
		id: "invalid-recovery",
		turn: { id: "turn", status: "interrupted" },
		turnCheckpoint: { version: 1, turnId: "turn", inputEntryId: "missing", systemPrompt: "test" },
		messages: [],
		tree: { nodes: [], leafId: null },
	});
	const snapshot = await host.runtime.getSession("invalid-recovery", { limit: 1 });
	assert.equal(snapshot.execution.actions.resume.available, true);
	await assert.rejects(host.runtime.resumeTurn("invalid-recovery", { turnId: "turn" }), {
		status: 409,
		reason: "recovery_validation_failed",
	});
	assert.equal((await host.runtime.getSession("invalid-recovery", { limit: 1 })).turn?.status, "interrupted");
});

test("scoped execution subscriptions bootstrap settled sessions without reading history and align later events", async (context) => {
	const host = await start(context);
	const reads = host.pathReads;
	const frames: ExecutionStreamEvent[] = [];
	const unsubscribe = await host.runtime.subscribeExecutions([host.session.id], (packet) => frames.push(packet));
	host.finishModel();
	await until(() => host.events.some((packet) => packet.type === "turn.settled"));
	unsubscribe();
	const completed = host.events.find((packet) => packet.type === "turn.settled")!;
	const reconnected: ExecutionStreamEvent[] = [];
	const close = await host.runtime.subscribeExecutions([host.session.id], (packet) => reconnected.push(packet));
	assert.equal(host.pathReads, reads);
	assert.equal(reconnected.length, 1, "A settled session must bootstrap without waiting for another event");
	assert.deepEqual(reconnected[0], {
		type: "execution.baseline",
		instanceId: completed.instanceId,
		sessions: [
			{
				sessionId: host.session.id,
				revision: completed.revision,
				turn: completed.turn,
				execution: completed.execution,
			},
		],
	});
	assert.equal(JSON.stringify(reconnected).includes('"messages"'), false);
	close();
	await assert.rejects(
		host.runtime.subscribeExecutions([], () => {}),
		{ status: 400 },
	);
	await assert.rejects(
		host.runtime.subscribeExecutions(["missing"], () => {}),
		{ status: 404 },
	);
});

test("reactivating an evicted session cannot reuse an execution revision after global storage failure", async (context) => {
	const host = await start(context, false, "release-after-turn");
	host.finishModel();
	await host.runtime.waitForTurn(host.session.id);
	const idle = await host.runtime.createSession({ assistantId: "assistant" });
	const baseline = await host.runtime.getSession(idle.id, { limit: 1 });
	host.store.saveSession = async () => {
		throw new Error("disk failed");
	};
	await assert.rejects(host.runtime.submitTurn(host.session.id, { text: "fail" }), /disk failed/);
	const reloaded = await host.runtime.getSession(idle.id, { limit: 1 });
	assert(reloaded.revision > baseline.revision);
	assert.equal(reloaded.execution.actions.submit.reason, "storage_unavailable");
});

test("execution baseline covers concurrent settlement during a cold metadata read and filters other sessions", async (context) => {
	const host = await start(context);
	const cold = await host.runtime.createSession({ assistantId: "assistant" });
	const saved = await host.store.readSession(cold.id);
	assert(saved);
	await host.store.saveSession({ ...saved, id: "cold", messages: [], tree: { leafId: null, nodes: [] } });
	const read = host.store.readSession;
	let entered = false;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	host.store.readSession = async (id) => {
		if (id === "cold") {
			entered = true;
			await blocked;
		}
		return read(id);
	};
	const frames: ExecutionStreamEvent[] = [];
	const subscription = host.runtime.subscribeExecutions(["cold", host.session.id], (packet) => frames.push(packet));
	try {
		await until(() => entered);
		host.finishModel();
		await until(() => host.events.some((packet) => packet.type === "turn.settled"));
	} finally {
		release();
	}
	const unsubscribe = await subscription;
	assert.equal(frames.length, 1, "Buffered events covered by the baseline must be discarded");
	const baseline = frames[0];
	assert.equal(baseline.type, "execution.baseline");
	if (baseline.type !== "execution.baseline") return;
	assert.equal(baseline.sessions.find((session) => session.sessionId === host.session.id)?.turn?.status, "completed");
	await host.runtime.submitTurn(cold.id, { text: "unwatched" });
	await host.runtime.waitForTurn(cold.id);
	assert.equal(frames.length, 1);
	await host.runtime.submitTurn(host.session.id, { text: "watched" });
	await host.runtime.waitForTurn(host.session.id);
	assert(frames.slice(1).some((packet) => packet.type === "turn.settled"));
	unsubscribe();
});
