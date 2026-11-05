import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { WorkerEnqueueResult, WorkerRecord } from "@pie/runtime";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});

	return { promise, resolve };
}

test(
	"one Astron assistant schedules independent work Sessions and confines supplements and cancellation",
	{ timeout: 20000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-worker-host-"));
		const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
		const store = openStore(env);
		const entered = new Map(["a", "b", "a2"].map((key) => [key, deferred()]));
		const release = new Map(["a", "b", "a2"].map((key) => [key, deferred()]));
		const calls: { key: string; sessionId: string; directory: string }[] = [];
		const active = new Set<string>();
		let overlap = false;
		const runtime = await createLocalRuntime({
			store,
			plugins: createPlugins(env),
			traceToolStream: false,
			agents: createAgentFactory(env, {
				tools: {
					catalog: [{ id: "gate", label: "gate" }],
					create: (context) => [
						{
							name: "gate",
							label: "gate",
							description: "Controlled local test tool",
							parameters: Type.Object({ key: Type.String() }),
							execute: async (_id, args, signal) => {
								assert(args && typeof args === "object" && "key" in args);
								const key = String(args.key);
								if (active.has(context.sessionId)) overlap = true;
								active.add(context.sessionId);
								calls.push({ key, sessionId: context.sessionId, directory: context.directory });
								entered.get(key)?.resolve();
								try {
									await Promise.race([
										release.get(key)!.promise,
										new Promise<void>((resolve) => {
											if (signal?.aborted) resolve();
											else signal?.addEventListener("abort", () => resolve(), { once: true });
										}),
									]);
									return { content: [{ type: "text", text: key }], details: {} };
								} finally {
									active.delete(context.sessionId);
								}
							},
						},
					],
				},
			}),
		});
		t.after(async () => {
			for (const gate of release.values()) gate.resolve();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		});
		const definitions = [
			{
				assistantId: "contract-assistant",
				assistantRevision: "1",
				runtime: { systemPrompt: "review contracts", toolIds: ["gate"], skills: [], subagents: [] },
			},
		];
		await runtime.registerHostRuntimes(definitions);
		assert.deepEqual(
			(await runtime.listWorkers()).map((worker) => worker.workerId),
			["contract-assistant"],
		);
		const send = (key: string, workId: string, newSession = false) =>
			runtime.enqueueWorkerMessage({
				messageId: `message-${key}`,
				workerId: "contract-assistant",
				sourceWorkerId: "contract-assistant",
				kind: "request",
				content: `调用工具 gate ${JSON.stringify({ key })}`,
				workId,
				newSession,
				title: `合同${workId}`,
				workspacePath: join(directory, workId),
				mode: "faux",
				productBinding: { astronSessionId: `product-${workId}` },
			});
		const a = await send("a", "a", true);
		const b = await send("b", "b", true);
		await Promise.all([entered.get("a")!.promise, entered.get("b")!.promise]);
		const aDelivery = await runtime.getWorkerDelivery(a.delivery.deliveryId);
		const bDelivery = await runtime.getWorkerDelivery(b.delivery.deliveryId);
		assert(aDelivery.sessionId && bDelivery.sessionId);
		assert.notEqual(aDelivery.sessionId, bDelivery.sessionId);
		assert.equal(active.size, 2, "one assistant must execute different Sessions concurrently");
		assert.equal(store.readSession(aDelivery.sessionId)?.astronSessionId, "product-a");
		assert.equal(store.readSession(bDelivery.sessionId)?.astronSessionId, "product-b");
		const supplement = await send("a2", "a");
		assert.equal(
			calls.some((call) => call.key === "a2"),
			false,
		);
		release.get("a")!.resolve();
		await entered.get("a2")!.promise;
		assert.equal(calls.find((call) => call.key === "a2")?.sessionId, aDelivery.sessionId);
		assert.equal(calls.find((call) => call.key === "a2")?.directory, join(directory, "a"));
		assert.equal(overlap, false, "a Session must never execute concurrent Turns");
		const aTurn = (await runtime.getSession(aDelivery.sessionId)).turn;
		assert(aTurn);
		await runtime.cancelTurn(aDelivery.sessionId, { turnId: aTurn.id });
		assert.equal((await runtime.waitForTurn(aDelivery.sessionId)).turn?.status, "cancelled");
		assert.equal((await runtime.getSession(bDelivery.sessionId)).turn?.status, "running");
		release.get("b")!.resolve();
		await Promise.all([
			runtime.waitWorkerDelivery(a.delivery.deliveryId),
			runtime.waitWorkerDelivery(b.delivery.deliveryId),
			runtime.waitWorkerDelivery(supplement.delivery.deliveryId),
		]);
		assert.equal((await runtime.getSession(bDelivery.sessionId)).turn?.status, "completed");
		assert.equal(overlap, false);
		await runtime.registerHostRuntimes([{ ...definitions[0], assistantRevision: "2" }]);
		const workers = await runtime.listWorkers();
		assert.equal(workers.length, 1);
		assert.equal(workers[0].assistantRevision, "2");
		assert.equal(calls.length, 3, "deterministic routing must not call extra model/tool work");
	},
);

test(
	"HTTP registers Workers from Astron runtimes and persists inbox receipts across restart",
	{ timeout: 15000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-worker-http-"));
		const start = async () => {
			const core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
			await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
			const address = core.server.address();
			assert(address && typeof address !== "string");
			return {
				...core,
				request: (path: string, method = "GET", body?: unknown) =>
					fetch(`http://127.0.0.1:${address.port}${path}`, {
						method,
						...(body === undefined
							? {}
							: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
					}),
			};
		};
		let core = await start();
		t.after(async () => {
			await core.close();
			await rm(directory, { recursive: true, force: true });
		});
		const definition = {
			assistantId: "astron-assistant",
			assistantRevision: "revision-1",
			runtime: { systemPrompt: "Astron prompt", toolIds: [], skills: [], subagents: [] },
		};
		assert.equal((await core.request("/host-runtimes", "PUT", { runtimes: [definition] })).status, 200);
		const workers = (await (await core.request("/workers")).json()) as { workers: WorkerRecord[] };
		assert.equal(workers.workers[0].workerId, definition.assistantId);
		const body = {
			messageId: "http-message",
			sourceWorkerId: definition.assistantId,
			kind: "request",
			content: "new contract",
			newSession: true,
			mode: "faux",
			productBinding: "astron-chat-1",
		};
		const first = await core.request(`/workers/${definition.assistantId}/messages`, "POST", body);
		assert.equal(first.status, 202);
		const receipt = (await first.json()) as WorkerEnqueueResult;
		const runtime = await core.ready;
		const final = await runtime.waitWorkerDelivery(receipt.delivery.deliveryId);
		assert.equal(final.status, "consumed");
		assert(final.sessionId);
		assert.equal((await runtime.exportSession(final.sessionId)).source.astronSessionId, "astron-chat-1");
		const conflicting = await core.request(`/workers/${definition.assistantId}/messages`, "POST", {
			...body,
			content: "different",
		});
		assert.equal(conflicting.status, 409);
		for (const invalid of [
			{ sourceWorkerId: 1 },
			{ content: 1 },
			{ kind: "bogus" },
			{ mode: "live" },
			{ newSession: "yes" },
		]) {
			assert.equal(
				(
					await core.request(`/workers/${definition.assistantId}/messages`, "POST", {
						...body,
						messageId: "invalid",
						...invalid,
					})
				).status,
				400,
			);
		}
		await core.close();
		core = await start();
		const afterRestart = await core.request(`/worker-deliveries/${encodeURIComponent(final.deliveryId)}`);
		assert.equal(afterRestart.status, 200);
		assert.deepEqual(await afterRestart.json(), final);
		const retry = await core.request(`/workers/${definition.assistantId}/messages`, "POST", body);
		assert.equal(retry.status, 202);
		assert.equal(((await retry.json()) as WorkerEnqueueResult).delivery.status, "consumed");
		assert.equal((await (await core.ready).listSessions()).sessions.length, 1);
		assert.equal((await core.request("/worker-deliveries/missing")).status, 404);
	},
);
