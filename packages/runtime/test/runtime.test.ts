import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

function agents(directory: string, onCall: (value: string) => void = () => {}) {
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
						onCall(args.text);
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

const definition: HostRuntimeDefinition = {
	assistantId: "host-assistant",
	assistantRevision: "1",
	runtime: { systemPrompt: "Use the SDK tool.", toolIds: ["sdk_echo"], skills: [], subagents: [] },
};

test("embedded runtime uses injected async storage and tools without creating a local database or HTTP server", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-embedded-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const dataDirectory = join(directory, "must-not-be-created");
	const memory = memoryStore();
	const calls: string[] = [];
	let runtime = await createRuntime({
		store: memory.store,
		agents: agents(dataDirectory, (value) => calls.push(value)),
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
	const runtime = await createRuntime({ store: memory.store, agents: agents("unused", (value) => calls.push(value)) });
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
		createRuntime({ store: memory.store, agents: agents("unused", (value) => calls.push(value)) }),
		/启动恢复/,
	);
	assert.deepEqual(calls, []);
	assert.equal(memory.closes, 2);
});
