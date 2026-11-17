import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { isCapabilityCatalog } from "@pie/runtime/capability-catalog";
import type { WorkerEnqueueResult } from "@pie/runtime/coordination";
import type { HostRuntimeDefinition, SessionSnapshot, WorkerTarget } from "@pie/runtime/protocol";
import type { WorkerSessionCommunication } from "@pie/runtime/worker-communication";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";

const reviewer: WorkerTarget = { assistantId: "b", name: "Reviewer", description: "Worker review only" };
const legacy: WorkerTarget = { assistantId: "c", name: "Legacy", description: "Legacy task only" };

function definitions(workerTargets: WorkerTarget[] | undefined): HostRuntimeDefinition[] {
	return [
		{
			assistantId: "a",
			assistantRevision: "1",
			runtime: {
				systemPrompt: "Coordinate independently",
				toolIds: ["gate"],
				skills: [],
				subagents: [{ id: "legacy-task", ...legacy }],
				...(workerTargets !== undefined ? { workerTargets } : {}),
			},
		},
		...[reviewer, legacy].map((target) => ({
			assistantId: target.assistantId,
			assistantRevision: "1",
			runtime: { systemPrompt: "Reply briefly", toolIds: [], skills: [], subagents: [] },
		})),
	];
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-targets-"));
	const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	const entered = deferred();
	const release = deferred();
	const factory = createAgentFactory(env, {
		tools: {
			catalog: [{ id: "gate", label: "gate" }],
			create: () => [
				{
					name: "gate",
					label: "gate",
					description: "Hold the current Turn while configuration changes",
					parameters: Type.Object({}),
					async execute(_id, _args, signal) {
						entered.resolve();
						await Promise.race([
							release.promise,
							new Promise<void>((resolve) => {
								if (signal?.aborted) resolve();
								else signal?.addEventListener("abort", () => resolve(), { once: true });
							}),
						]);
						return { content: [{ type: "text", text: "released" }], details: {} };
					},
				},
			],
		},
	});
	const agents = new Map<string, ReturnType<typeof factory.create>>();
	const communications = new Map<string, WorkerSessionCommunication>();
	const streams = new Map<string, number>();
	const create = factory.create.bind(factory);
	factory.create = (...args) => {
		const agent = create(...args);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// Keep the real Agent loop and tools; only replace token pacing with a local scripted provider.
		agent.streamFunction = (_model, context, options) => {
			streams.set(args[1], (streams.get(args[1]) ?? 0) + 1);
			const last = [...context.messages].reverse().find((message) => !isCapabilityCatalog(message));
			const input = last?.role === "user" ? contentText(last.content) : "";
			const command = /^调用工具\s+(\S+)\s+([\s\S]+)$/.exec(input);
			faux.setResponses([
				command
					? fauxAssistantMessage([fauxToolCall(command[1], JSON.parse(command[2]))], { stopReason: "toolUse" })
					: fauxAssistantMessage("done"),
			]);
			return models.streamSimple(faux.getModel(), context, options);
		};
		agents.set(args[1], agent);
		if (args[10]) communications.set(args[1], args[10]);
		return agent;
	};
	const runtime = await createLocalRuntime({
		store: openStore(env),
		agents: factory,
		plugins: createPlugins(env),
		traceToolStream: false,
	});
	t.after(async () => {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await runtime.registerHostRuntimes(definitions([reviewer]));
	return { runtime, agents, communications, streams, entered, release };
}

async function invoke(
	runtime: Awaited<ReturnType<typeof createLocalRuntime>>,
	sessionId: string,
	tool: string,
	input: unknown,
) {
	await runtime.submitTurn(sessionId, { text: `调用工具 ${tool} ${JSON.stringify(input)}` });
	return runtime.waitForTurn(sessionId);
}

function result(snapshot: SessionSnapshot, tool: string) {
	const message = [...snapshot.messages]
		.reverse()
		.find((entry) => entry.role === "toolResult" && entry.toolName === tool);
	assert(message?.role === "toolResult");
	return message;
}

test(
	"Worker registries retain more than 32 targets per assistant without truncation",
	{ timeout: 15000 },
	async (t) => {
		const f = await fixture(t);
		const targets = Array.from({ length: 34 }, (_, index) => ({
			assistantId: `assistant-${index}`,
			name: `Assistant ${index}`,
			description: `Review area ${index}`,
		}));
		await f.runtime.registerHostRuntimes(
			targets.map((source) => ({
				assistantId: source.assistantId,
				assistantRevision: "1",
				runtime: {
					systemPrompt: "Coordinate independently",
					toolIds: [],
					skills: [],
					subagents: [],
					workerTargets: targets.filter((target) => target.assistantId !== source.assistantId),
				},
			})),
		);
		const worker = await f.runtime.createSession({
			assistantId: targets[0].assistantId,
			workerId: targets[0].assistantId,
			mode: "faux",
		});
		assert.deepEqual(f.communications.get(worker.id)?.targets, targets.slice(1));
		assert.deepEqual(worker.runtime?.subagents, []);
		const last = targets[33];
		const sent = result(
			await invoke(f.runtime, worker.id, "communicate", {
				to: last.assistantId,
				content: "Review",
				new_session: true,
			}),
			"communicate",
		);
		assert.equal(sent.isError, false, JSON.stringify(sent));
		const receipt = (sent.details as { sent?: WorkerEnqueueResult }).sent;
		assert(receipt);
		assert.equal(receipt.message.workerId, last.assistantId);
		assert.equal((await f.runtime.waitWorkerDelivery(receipt.delivery.deliveryId)).status, "consumed");
	},
);

test(
	"all root Sessions use the authorized communication targets without task bindings",
	{ timeout: 15000 },
	async (t) => {
		const f = await fixture(t);
		await assert.rejects(
			f.runtime.registerHostRuntimes(definitions([{ ...reviewer, assistantId: "missing" }])),
			/不存在/,
		);
		const worker = await f.runtime.createSession({ assistantId: "a", workerId: "a", mode: "faux" });
		const send = f.agents.get(worker.id)!.state.tools.find((tool) => tool.name === "communicate");
		assert(send);
		assert.match(send.description, /"id":"b","name":"Reviewer","description":"Worker review only"/);
		assert.doesNotMatch(send.description, /legacy-task|Legacy task only/);
		assert(!f.agents.get(worker.id)!.state.tools.some((tool) => tool.name === "task"));
		assert.deepEqual(f.communications.get(worker.id)?.targets, [reviewer]);
		const sent = result(
			await invoke(f.runtime, worker.id, "communicate", { to: "b", content: "Review", new_session: true }),
			"communicate",
		);
		assert.equal(sent.isError, false, JSON.stringify(sent));
		const receipt = (sent.details as { sent?: WorkerEnqueueResult }).sent;
		assert(receipt);
		assert.equal(receipt.message.workerId, "b");
		assert.equal((await f.runtime.waitWorkerDelivery(receipt.delivery.deliveryId)).status, "consumed");
		assert.equal(
			result(await invoke(f.runtime, worker.id, "communicate", { to: "c", content: "Denied" }), "communicate")
				.isError,
			true,
		);

		const session = await f.runtime.createSession({ assistantId: "a", mode: "faux" });
		const tools = f.agents.get(session.id)!.state.tools;
		assert.equal(session.workerId, "a");
		assert(!tools.some((tool) => tool.name === "task"));
		assert.match(tools.find((tool) => tool.name === "communicate")!.description, /Worker review only/);
		assert.deepEqual(f.communications.get(session.id)?.targets, [reviewer]);
		const denied = result(
			await invoke(f.runtime, session.id, "communicate", {
				to: "c",
				content: "Forbidden",
			}),
			"communicate",
		);
		assert.equal(denied.isError, true);
		const allowed = result(
			await invoke(f.runtime, session.id, "communicate", {
				to: "b",
				content: "Allowed",
				new_session: true,
				wait: false,
			}),
			"communicate",
		);
		assert.equal(allowed.isError, false, JSON.stringify(allowed));
		const ordinaryReceipt = (allowed.details as { sent: WorkerEnqueueResult }).sent;
		assert.equal(ordinaryReceipt.message.workerId, "b");
		await f.runtime.waitWorkerDelivery(ordinaryReceipt.delivery.deliveryId);

		await f.runtime.registerHostRuntimes(definitions(undefined));
		const fallback = await f.runtime.createSession({ assistantId: "a", workerId: "a", mode: "faux" });
		assert.deepEqual(f.communications.get(fallback.id)?.targets, [legacy]);
		const legacySend = result(
			await invoke(f.runtime, fallback.id, "communicate", { to: "c", content: "Review", new_session: true }),
			"communicate",
		);
		assert.equal(legacySend.isError, false, JSON.stringify(legacySend));
		const legacyReceipt = (legacySend.details as { sent?: WorkerEnqueueResult }).sent;
		assert(legacyReceipt);
		await f.runtime.waitWorkerDelivery(legacyReceipt.delivery.deliveryId);
	},
);

test(
	"Worker target changes revoke immediately without expanding the current Turn directory",
	{ timeout: 15000 },
	async (t) => {
		const f = await fixture(t);
		const worker = await f.runtime.createSession({ assistantId: "a", workerId: "a", mode: "faux" });
		const started = await f.runtime.submitTurn(worker.id, { text: "调用工具 gate {}" });
		await f.entered.promise;
		assert.equal(f.streams.get(worker.id), 1, "the injected provider must execute the gated Turn");
		const held = await f.runtime.getSession(worker.id);
		assert.equal(held.turn?.id, started.turnId);
		assert.equal(held.turn?.status, "running");
		assert(held.execution.activeTools.some((tool) => tool.toolName === "gate"));
		const communication = f.communications.get(worker.id)!;
		await f.runtime.registerHostRuntimes(definitions([reviewer, legacy]));
		await assert.rejects(communication.send("new-target", { to: "c", content: "Denied during current Turn" }), {
			status: 403,
		});
		const allowed = await communication.send("existing-target", { to: "b", content: "Allowed", new_session: true });
		assert.equal((await f.runtime.waitWorkerDelivery(allowed.delivery.deliveryId)).status, "consumed");
		await f.runtime.registerHostRuntimes(definitions([]));
		await assert.rejects(communication.send("revoked-target", { to: "b", content: "Revoked" }), { status: 403 });
		const revokedWhileHeld = await f.runtime.getSession(worker.id);
		assert.equal(revokedWhileHeld.turn?.id, started.turnId);
		assert.equal(revokedWhileHeld.turn?.status, "running");
		assert(revokedWhileHeld.execution.activeTools.some((tool) => tool.toolName === "gate"));
		assert.equal(f.streams.get(worker.id), 1, "directory changes must happen before the gated Turn can advance");
		f.release.resolve();
		await f.runtime.waitForTurn(worker.id);
		const revoked = result(
			await invoke(f.runtime, worker.id, "communicate", { to: "c", content: "No fallback" }),
			"communicate",
		);
		assert.equal(revoked.isError, true);
		assert.deepEqual(f.communications.get(worker.id)?.targets, []);
		await f.runtime.registerHostRuntimes(definitions([legacy]));
		const refreshed = result(
			await invoke(f.runtime, worker.id, "communicate", {
				to: "c",
				content: "Allowed next Turn",
				new_session: true,
			}),
			"communicate",
		);
		assert.equal(refreshed.isError, false, JSON.stringify(refreshed));
		assert.deepEqual(f.communications.get(worker.id)?.targets, [legacy]);
		const receipt = (refreshed.details as { sent?: WorkerEnqueueResult }).sent;
		assert(receipt);
		await f.runtime.waitWorkerDelivery(receipt.delivery.deliveryId);
	},
);
