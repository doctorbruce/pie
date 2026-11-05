import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalHost } from "@pie/local";
import type { Turn } from "@pie/runtime/protocol";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";

const definition = {
	assistantId: "worker",
	assistantRevision: "1",
	runtime: { systemPrompt: "test", toolIds: [], skills: [], subagents: [] },
};

test("product session binding is part of durable Session creation identity", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-product-"));
	const host = createLocalHost({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	const runtime = await host.ready;
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await runtime.registerHostRuntimes([definition]);
	const input = { assistantId: "worker", creationKey: "product-create", astronSessionId: "astron-a" };
	const session = await runtime.createSession(input);
	assert.equal((await runtime.createSession(input)).id, session.id);
	await assert.rejects(runtime.createSession({ ...input, astronSessionId: "astron-b" }), { status: 409 });
	await assert.rejects(runtime.createSession({ ...input, astronSessionId: " " }), { status: 400 });
	assert.equal((await runtime.exportSession(session.id)).source.astronSessionId, "astron-a");
});

test("failed Worker startup releases Runtime resources and the SQLite directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-init-"));
	const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	let store = openStore(env);
	t.after(async () => {
		try {
			store.close();
		} catch {
			/* Startup must already have closed the store. */
		}
		await rm(directory, { recursive: true, force: true });
	});
	store.replaceHostRuntimes([definition]);
	store.close();
	store = openStore(env);
	store.registerWorker = async () => {
		throw new Error("injected Worker storage failure");
	};
	await assert.rejects(
		createLocalRuntime({
			store,
			agents: createAgentFactory(env),
			plugins: createPlugins(env),
			traceToolStream: false,
		}),
		/Worker 保存失败/,
	);
	const reopened = openStore(env);
	reopened.close();
});

test("Local shutdown settles active Worker receipts before closing SQLite", { timeout: 10000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-worker-shutdown-"));
	const env = { PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" };
	const host = createLocalHost(env);
	const runtime = await host.ready;
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await runtime.registerHostRuntimes([definition]);
	let enter = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const acquire = host.agents.mcp.acquire.bind(host.agents.mcp);
	host.agents.mcp.acquire = async (...args) => {
		enter();
		await new Promise<void>((resolve) => {
			const signal = args[3];
			if (signal?.aborted) resolve();
			else signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return acquire(...args);
	};
	const receipt = await runtime.enqueueWorkerMessage({
		workerId: "worker",
		sourceWorkerId: "worker",
		content: "work",
		messageId: "shutdown-work",
	});
	await entered;
	const running = await runtime.getWorkerDelivery(receipt.delivery.deliveryId);
	assert(running.sessionId);
	const observed: { started?: Turn; settled?: Turn } = {};
	const turnWait = runtime.waitForTurn(running.sessionId, {
		onWait(turn) {
			observed.started = turn;
		},
		onSettled(turn) {
			observed.settled = turn;
		},
	});
	assert.equal(observed.started?.status, "running");
	const delivery = runtime.waitWorkerDelivery(receipt.delivery.deliveryId);
	await runtime.close();
	await turnWait;
	assert.equal(observed.settled?.id, observed.started?.id);
	assert.equal(observed.settled?.status, "cancelled");
	assert.equal(observed.started?.status, "running", "the wait observation must be an immutable copy");
	const settled = await delivery;
	assert(["accepted", "consumed"].includes(settled.status));
	if (settled.status === "accepted") assert.match(settled.error ?? "", /关闭/);
	assert(settled.acceptedTurnId);
	const reopened = openStore(env);
	try {
		assert.deepEqual(await reopened.readWorkerDelivery(settled.deliveryId), settled);
		assert.equal(reopened.readSession(settled.sessionId!)?.turn?.status, "cancelled");
	} finally {
		reopened.close();
	}
});
