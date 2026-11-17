import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { isCapabilityCatalog } from "@pie/runtime/capability-catalog";
import type { WorkerEnqueueResult } from "@pie/runtime/coordination";
import type { SessionSnapshot } from "@pie/runtime/protocol";
import { WorkerScheduler } from "@pie/runtime/worker-scheduler";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-unified-sessions-"));
	const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	let store = openStore(env);
	const selections = new Map<string, { provider: string; id: string } | undefined>();
	const start = () => {
		const factory = createAgentFactory(env);
		const create = factory.create.bind(factory);
		factory.create = (...args) => {
			selections.set(args[1], args[3]);
			const agent = create(...args);
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			agent.streamFunction = (_model, context, options) => {
				const last = [...context.messages].reverse().find((message) => !isCapabilityCatalog(message));
				const text =
					last?.role === "user"
						? typeof last.content === "string"
							? last.content
							: (last.content.filter((part) => part.type === "text").at(-1)?.text ?? "")
						: "";
				const command = /^调用工具\s+(\S+)\s+([\s\S]+)$/.exec(text);
				faux.setResponses([
					command
						? fauxAssistantMessage([fauxToolCall(command[1], JSON.parse(command[2]))], { stopReason: "toolUse" })
						: fauxAssistantMessage("done"),
				]);
				return models.streamSimple(faux.getModel(), context, options);
			};
			return agent;
		};
		return createLocalRuntime({ store, agents: factory, plugins: createPlugins(env), traceToolStream: false });
	};
	let runtime = await start();
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await runtime.registerHostRuntimes(
		["a", "b"].map((assistantId) => ({
			assistantId,
			assistantRevision: "1",
			runtime: {
				systemPrompt: "Coordinate through communicate",
				toolIds: [],
				skills: [],
				subagents: [],
				workerTargets: [{ assistantId: assistantId === "a" ? "b" : "a", name: "Peer", description: "Peer" }],
			},
		})),
	);
	return {
		selections,
		get runtime() {
			return runtime;
		},
		get store() {
			return store;
		},
		async restart(removeWorkerIds: string[] = []) {
			await runtime.close();
			store = openStore(env);
			for (const id of removeWorkerIds) {
				const session = store.readSession(id)!;
				store.saveSession({ ...session, workerId: undefined, messages: [], tree: store.readTree(id) });
			}
			runtime = await start();
		},
	};
}

function result(snapshot: SessionSnapshot) {
	const message = [...snapshot.messages]
		.reverse()
		.find((entry) => entry.role === "toolResult" && entry.toolName === "communicate");
	assert(message?.role === "toolResult");
	return message;
}

async function send(
	f: Awaited<ReturnType<typeof fixture>>,
	sessionId: string,
	input: { to: string; session_id: string; content?: string; reply_to?: string; kind?: "result" },
) {
	await f.runtime.submitTurn(sessionId, {
		text: `调用工具 communicate ${JSON.stringify({ content: "review", wait: false, ...input })}`,
	});
	return result(await f.runtime.waitForTurn(sessionId));
}

test("Root Sessions lazily communicate with existing targets, including old metadata and SQLite restart", async (t) => {
	const f = await fixture(t);
	const source = await f.runtime.createSession({ assistantId: "a", astronSessionId: "product-a" });
	const target = await f.runtime.createSession({ assistantId: "b" });
	assert.equal(source.workerId, "a");
	assert.equal(target.workerId, "b");
	assert.equal(await f.store.findAssignmentBySession(source.id), undefined);
	assert.equal(await f.store.findAssignmentBySession(target.id), undefined);
	await f.restart([source.id, target.id]);
	assert.equal((await f.runtime.getSession(source.id)).workerId, "a");
	assert.equal((await f.runtime.listSessions()).sessions.find((session) => session.id === target.id)?.workerId, "b");
	const sent = await send(f, source.id, { to: "b", session_id: target.id });
	assert.equal(sent.isError, false, JSON.stringify(sent));
	const request = (sent.details as { sent: WorkerEnqueueResult }).sent;
	assert.equal((await f.runtime.waitWorkerDelivery(request.delivery.deliveryId)).status, "consumed");
	assert.equal(f.store.readSession(source.id)?.workerId, "a");
	assert.equal(f.store.readSession(target.id)?.workerId, "b");
	const assignment = await f.store.findAssignmentBySession(source.id);
	assert.deepEqual(assignment?.productBinding, { assistantId: "a", astronSessionId: "product-a" });
	const reply = await send(f, target.id, {
		to: "a",
		session_id: source.id,
		reply_to: request.message.messageId,
		kind: "result",
		content: "review complete",
	});
	assert.equal(reply.isError, false, JSON.stringify(reply));
	await f.runtime.waitWorkerDelivery((reply.details as { sent: WorkerEnqueueResult }).sent.delivery.deliveryId);
	await f.restart();
	assert.deepEqual(await f.store.findAssignmentBySession(source.id), assignment);
	const repeated = await send(f, source.id, { to: "b", session_id: target.id });
	assert.equal(repeated.isError, false, JSON.stringify(repeated));
	await f.runtime.waitWorkerDelivery((repeated.details as { sent: WorkerEnqueueResult }).sent.delivery.deliveryId);
});

test("Imported and forked Sessions communicate without a mode flag and reject another assistant's target", async (t) => {
	const f = await fixture(t);
	const imported = await f.runtime.createSession({ assistantId: "a" });
	await f.runtime.importSession(imported.id, {
		schemaVersion: 1,
		source: { coreId: "other", sessionId: "external", astronSessionId: "imported-product" },
		transcript: [{ role: "user", content: [{ type: "text", text: "previous question" }] }],
	});
	const { session: fork } = await f.runtime.forkSession(imported.id, { beforeMessageId: null });
	const target = await f.runtime.createSession({ assistantId: "b" });
	assert.equal(fork.workerId, "a");
	assert.equal(await f.store.findAssignmentBySession(imported.id), undefined);
	assert.equal(await f.store.findAssignmentBySession(fork.id), undefined);
	for (const session of [imported, fork]) {
		const sent = await send(f, session.id, { to: "b", session_id: target.id });
		assert.equal(sent.isError, false, JSON.stringify(sent));
		await f.runtime.waitWorkerDelivery((sent.details as { sent: WorkerEnqueueResult }).sent.delivery.deliveryId);
	}
	assert.notEqual(
		(await f.store.findAssignmentBySession(imported.id))?.workId,
		(await f.store.findAssignmentBySession(fork.id))?.workId,
	);
	const denied = await send(f, fork.id, { to: "b", session_id: imported.id });
	assert.equal(denied.isError, true);
	assert.match(JSON.stringify(denied.content), /Session 不属于指定助手/);
	f.store.saveSession({
		...f.store.readSession(target.id)!,
		id: "legacy-child",
		kind: "subagent",
		parentSessionId: imported.id,
		workerId: undefined,
		turn: undefined,
		messages: [],
		tree: { nodes: [], leafId: null },
	});
	assert.equal((await send(f, fork.id, { to: "b", session_id: "legacy-child" })).isError, true);
	assert.equal(await f.store.findAssignmentBySession("legacy-child"), undefined);
	await assert.rejects(f.runtime.createSession({ assistantId: "a", workerId: "b" }), /workerId/);
});

test("Lazy communication follows model overrides changed after the first delivery", async (t) => {
	const f = await fixture(t);
	const source = await f.runtime.createSession({ assistantId: "a" });
	const target = await f.runtime.createSession({ assistantId: "b" });
	for (const model of ["first-model", "second-model"]) {
		await f.runtime.setModelOverride(target.id, { modelOverride: { providerId: "test", model } });
		const sent = await send(f, source.id, { to: "b", session_id: target.id });
		assert.equal(sent.isError, false, JSON.stringify(sent));
		const delivery = (sent.details as { sent: WorkerEnqueueResult }).sent.delivery;
		assert.equal((await f.runtime.waitWorkerDelivery(delivery.deliveryId)).status, "consumed");
		assert.deepEqual(f.selections.get(target.id), { provider: "test", id: model });
	}
});

test("Lazy association rechecks deletion and ownership immediately before storing an Assignment", async (t) => {
	const f = await fixture(t);
	const source = await f.runtime.createSession({ assistantId: "a" });
	const createAssignment = f.store.createAssignment.bind(f.store);
	for (const change of ["delete", "kind", "assistantId", "workerId"] as const) {
		const target = await f.runtime.createSession({ assistantId: "b" });
		f.store.createAssignment = async (assignment, options) => {
			if (assignment.sessionId === target.id) {
				if (change === "delete") await f.runtime.deleteSession(target.id);
				else {
					const saved = f.store.readSession(target.id)!;
					f.store.saveSession({
						...saved,
						...(change === "kind" ? { kind: "subagent" as const } : { [change]: "a" }),
						messages: [],
						tree: f.store.readTree(target.id),
					});
				}
			}
			return createAssignment(assignment, options);
		};
		const denied = await send(f, source.id, { to: "b", session_id: target.id });
		assert.equal(denied.isError, true, change);
		assert.match(JSON.stringify(denied.content), change === "delete" ? /会话不存在/ : /Session 不属于指定助手/);
		assert.equal(await f.store.findAssignmentBySession(target.id), undefined);
		if (change === "delete") {
			assert.equal(f.store.readSession(target.id), undefined);
			await assert.rejects(f.runtime.getSession(target.id), { status: 404 });
		}
	}
});

test("A coordination-only store reports unsupported lazy association", async (t) => {
	const f = await fixture(t);
	const source = await f.runtime.createSession({ assistantId: "a" });
	const { readSession: _readSession, ...store } = createSqliteRuntimeStore(f.store);
	const scheduler = new WorkerScheduler({ runtime: f.runtime, store });
	await assert.rejects(
		scheduler.send(
			{ workerId: "a", sessionId: source.id, turnId: "turn", toolCallId: "tool", targets: [], mode: "faux" },
			{ to: "b", content: "review" },
		),
		{ status: 405 },
	);
});
