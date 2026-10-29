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
	type ToolExecutionRecord,
} from "@pie/runtime";
import { applySessionEvent } from "@pie/runtime/session-events";
import { type MessageTree, treePath } from "@pie/runtime/session-tree";
import type { ExternalTool } from "@pie/runtime/tools";

function memoryStore() {
	const sessions = new Map<string, SessionMetadata>();
	const trees = new Map<string, MessageTree>();
	const journal = new Map<string, (ToolExecutionRecord & { seq: number })[]>();
	let failWrites = false;
	let closes = 0;
	const workingReads: string[] = [];
	const metadataReads: string[] = [];
	let listReads = 0;
	let onSave: (session: SavedSession) => void = () => {};
	const path = (id: string, leafId = trees.get(id)?.leafId) => {
		const tree = trees.get(id);
		assert(tree);
		return structuredClone({ leafId: leafId ?? null, nodes: treePath(tree, leafId ?? null) });
	};
	const store: RuntimeStore = {
		persistence: "test-memory",
		async readSession(id) {
			metadataReads.push(id);
			await delay(2);
			return structuredClone(sessions.get(id));
		},
		async listSessions({ limit, cursor, assistantId, kind, parentSessionId }) {
			listReads++;
			await delay(2);
			const matches = [...sessions.values()]
				.filter(
					(session) =>
						(assistantId === undefined || session.assistantId === assistantId) &&
						(kind === undefined || session.kind === kind) &&
						(parentSessionId === undefined || session.parentSessionId === parentSessionId) &&
						(!cursor ||
							session.updatedAt < cursor.updatedAt ||
							(session.updatedAt === cursor.updatedAt && session.id < cursor.id)),
				)
				.sort(
					(left, right) =>
						right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
				);
			const page = matches.slice(0, limit);
			const last = page.at(-1);
			return structuredClone({
				sessions: page,
				nextCursor: matches.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
			});
		},
		async saveSession(session: SavedSession, replaceHistory = false, records: readonly ToolExecutionRecord[] = []) {
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
			const entries = journal.get(session.id) ?? [];
			for (const record of records)
				if (!entries.some((entry) => entry.id === record.id))
					entries.push(structuredClone({ ...record, seq: entries.length + 1 }));
			journal.set(session.id, entries);
			return metadata;
		},
		async readToolExecutions(id, { turnId, limit, afterSeq = 0 }) {
			const rows = (journal.get(id) ?? []).filter((entry) => entry.turnId === turnId && entry.seq > afterSeq);
			const entries = structuredClone(rows.slice(0, limit));
			return { entries, nextAfterSeq: rows.length > limit ? entries.at(-1)!.seq : null };
		},
		async readPath(id, leafId) {
			await delay(2);
			return path(id, leafId);
		},
		async readTurnPath(id, inputEntryId, leafId) {
			await delay(2);
			const tree = path(id, leafId);
			const start = tree.nodes.findIndex((node) => node.id === inputEntryId);
			const nodes = start < 0 ? [] : tree.nodes.slice(start);
			if (nodes.length > 0) nodes[0] = { ...nodes[0], parentId: null };
			return { leafId: tree.leafId, nodes };
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
			journal.delete(id);
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
		metadataReads,
		get listReads() {
			return listReads;
		},
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

function agents(directory: string, onCall: (value: string, signal?: AbortSignal) => void | Promise<void> = () => {}) {
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
						await onCall(args.text, signal);
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
	const configurations: WeakRef<Parameters<typeof factory.create>[2]>[] = [];
	const native = new Map<string, NonNullable<Parameters<typeof factory.create>[9]>>();
	return {
		created,
		current,
		messages,
		configurations,
		native,
		factory: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				configurations.push(new WeakRef(args[2]));
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

function seedSession(memory: ReturnType<typeof memoryStore>, id: string, overrides: Partial<SessionMetadata> = {}) {
	const metadata: SessionMetadata = {
		id,
		kind: "root",
		assistantId: definition.assistantId,
		assistantRevision: "1",
		runtimeSource: "host",
		title: id,
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 0,
		leafId: null,
		runtime: { ...structuredClone(definition.runtime), subagents: [] },
		...overrides,
	};
	memory.sessions.set(id, metadata);
	memory.trees.set(id, { leafId: null, nodes: [] });
	return metadata;
}

test("startup reads no session metadata and concurrent access activates only its target", async (context) => {
	const memory = memoryStore();
	for (let index = 0; index < 600; index++) seedSession(memory, `cold-${index.toString().padStart(4, "0")}`);
	const observed = trackedAgents();
	const runtime = await createRuntime({ store: memory.store, agents: observed.factory });
	context.after(() => runtime.close());
	assert.equal(memory.listReads, 0);
	assert.deepEqual(memory.metadataReads, []);
	assert.equal(observed.created.length, 0);
	await Promise.all(Array.from({ length: 8 }, () => runtime.getSession("cold-0300", { limit: 1 })));
	assert.deepEqual(memory.metadataReads, ["cold-0300"]);
	assert.deepEqual(memory.workingReads, []);
	assert.equal(observed.created.length, 0);
	await assert.rejects(runtime.getSession("absent"), { status: 404 });
	seedSession(memory, "absent");
	assert.equal((await runtime.getSession("absent")).id, "absent");
	assert.equal(memory.metadataReads.filter((id) => id === "absent").length, 2);
});

test("session lists page durable metadata without activating sessions and break timestamp ties by ID", async (context) => {
	const memory = memoryStore();
	for (let index = 0; index < 260; index++)
		seedSession(memory, `page-${index.toString().padStart(4, "0")}`, {
			assistantId: index % 2 ? "other" : definition.assistantId,
			...(index % 3 ? {} : { kind: "subagent", parentSessionId: "parent" }),
		});
	const observed = trackedAgents();
	const runtime = await createRuntime({ store: memory.store, agents: observed.factory });
	context.after(() => runtime.close());
	const ids: string[] = [];
	let page = await runtime.listSessions({ includeSubagents: true });
	assert.equal(page.sessions.length, 50);
	while (true) {
		ids.push(...page.sessions.map((session) => session.id));
		if (!page.nextCursor) break;
		page = await runtime.listSessions({ includeSubagents: true, cursor: page.nextCursor });
	}
	assert.deepEqual(ids, [...memory.sessions.keys()].sort().reverse());
	const roots = await runtime.listSessions({ assistantId: definition.assistantId, limit: 200 });
	assert(roots.sessions.every((session) => session.kind === "root" && session.assistantId === definition.assistantId));
	assert.equal(roots.nextCursor, null);
	assert.equal((await runtime.listSessionMetadata()).length, 260);
	assert.deepEqual(memory.metadataReads, []);
	assert.equal(observed.created.length, 0);
	for (const limit of [0, 201, NaN, 1.5]) await assert.rejects(runtime.listSessions({ limit }), { status: 400 });
	await assert.rejects(runtime.listSessions({ cursor: { updatedAt: -1, id: "id" } }), { status: 400 });
	await runtime.getSession(ids[0]);
	assert.deepEqual(memory.metadataReads, [ids[0]]);
});

for (const sessionRetention of ["retain", "release-after-turn"] as const) {
	test(`metadata is retained only while needed with ${sessionRetention}`, async (context) => {
		const memory = memoryStore();
		seedSession(memory, "target");
		const runtime = await createRuntime({ store: memory.store, agents: agents("unused"), sessionRetention });
		context.after(() => runtime.close());
		await runtime.getSession("target", { limit: 1 });
		await runtime.getSession("target", { limit: 1 });
		const releasing = sessionRetention === "release-after-turn";
		assert.equal(memory.metadataReads.length, releasing ? 2 : 1);
		const beforeBurst = memory.metadataReads.length;
		await Promise.all(Array.from({ length: 8 }, () => runtime.getSession("target", { limit: 1 })));
		assert.equal(memory.metadataReads.length, beforeBurst + Number(releasing));
		const unsubscribe = await runtime.subscribe("target", () => {});
		const before = memory.metadataReads.length;
		await runtime.getSession("target", { limit: 1 });
		await runtime.getSession("target", { limit: 1 });
		assert.equal(memory.metadataReads.length, before);
		unsubscribe();
		await runtime.getSession("target", { limit: 1 });
		assert.equal(memory.metadataReads.length, before + Number(releasing));
	});
}

test("parent deletion discovers every unloaded child across pages and preserves independent forks", async (context) => {
	const memory = memoryStore();
	seedSession(memory, "parent");
	seedSession(memory, "fork", { forkedFromSessionId: "parent" });
	for (let index = 0; index < 240; index++)
		seedSession(memory, `child-${index}`, { kind: "subagent", parentSessionId: "parent" });
	const runtime = await createRuntime({
		store: memory.store,
		agents: agents("unused"),
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	assert.deepEqual(await runtime.deleteSession("parent"), { deleted: true });
	assert.deepEqual([...memory.sessions.keys()], ["fork"]);
	assert.deepEqual(memory.metadataReads, ["parent"]);
	assert.equal(memory.listReads, 2);
	await assert.rejects(runtime.getSession("child-0"), { status: 404 });
	assert.equal((await runtime.getSession("fork")).forkedFromSessionId, "parent");
});

test("close waits for a cold waitForTurn snapshot before closing storage", async (context) => {
	const memory = memoryStore();
	seedSession(memory, "cold");
	let entered = () => {};
	let resume = () => {};
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const readPath = memory.store.readPath;
	memory.store.readPath = async (...args) => {
		entered();
		await gate;
		assert.equal(memory.closes, 0);
		return readPath(...args);
	};
	const runtime = await createRuntime({
		store: memory.store,
		agents: agents("unused"),
		sessionRetention: "release-after-turn",
	});
	context.after(async () => {
		resume();
		await runtime.close();
	});
	const pending = runtime.waitForTurn("cold");
	await reading;
	const closing = runtime.close();
	await delay(10);
	assert.equal(memory.closes, 0);
	resume();
	assert.equal((await pending).id, "cold");
	await closing;
	assert.equal(memory.closes, 1);
});

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
	const unsubscribe = await runtime.subscribe(session.id, (packet) => packets.push(packet));
	await runtime.subscribe(
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
	const journal = await runtime.readToolExecutions(session.id, { turnId: settled.turn!.id, limit: 200 });
	assert.deepEqual(
		journal.entries.map((entry) => entry.phase),
		["started", "completed"],
	);
	assert(journal.entries.every((entry) => entry.mode === "inline"));
	assert.equal(new Set(journal.entries.map((entry) => entry.executionId)).size, 1);
	assert.equal("toolExecutions" in settled, false);
	const page = await runtime.readToolExecutions(session.id, { turnId: settled.turn!.id, limit: 1 });
	assert.equal(page.entries[0].phase, "started");
	assert.equal(
		(
			await runtime.readToolExecutions(session.id, {
				turnId: settled.turn!.id,
				limit: 1,
				afterSeq: page.nextAfterSeq!,
			})
		).entries[0].phase,
		"completed",
	);
	for (const limit of [0, 201, NaN])
		await assert.rejects(runtime.readToolExecutions(session.id, { turnId: settled.turn!.id, limit }), {
			status: 400,
		});
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

for (const phase of ["started", "completed"] as const) {
	test(`a rejected ${phase} journal boundary cannot execute early or leak a later result-only commit`, async (context) => {
		const memory = memoryStore();
		const calls: string[] = [];
		const save = memory.store.saveSession;
		memory.store.saveSession = async (...args) => {
			if (args[2]?.some((entry) => entry.phase === phase)) throw new Error("journal write rejected");
			return save(...args);
		};
		const runtime = await createRuntime({
			store: memory.store,
			agents: agents("unused", (value) => {
				calls.push(value);
			}),
			hostRuntimes: [definition],
		});
		context.after(() => runtime.close());
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		const accepted = await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"effect"}' });
		await runtime.waitForTurn(session.id);
		assert.equal(calls.length, phase === "started" ? 0 : 1);
		const journal = await runtime.readToolExecutions(session.id, { turnId: accepted.turnId, limit: 200 });
		assert.deepEqual(
			journal.entries.map((entry) => entry.phase),
			phase === "started" ? [] : ["started"],
		);
		assert.equal(memory.trees.get(session.id)?.nodes.filter((node) => node.message.role === "toolResult").length, 0);
		await assert.rejects(runtime.submitTurn(session.id, { text: "next" }), { status: 503 });
	});
}

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
	await runtime.subscribe(session.id, (packet) => {
		revisions.push(packet.revision);
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

test("turn receipts distinguish accepted, started, queued and settled, and retry the current requestId", async (context) => {
	const memory = memoryStore();
	let running = () => {};
	const entered = new Promise<void>((resolve) => {
		running = resolve;
	});
	const runtime = await createRuntime({
		store: memory.store,
		agents: agents("unused", () => running()),
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const accepted = await runtime.submitTurn(session.id, {
		text: '调用工具 sdk_echo {"text":"wait","wait":true}',
		requestId: "request-retry",
	});
	assert.deepEqual(accepted, {
		sessionId: session.id,
		turnId: accepted.turnId,
		requestId: "request-retry",
		accepted: true,
		started: true,
		settled: false,
	});
	await entered;
	const runningState = await runtime.getSession(session.id, { limit: 1 });
	assert.equal(runningState.execution.actions.submit.available, false);
	assert.equal(runningState.execution.actions.submit.reason, "turn_running");
	assert.equal(runningState.execution.actions.steer.available, true);
	assert.equal(runningState.execution.actions.cancel.available, true);
	assert.equal(runningState.execution.actions.resume.reason, "turn_running");
	const retry = await runtime.submitTurn(session.id, {
		text: '调用工具 sdk_echo {"text":"wait","wait":true}',
		requestId: "request-retry",
	});
	assert.deepEqual(retry, accepted);
	const steer = await runtime.steer(session.id, {
		turnId: accepted.turnId,
		text: "稍后继续",
		requestId: "steer-request",
	});
	assert.deepEqual(steer, {
		sessionId: session.id,
		turnId: accepted.turnId,
		requestId: "steer-request",
		accepted: true,
		started: true,
		settled: false,
		queued: true,
		durable: false,
	});
	const cancellation = await runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	assert.equal(cancellation.accepted, true);
	assert.equal(cancellation.cancellationRequested, true);
	assert.equal(cancellation.turnId, accepted.turnId);
	assert.equal(cancellation.settled, false);
	const settled = await runtime.waitForTurn(session.id);
	assert.equal(settled.turn?.status, "cancelled");
	assert.equal(settled.execution.actions.submit.available, true);
	assert.equal(settled.execution.actions.cancel.reason, "turn_terminal");
	assert.equal(settled.execution.actions.resume.reason, "turn_terminal");
	const settledRetry = await runtime.submitTurn(session.id, {
		text: '调用工具 sdk_echo {"text":"wait","wait":true}',
		requestId: "request-retry",
	});
	assert.equal(settledRetry.turnId, accepted.turnId);
	assert.equal(settledRetry.settled, true);
	assert.equal(settledRetry.started, false);
});

for (const cancelAt of ["before steer", "during steer persistence"]) {
	test(`steer admission matches cancellation availability ${cancelAt} and never leaks into the next Turn`, async (context) => {
		const memory = memoryStore();
		const factory = agents("unused");
		let releasePreparation = () => {};
		const preparation = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const acquire = factory.mcp.acquire;
		factory.mcp.acquire = async (...args) => {
			await preparation;
			return acquire(...args);
		};
		const runtime = await createRuntime({ store: memory.store, agents: factory, hostRuntimes: [definition] });
		let releaseWrite = () => {};
		context.after(async () => {
			releaseWrite();
			releasePreparation();
			await runtime.close();
		});
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		const accepted = await runtime.submitTurn(session.id, { text: "original", requestId: "original-request" });
		assert.equal((await runtime.getSession(session.id)).execution.actions.steer.available, true);
		assert.equal(
			(await runtime.steer(session.id, { turnId: accepted.turnId, text: "queued before cancel" })).queued,
			true,
		);
		let late: Promise<unknown>;
		let cancellation: Promise<unknown>;
		let rejectedWrites = 0;
		if (cancelAt === "during steer persistence") {
			let entered = () => {};
			const writing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const blocked = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			const save = memory.store.saveSession;
			let blockedOnce = false;
			memory.store.saveSession = async (...args) => {
				if (!blockedOnce) {
					blockedOnce = true;
					entered();
					await blocked;
				}
				return save(...args);
			};
			late = runtime.steer(session.id, { turnId: accepted.turnId, text: "late steer", requestId: "late-request" });
			await writing;
			cancellation = runtime.cancelTurn(session.id, { turnId: accepted.turnId });
			releaseWrite();
		} else {
			cancellation = runtime.cancelTurn(session.id, { turnId: accepted.turnId });
			await cancellation;
			const stopping = await runtime.getSession(session.id);
			assert.equal(stopping.turn?.status, "running");
			assert.deepEqual(stopping.execution.actions.steer, { available: false, reason: "cancellation_in_progress" });
			const save = memory.store.saveSession;
			memory.store.saveSession = async (...args) => {
				rejectedWrites++;
				return save(...args);
			};
			late = runtime.steer(session.id, { turnId: accepted.turnId, text: "late steer", requestId: "late-request" });
		}
		await assert.rejects(late, { status: 409 });
		assert.equal(rejectedWrites, 0, "Rejected steer must not write a queued-input checkpoint");
		await cancellation;
		releasePreparation();
		assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "cancelled");
		await runtime.submitTurn(session.id, { text: "next turn", requestId: "next-request" });
		const next = await runtime.waitForTurn(session.id);
		assert.equal(next.turn?.status, "completed");
		assert.deepEqual(
			next.messages.filter((message) => message.role === "user").map((message) => message.content),
			["original", "next turn"],
		);
	});
}

for (const historyTarget of ["same session", "another session"]) {
	test(`running cancellation bypasses blocked history from ${historyTarget}`, { timeout: 10000 }, async (context) => {
		const memory = memoryStore();
		let started = () => {};
		let aborted = () => {};
		let settled = () => {};
		let historyEntered = () => {};
		let releaseHistory = () => {};
		let abortedAt = 0;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const stopped = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const completed = new Promise<void>((resolve) => {
			settled = resolve;
		});
		const reading = new Promise<void>((resolve) => {
			historyEntered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseHistory = resolve;
		});
		const runtime = await createRuntime({
			store: memory.store,
			agents: agents("unused", (_value, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						abortedAt = performance.now();
						aborted();
					},
					{ once: true },
				);
				started();
			}),
		});
		context.after(async () => {
			releaseHistory();
			await runtime.close();
		});
		await runtime.registerHostRuntimes([definition]);
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		const historySession =
			historyTarget === "same session"
				? session
				: await runtime.createSession({ assistantId: definition.assistantId });
		runtime.subscribeAll((packet) => {
			if (
				packet.sessionId === session.id &&
				packet.type === "turn.settled" &&
				packet.snapshot?.turn?.status === "cancelled"
			)
				settled();
		});
		const accepted = await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"wait","wait":true}' });
		await running;
		const readHistory = memory.store.readHistory;
		memory.store.readHistory = async (...args) => {
			historyEntered();
			await blocked;
			return readHistory(...args);
		};
		const pendingRead = runtime.getSession(historySession.id, { limit: 1 });
		await reading;
		const startedAt = performance.now();
		const cancellation = runtime.cancelTurn(session.id, { turnId: accepted.turnId });
		const result = await Promise.race([
			Promise.all([cancellation, stopped, completed]).then(([receipt]) => receipt),
			delay(1000).then(() => "blocked" as const),
		]);
		if (result === "blocked")
			assert.fail("Cancellation delivery, acknowledgement and settlement must not wait for history I/O");
		assert.equal(result.sessionId, session.id);
		assert.equal(result.turnId, accepted.turnId);
		assert.equal(result.accepted, true);
		assert.equal(result.cancellationRequested, true);
		assert.equal(memory.sessions.get(session.id)?.turn?.status, "cancelled");
		context.diagnostic(
			`Cancellation reached the tool in ${(abortedAt - startedAt).toFixed(1)} ms while history was still blocked`,
		);
		releaseHistory();
		await pendingRead;
		await runtime.submitTurn(session.id, { text: "next" });
		assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	});
}

test(
	"running cancellation sends abort before blocked persistence and shutdown waits for cleanup",
	{ timeout: 10000 },
	async (context) => {
		const memory = memoryStore();
		let started = () => {};
		let aborted = () => {};
		let writeEntered = () => {};
		let releaseWrite = () => {};
		let wasAborted = false;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const stopped = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const writing = new Promise<void>((resolve) => {
			writeEntered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const runtime = await createRuntime({
			store: memory.store,
			agents: agents("unused", (_value, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						wasAborted = true;
						aborted();
					},
					{ once: true },
				);
				started();
			}),
		});
		context.after(async () => {
			releaseWrite();
			await runtime.close();
		});
		await runtime.registerHostRuntimes([definition]);
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		const accepted = await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"wait","wait":true}' });
		await running;
		const save = memory.store.saveSession;
		memory.store.saveSession = async (...args) => {
			if (args[0].turnCheckpoint?.cancelRequested) {
				writeEntered();
				await blocked;
			}
			return save(...args);
		};
		await assert.rejects(runtime.cancelTurn(session.id, { turnId: "stale" }), { status: 409 });
		assert.equal(wasAborted, false, "A stale turnId must not abort the current tool");
		const cancellation = runtime.cancelTurn(session.id, { turnId: accepted.turnId });
		const repeated = runtime.cancelTurn(session.id, { turnId: accepted.turnId });
		assert.equal(
			await Promise.race([stopped.then(() => true), delay(1000).then(() => false)]),
			true,
			"Abort must precede persistence",
		);
		await writing;
		let acknowledged = false;
		void cancellation.then(() => {
			acknowledged = true;
		});
		const closing = runtime.close();
		await delay(20);
		assert.equal(acknowledged, false, "An uncommitted cancellation must not be acknowledged");
		assert.equal(memory.closes, 0, "Shutdown must retain storage until cancellation cleanup finishes");
		releaseWrite();
		assert.equal((await cancellation).sessionId, session.id);
		assert.equal((await cancellation).turnId, accepted.turnId);
		assert.equal((await cancellation).accepted, true);
		assert.equal((await cancellation).cancellationRequested, true);
		assert.deepEqual(await repeated, await cancellation);
		await closing;
		assert.equal(memory.closes, 1);
	},
);

test("cancellation during MCP preparation cannot launch the model or tool after preparation finishes", async (context) => {
	const memory = memoryStore();
	const calls: string[] = [];
	const factory = agents("unused", (value) => {
		calls.push(value);
	});
	let entered = () => {};
	let release = () => {};
	const preparing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const acquire = factory.mcp.acquire;
	factory.mcp.acquire = async (...args) => {
		entered();
		await blocked;
		return acquire(...args);
	};
	const runtime = await createRuntime({ store: memory.store, agents: factory, hostRuntimes: [definition] });
	context.after(async () => {
		release();
		await runtime.close();
	});
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	const accepted = await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"must-not-run"}' });
	await preparing;
	await runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	release();
	const completed = await runtime.waitForTurn(session.id);
	assert.equal(completed.turn?.status, "cancelled");
	assert.deepEqual(calls, []);
	assert.equal(completed.messages.filter((message) => message.role === "assistant").length, 0);
});

test("activation refuses an unrecovered Turn without blocking other sessions or replaying tools", async () => {
	const memory = memoryStore();
	const runtime = await createRuntime({ store: memory.store, agents: agents("unused") });
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.close();
	memory.sessions.get(session.id)!.turn = { id: "interrupted", status: "running" };
	const calls: string[] = [];
	const restored = await createRuntime({
		store: memory.store,
		agents: agents("unused", (value) => {
			calls.push(value);
		}),
	});
	await assert.rejects(restored.getSession(session.id), /启动恢复/);
	await restored.registerHostRuntimes([definition]);
	assert((await restored.createSession({ assistantId: definition.assistantId })).id);
	await restored.close();
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
		if (global.gc && releasing) {
			observed.native.clear();
			await assertCollected([...observed.created, ...observed.messages, ...observed.configurations]);
		}
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
	await runtime.subscribe(session.id, (packet) => {
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
		const journal = await runtime.readToolExecutions(parent.id, { turnId: settled.turn!.id, limit: 200 });
		assert.deepEqual(
			journal.entries.map((entry) => [entry.mode, entry.phase]),
			[
				["delegated", "started"],
				["delegated", "completed"],
			],
		);
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

test("long-history session events never read full history and bounded views use cursor pages", async (context) => {
	const memory = memoryStore();
	const runtime = await createRuntime({
		store: memory.store,
		agents: agents("unused"),
		sessionRetention: "release-after-turn",
	});
	context.after(() => runtime.close());
	await runtime.registerHostRuntimes([definition]);
	const session = await runtime.createSession({ assistantId: definition.assistantId });
	await runtime.importSession(session.id, {
		schemaVersion: 1,
		source: { astronSessionId: "source", coreId: "test", sessionId: "source" },
		transcript: Array.from({ length: 60 }, (_, index) => ({
			role: "user",
			createdAt: index + 1,
			content: [{ type: "text", text: `cold-${index}-${"x".repeat(4096)}` }],
		})),
	});
	let fullReads = 0;
	const readPath = memory.store.readPath;
	memory.store.readPath = async (...args) => {
		fullReads++;
		return readPath(...args);
	};
	const view = await runtime.getSession(session.id, { limit: 2 });
	assert.equal(view.messages.length, 2);
	assert(view.history?.nextBeforeSeq);
	const older = await runtime.readHistory(session.id, {
		limit: 2,
		beforeSeq: view.history.nextBeforeSeq,
		leafId: view.history.leafId,
	});
	assert.equal(older.entries.length, 2);
	assert.equal(fullReads, 0);
	const packets: SessionEvent[] = [];
	const readsAtPublication: number[] = [];
	await runtime.subscribe(session.id, (packet) => {
		packets.push(packet);
		readsAtPublication.push(fullReads);
	});
	await runtime.submitTurn(session.id, { text: "continue" });
	await runtime.waitForTurn(session.id);
	assert.equal(fullReads, 1, "only explicit waitForTurn reads a complete snapshot");
	assert(readsAtPublication.every((count) => count === 0));
	assert(packets.some((packet) => packet.event?.type === "message_update"));
	assert(packets.some((packet) => packet.type === "turn.settled"));
	assert(packets.every((packet) => packet.snapshot === undefined));
	assert(!JSON.stringify(packets).includes("cold-"));
	assert(!JSON.stringify(packets).includes('"partial":'));
	for (const limit of [0, 201, NaN, 1.5]) await assert.rejects(runtime.getSession(session.id, { limit }), /历史分页/);
});

test(
	"a paged bootstrap pins its history leaf and revision while newer events are buffered",
	{ timeout: 10000 },
	async (context) => {
		const memory = memoryStore();
		let toolStarted: () => void = () => {};
		let releaseTool: () => void = () => {};
		let resume: () => void = () => {};
		const toolEntered = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const toolBlocked = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const runtime = await createRuntime({
			store: memory.store,
			agents: agents("unused", async () => {
				toolStarted();
				await toolBlocked;
			}),
		});
		context.after(async () => {
			resume();
			releaseTool();
			await runtime.close();
		});
		await runtime.registerHostRuntimes([definition]);
		const session = await runtime.createSession({ assistantId: definition.assistantId });
		await runtime.importSession(session.id, {
			schemaVersion: 1,
			source: { astronSessionId: "source", coreId: "test", sessionId: "source" },
			transcript: Array.from({ length: 4 }, (_, index) => ({
				role: "user",
				createdAt: index + 1,
				content: [{ type: "text", text: `older-${index}` }],
			})),
		});
		await runtime.submitTurn(session.id, { text: '调用工具 sdk_echo {"text":"race"}' });
		await toolEntered;
		const baseline = await runtime.getSession(session.id, { limit: 2 });
		let started: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const readHistory = memory.store.readHistory;
		memory.store.readHistory = async (...args) => {
			started();
			await blocked;
			return readHistory(...args);
		};
		const packets: SessionEvent[] = [];
		await runtime.subscribe(session.id, (packet) => packets.push(packet));
		const pending = runtime.getSession(session.id, { limit: 2 });
		await entered;
		releaseTool();
		const completed = await runtime.waitForTurn(session.id);
		resume();
		let current = await pending;
		assert.equal(current.messages.length, 2);
		assert.deepEqual(current.messages, baseline.messages);
		assert(current.revision < completed.revision);
		for (const packet of packets) {
			const next = applySessionEvent(current, packet);
			assert(next);
			current = next;
		}
		assert.equal(current.revision, completed.revision);
		const baselineStart = completed.messages.findIndex(
			(message) =>
				message.role === baseline.messages[0].role && message.timestamp === baseline.messages[0].timestamp,
		);
		assert(baselineStart >= 0);
		assert.deepEqual(current.messages, completed.messages.slice(baselineStart));
	},
);
