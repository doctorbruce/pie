import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Static, Type } from "@earendil-works/pi-ai";
import {
	createAgentFactory,
	createRuntime,
	type HostRuntimeDefinition,
	type RuntimeStore,
	type SavedSession,
	type SessionEvent,
	type SessionMetadata,
} from "@pie/runtime";
import { type MessageTree, treePath } from "@pie/runtime/session-tree";
import type { ExternalTool } from "@pie/runtime/tools";

function memoryStore() {
	const sessions = new Map<string, SessionMetadata>();
	const trees = new Map<string, MessageTree>();
	let failWrites = false;
	let closes = 0;
	const workingReads: string[] = [];
	let onSave: (session: SavedSession) => void = () => {};
	const path = (id: string, leafId = trees.get(id)?.leafId) => {
		const tree = trees.get(id);
		assert(tree);
		return structuredClone({ leafId: leafId ?? null, nodes: treePath(tree, leafId ?? null) });
	};
	const store: RuntimeStore = {
		persistence: "test-memory",
		async loadSessions() {
			await delay(2);
			return structuredClone([...sessions.values()]);
		},
		async saveSession(session: SavedSession, replaceHistory = false) {
			onSave(session);
			await delay(5);
			if (failWrites) throw new Error("storage write rejected");
			const { messages: _messages, tree, transferBase: _transferBase, ...fields } = session;
			assert(tree);
			const previous = replaceHistory ? [] : (trees.get(session.id)?.nodes ?? []);
			const nodes = structuredClone([...previous, ...tree.nodes]);
			for (const [index, node] of nodes.entries()) node.seq = index + 1;
			const metadata = structuredClone({ ...fields, leafId: tree.leafId });
			trees.set(session.id, { nodes, leafId: tree.leafId });
			sessions.set(session.id, metadata);
			return metadata;
		},
		async readPath(id, leafId) {
			await delay(2);
			return path(id, leafId);
		},
		async readPathIds(id, leafId) {
			await delay(2);
			return path(id, leafId).nodes.map((node) => node.id);
		},
		async readWorkingPath(id) {
			workingReads.push(id);
			await delay(2);
			return path(id);
		},
		async readTree(id) {
			await delay(2);
			return structuredClone(trees.get(id)!);
		},
		async readHistory(id, options) {
			const nodes = path(id, options.leafId).nodes.filter((node) => node.seq! < (options.beforeSeq ?? Infinity));
			const entries = nodes.slice(-options.limit);
			return { entries, nextBeforeSeq: nodes.length > entries.length ? entries[0].seq! : null };
		},
		async deleteSession(id) {
			await delay(2);
			sessions.delete(id);
			trees.delete(id);
		},
		async close() {
			closes++;
		},
	};
	return {
		store,
		sessions,
		trees,
		workingReads,
		get closes() {
			return closes;
		},
		beforeSave(callback: (session: SavedSession) => void) {
			onSave = callback;
		},
		failWrites: () => {
			failWrites = true;
		},
	};
}

function agents(directory: string, onCall: (value: string) => void | Promise<void> = () => {}) {
	const parameters = Type.Object({
		text: Type.String(),
		confirm: Type.Optional(Type.Boolean()),
		wait: Type.Optional(Type.Boolean()),
	});
	return createAgentFactory({
		env: { PI_DATA_DIR: directory, PI_TOOLS_DIR: join(directory, "missing-tools") },
		models: { current: { selected: undefined, models: createModels() } },
		skills(runtime) {
			assert.equal(runtime.skills.length, 0);
			return { tools: [], afterToolCall: async () => undefined };
		},
		mcp: {
			configure(configs) {
				assert(configs.every((config) => Object.keys(config).length === 0));
			},
			status: () => ({ servers: {} }),
			async acquire(config) {
				assert.equal(Object.keys(config).length, 0);
				return { tools: [], instructions: [], release() {} };
			},
			async close() {},
		},
		recordModelRequest: () => async () => undefined,
		tools: {
			catalog: [{ id: "sdk_echo", label: "SDK echo" }],
			create: (context) => {
				const tool: ExternalTool = {
					name: "sdk_echo",
					label: "SDK echo",
					description: "Echo through a host-provided executor",
					parameters,
					async execute(_toolCallId, input, signal, onUpdate) {
						const args = input as Static<typeof parameters>;
						if (args.confirm)
							await context.ask({ type: "confirmation", title: "执行 SDK 工具", message: args.text }, signal);
						await onCall(args.text);
						onUpdate?.({
							content: [{ type: "text", text: "SDK running" }],
							details: { sessionId: context.sessionId },
						});
						if (args.wait) await delay(60000, undefined, { signal });
						return { content: [{ type: "text", text: args.text }], details: { sessionId: context.sessionId } };
					},
				};
				return [tool];
			},
		},
	});
}

function trackedAgents(onCall: (value: string) => void | Promise<void> = () => {}) {
	const factory = agents("unused", onCall);
	const created: WeakRef<ReturnType<typeof factory.create>>[] = [];
	const current = new Map<string, WeakRef<ReturnType<typeof factory.create>>>();
	const messages: WeakRef<AgentMessage>[] = [];
	const native = new Map<string, NonNullable<Parameters<typeof factory.create>[9]>>();
	return {
		created,
		current,
		messages,
		native,
		factory: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				created.push(new WeakRef(agent));
				current.set(args[1], created[created.length - 1]);
				if (args[9]) native.set(args[1], args[9]);
				agent.subscribe((event) => {
					if (event.type === "message_end") messages.push(new WeakRef(event.message));
				});
				return agent;
			},
		},
	};
}

async function assertCollected(references: readonly WeakRef<object>[]) {
	assert(global.gc, "Run with --expose-gc to verify reference release");
	for (let attempt = 0; attempt < 20; attempt++) {
		await delay(0);
		global.gc();
		if (references.every((reference) => reference.deref() === undefined)) return;
	}
	assert.fail("Idle Agent or working messages are still strongly referenced");
}

const definition: HostRuntimeDefinition = {
	assistantId: "host-assistant",
	assistantRevision: "1",
	runtime: { systemPrompt: "Use the SDK tool.", toolIds: ["sdk_echo"], skills: [], subagents: [] },
};

const delegatingDefinitions: HostRuntimeDefinition[] = [
	{
		...definition,
		runtime: {
			...definition.runtime,
			permissions: { "*": "allow" },
			subagents: [{ id: "worker", name: "Worker", description: "SDK tasks", assistantId: "worker-assistant" }],
		},
	},
	{ ...definition, assistantId: "worker-assistant" },
];

test("embedded runtime uses injected async storage and tools without creating a local database or HTTP server", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-embedded-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const dataDirectory = join(directory, "must-not-be-created");
	const memory = memoryStore();
	const calls: string[] = [];
	let runtime = await createRuntime({
		store: memory.store,
		agents: agents(dataDirectory, (value) => {
			calls.push(value);
		}),
	});
	context.after(() => runtime.close());
	assert.equal("server" in runtime, false);
	assert.equal("saveAssistant" in runtime, false);
	assert.equal("importPlugin" in runtime, false);
	assert.equal(runtime.info.persistence, "test-memory");
	assert.deepEqual(
		runtime.tools.map((tool) => tool.id),
		["sdk_echo"],
	);
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const metadata = await runtime.listSessionMetadata();
	assert.equal(metadata[0].id, session.id);
	assert.equal("messages" in metadata[0], false);
	metadata[0].title = "detached metadata";
	assert.equal((await runtime.getSession(session.id)).title, session.title);
	let overridden: Promise<unknown> | undefined;
	memory.beforeSave((saved) => {
		if (!overridden && saved.messages.some((message) => message.role === "assistant"))
			overridden = runtime.setModelOverride(session.id, { modelOverride: null });
	});
	const packets: SessionEvent[] = [];
	const unsubscribe = runtime.subscribe(session.id, (packet) => packets.push(packet));
	runtime.subscribe(
		session.id,
		() => {
			throw new Error("host delivery failed");
		},
		() => {
			throw new Error("host cleanup failed");
		},
	);
	await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"ok"}', requestId: "request-1" });
	const settled = await runtime.waitForTurn(session.id);
	assert(overridden);
	await overridden;
	assert.equal(settled.turn?.status, "completed");
	assert.equal(settled.turn?.requestId, "request-1");
	assert.deepEqual(calls, ["ok"]);
	assert.equal(settled.messages.length, 4);
	assert.equal(memory.trees.get(session.id)?.nodes.length, 4);
	assert(packets.some((packet) => packet.event?.type === "tool_execution_update"));
	assert.equal(packets.at(-1)?.type, "turn.settled");
	const detached = await runtime.getSession(session.id);
	detached.turn!.status = "running";
	assert.equal((await runtime.getSession(session.id)).turn?.status, "completed");
	assert.equal((await runtime.readHistory(session.id, { limit: 1 })).entries.length, 1);
	unsubscribe();
	await Promise.all([runtime.close(), runtime.close()]);
	assert.equal(memory.closes, 1);
	runtime = await createRuntime({ store: memory.store, agents: agents(dataDirectory) });
	assert.deepEqual((await runtime.getSession(session.id)).messages, settled.messages);
	assert.equal(existsSync(dataDirectory), false);
});

test("async admission rejects simultaneous turns and storage failures never launch the model or tool", async (context) => {
	const memory = memoryStore();
	const calls: string[] = [];
	const runtime = await createRuntime({
		store: memory.store,
		agents: agents("unused", (value) => {
			calls.push(value);
		}),
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const submitted = await Promise.allSettled([
		runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"once"}' }),
		runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"twice"}' }),
	]);
	assert.equal(submitted[0].status, "fulfilled");
	assert.equal(submitted[1].status, "rejected");
	await runtime.waitForTurn(session.id);
	assert.deepEqual(calls, ["once"]);
	const before = await runtime.getSession(session.id);
	memory.failWrites();
	await assert.rejects(
		runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"must-not-run"}' }),
		/storage write rejected/,
	);
	assert.deepEqual((await runtime.getSession(session.id)).messages, before.messages);
	assert.equal(runtime.storageAvailable, false);
	await assert.rejects(runtime.submitTurn(session.id, { text: "retry" }), /存储不可用/);
	assert.deepEqual(calls, ["once"]);
});

test("host subscriptions can approve and cancel SDK tools without an HTTP transport", async (context) => {
	const memory = memoryStore();
	let started: () => void = () => {};
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const runtime = await createRuntime({ store: memory.store, agents: agents("unused", started) });
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	let approved: Promise<unknown> | undefined;
	const revisions: number[] = [];
	runtime.subscribe(session.id, (packet) => {
		revisions.push(packet.snapshot.revision);
		if (packet.type === "interaction.requested" && packet.interaction)
			approved = runtime.replyInteraction(session.id, packet.interaction.id, { approved: true });
	});
	const accepted = await runtime.submitTurn(session.id, {
		text: '调用工具 sdk_echo {"text":"wait","confirm":true,"wait":true}',
	});
	await running;
	await approved;
	await runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "cancelled");
	assert(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]));
	await assert.rejects(runtime.cancelTurn(session.id, { turnId: "stale" }), /turnId 不匹配/);
});

test("startup refuses unrecovered turns and releases injected resources without replaying tools", async () => {
	const memory = memoryStore();
	const runtime = await createRuntime({ store: memory.store, agents: agents("unused") });
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.close();
	memory.sessions.get(session.id)!.turn = { id: "interrupted", status: "running" };
	const calls: string[] = [];
	await assert.rejects(
		createRuntime({
			store: memory.store,
			agents: agents("unused", (value) => {
				calls.push(value);
			}),
		}),
		/启动恢复/,
	);
	assert.deepEqual(calls, []);
	assert.equal(memory.closes, 2);
});

for (const sessionRetention of [undefined, "retain", "release-after-turn"] as const) {
	test(`session retention ${sessionRetention ?? "default"} preserves history and selects Agent reuse`, async (context) => {
		const memory = memoryStore();
		const observed = trackedAgents();
		const runtime = await createRuntime({ store: memory.store, agents: observed.factory, sessionRetention });
		context.after(() => runtime.close());
		await runtime.registerHostRuntimes([definition]);
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		await runtime.submitTurn(session.id, {
			text: '调用工具 sdk_echo {"text":"first"}',
			images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
		});
		await runtime.waitForTurn(session.id);
		const firstIds = memory.trees.get(session.id)!.nodes.map((node) => node.id);
		await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"second"}' });
		const settled = await runtime.waitForTurn(session.id);
		assert.equal(settled.turn?.status, "completed");
		assert.equal(settled.messages.length, 8);
		assert(JSON.stringify(settled.messages).includes("aW1hZ2U="));
		const tree = memory.trees.get(session.id)!;
		assert.deepEqual(
			tree.nodes.slice(0, firstIds.length).map((node) => node.id),
			firstIds,
		);
		assert.equal(new Set(tree.nodes.map((node) => node.id)).size, 8);
		const releasing = sessionRetention === "release-after-turn";
		assert.equal(observed.created.length, releasing ? 3 : 1);
		assert.equal(memory.workingReads.length, releasing ? 2 : 0);
		if (global.gc && releasing) await assertCollected([...observed.created, ...observed.messages]);
		if (global.gc && !releasing) {
			await delay(0);
			global.gc();
			assert(observed.created[0].deref(), "The local default should keep its Agent");
		}
	});
}

test("release waits for confirmation and cancellation settlement, then the next turn rebuilds", async (context) => {
	const memory = memoryStore();
	const observed = trackedAgents();
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	let waiting = () => {};
	const confirmation = new Promise<void>((resolve) => {
		waiting = resolve;
	});
	runtime.subscribe(session.id, (packet) => {
		if (packet.type === "interaction.requested") waiting();
	});
	const accepted = await runtime.submitTurn(session.id, {
		text: '调用工具 sdk_echo {"text":"approval","confirm":true}',
	});
	await confirmation;
	await delay(0);
	global.gc?.();
	assert(observed.created.at(-1)?.deref(), "Waiting for approval must keep the active Agent");
	await runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "cancelled");
	if (global.gc) await assertCollected([...observed.created, ...observed.messages]);
	await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"after-cancel"}' });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(memory.workingReads.length, 2);
});

test("a failed final commit retains Agent and messages and blocks subsequent writes", async (context) => {
	const memory = memoryStore();
	const observed = trackedAgents();
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	memory.beforeSave((saved) => {
		if (saved.turn && saved.turn.status !== "running") memory.failWrites();
	});
	await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"not-committed"}' });
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(settled.turn?.status, "failed");
	assert.match(settled.turn.error ?? "", /写入失败/);
	assert.equal(runtime.storageAvailable, false);
	await delay(0);
	global.gc?.();
	assert(observed.created.at(-1)?.deref(), "Uncommitted state must stay available in memory");
	assert(observed.messages.every((message) => message.deref()));
	await assert.rejects(runtime.submitTurn(session.id, { text: "retry" }), /存储不可用/);
});

test("execution failure with a committed terminal state releases and can rebuild", async (context) => {
	const memory = memoryStore();
	const observed = trackedAgents();
	const acquire = observed.factory.mcp.acquire;
	let fail = true;
	observed.factory.mcp.acquire = async (...args) => {
		if (fail) throw new Error("MCP unavailable");
		return acquire(...args);
	};
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.submitTurn(session.id, { text: "first" });
	const failed = await runtime.waitForTurn(session.id);
	assert.equal(failed.turn?.status, "failed");
	assert.equal(failed.turn.error, "MCP unavailable");
	assert.equal(runtime.storageAvailable, true);
	if (global.gc) await assertCollected(observed.created);
	fail = false;
	await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"recovered"}' });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(observed.created.length, 3);
});

test("settled-event submissions and concurrent background notifications cannot race teardown", async (context) => {
	const memory = memoryStore();
	const observed = trackedAgents();
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	let nextTurn: Promise<unknown> | undefined;
	runtime.subscribeAll((packet) => {
		if (packet.type === "turn.settled" && !nextTurn)
			nextTurn = runtime.submitTurn(session.id, { text: "submitted from settlement" });
	});
	await runtime.submitTurn(session.id, { text: "first" });
	await runtime.waitForTurn(session.id);
	assert(nextTurn);
	await nextTurn;
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	const notify = observed.native.get(session.id)?.notifyBackground;
	assert(notify);
	await Promise.all([notify("background-one"), notify("background-two")]);
	const users = memory.trees.get(session.id)!.nodes.filter((node) => node.message.role === "user");
	assert.equal(users.length, 4);
	assert.equal(users.filter((node) => JSON.stringify(node.message).includes("background-one")).length, 1);
	assert.equal(users.filter((node) => JSON.stringify(node.message).includes("background-two")).length, 1);
	if (global.gc) await assertCollected([...observed.created, ...observed.messages]);
});

test("foreground Subagents return their output before release and continue from durable history", async (context) => {
	const memory = memoryStore();
	const calls: string[] = [];
	const observed = trackedAgents((value) => {
		calls.push(value);
	});
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes(delegatingDefinitions);
	const parent = await runtime.createSession({ assistantId: definition.assistantId });
	let childId: string | undefined;
	for (let index = 0; index < 2; index++) {
		await runtime.submitTurn(parent.id, {
			text: `调用工具 task ${JSON.stringify({
				description: "SDK task",
				prompt: `调用工具 sdk_echo {"text":"part-${index}"}`,
				subagent_type: "worker",
				task_id: childId,
			})}`,
		});
		const settled = await runtime.waitForTurn(parent.id);
		assert.equal(settled.turn?.status, "completed");
		const children = (await runtime.listSessions({ includeSubagents: true })).sessions.filter(
			(session) => session.kind === "subagent",
		);
		assert.equal(children.length, 1);
		childId = children[0].id;
		const results = settled.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		);
		assert(JSON.stringify(results.at(-1)).includes(`part-${index}`));
		assert.equal(memory.trees.get(childId)!.nodes.length, (index + 1) * 4);
		if (global.gc) await assertCollected([...observed.created, ...observed.messages]);
	}
	assert.deepEqual(calls, ["part-0", "part-1"]);
});

test("background Subagents pin active work and deliver completion before their parent releases", async (context) => {
	const memory = memoryStore();
	let resume = () => {};
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const calls: string[] = [];
	const observed = trackedAgents(async (value) => {
		calls.push(value);
		await gate;
	});
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => {
		resume();
		return runtime.close();
	});
	await runtime.registerHostRuntimes(delegatingDefinitions);
	const parent = await runtime.createSession({ assistantId: definition.assistantId });
	let settledCount = 0;
	let notified = () => {};
	const notification = new Promise<void>((resolve) => {
		notified = resolve;
	});
	runtime.subscribeAll((packet) => {
		if (packet.sessionId === parent.id && packet.type === "turn.settled" && ++settledCount === 2) notified();
	});
	await runtime.submitTurn(parent.id, {
		text: `调用工具 task ${JSON.stringify({
			description: "Background SDK task",
			prompt: '调用工具 sdk_echo {"text":"child-output"}',
			subagent_type: "worker",
			background: true,
		})}`,
	});
	assert.equal((await runtime.waitForTurn(parent.id)).turn?.status, "completed");
	const child = (await runtime.listSessions({ includeSubagents: true })).sessions.find(
		(session) => session.kind === "subagent",
	);
	assert(child);
	assert.equal(child.turn?.status, "running");
	await delay(0);
	global.gc?.();
	assert(observed.current.get(parent.id)?.deref(), "Active background work must pin its parent");
	assert(observed.current.get(child.id)?.deref(), "The running child must not unload");
	resume();
	await notification;
	await runtime.waitForTurn(parent.id);
	const notifications = memory.trees
		.get(parent.id)!
		.nodes.filter((node) => node.message.role === "user" && JSON.stringify(node.message).includes("<task_result>"));
	assert.equal(notifications.length, 1);
	assert(JSON.stringify(notifications[0].message).includes("child-output"));
	assert.deepEqual(calls, ["child-output"]);
	if (global.gc) await assertCollected([...observed.created, ...observed.messages]);
});

test("cold turns restore the checkpoint window without replacing complete durable history", async (context) => {
	const memory = memoryStore();
	const seed = await createRuntime({ store: memory.store, agents: agents("unused") });
	await seed.registerHostRuntimes([definition]);
	const session = await seed.createSession({ assistantId: definition.assistantId });
	for (const text of ["cold-prefix", "kept-window"]) {
		await seed.submitTurn(session.id, { text });
		await seed.waitForTurn(session.id);
	}
	await seed.close();
	const boundary = memory.trees.get(session.id)!.nodes[2].id;
	memory.sessions.get(session.id)!.compaction = {
		summary: "Earlier conversation summary",
		firstKeptMessage: 2,
		firstKeptEntryId: boundary,
		workingMessageCount: 3,
		messageCount: 4,
		tokensBefore: 1000,
		estimatedTokensAfter: 100,
		compactedAt: Date.now(),
		generation: 1,
	};
	const readWorkingPath = memory.store.readWorkingPath;
	memory.store.readWorkingPath = async (id, compaction) => {
		assert.equal(compaction?.firstKeptEntryId, boundary);
		const tree = await readWorkingPath(id, compaction);
		return { ...tree, nodes: tree.nodes.slice(tree.nodes.findIndex((node) => node.id === boundary)) };
	};
	const observed = trackedAgents();
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	for (const text of ["third", "fourth"]) {
		await runtime.submitTurn(session.id, { text });
		const working = observed.current.get(session.id)!.deref()!.state.messages;
		assert(JSON.stringify(working[0]).includes("Earlier conversation summary"));
		assert(!JSON.stringify(working).includes("cold-prefix"));
		await runtime.waitForTurn(session.id);
	}
	assert.equal(memory.workingReads.length, 2);
	assert.equal(memory.trees.get(session.id)!.nodes.length, 8);
	const full = await runtime.getSession(session.id);
	assert.equal(full.messages.length, 8);
	assert(JSON.stringify(full.messages).includes("cold-prefix"));
	assert.equal(full.compaction?.firstKeptEntryId, boundary);
});

test("cold import, fork and branch selection preserve history without retaining body references", async (context) => {
	const memory = memoryStore();
	const observed = trackedAgents();
	const savedMessages: WeakRef<AgentMessage>[] = [];
	memory.beforeSave((saved) => {
		for (const message of saved.messages) savedMessages.push(new WeakRef(message));
	});
	const runtime = await createRuntime({
		store: memory.store,
		agents: observed.factory,
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	for (const text of ["first", "second"]) {
		await runtime.submitTurn(session.id, { text });
		await runtime.waitForTurn(session.id);
	}
	const transfer = await runtime.exportSession(session.id);
	const target = await runtime.createSession({ assistantId: definition.assistantId });
	assert.equal((await runtime.importSession(target.id, { ...transfer })).session.messages.length, 4);
	const forked = await runtime.forkSession(session.id, { messageIndex: 2 });
	assert.equal(forked.session.messages.length, 2);
	const firstReply = memory.trees.get(session.id)!.nodes[1].id;
	assert.equal((await runtime.selectTree(session.id, { entryId: firstReply })).session.messages.length, 2);
	await runtime.renameSession(target.id, { title: "renamed cold session" });
	await runtime.setModelOverride(target.id, { modelOverride: null });
	if (global.gc) await assertCollected([...observed.created, ...observed.messages, ...savedMessages]);
	await runtime.submitTurn(target.id, { text: "after import" });
	assert.equal((await runtime.waitForTurn(target.id)).messages.length, 6);
	await runtime.submitTurn(session.id, { text: "new branch" });
	assert.equal((await runtime.waitForTurn(session.id)).messages.length, 4);
	assert.equal(memory.trees.get(session.id)!.nodes.length, 6);
});
