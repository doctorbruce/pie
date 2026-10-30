import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentFactory } from "../../local/src/agent.ts";
import { createPlugins } from "../../local/src/plugins.ts";
import { createLocalRuntime } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";

test(
	"Local cancellation bypasses a blocked ordinary command and never retargets the next turn",
	{ timeout: 5000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pie-local-cancel-"));
		const env = { PI_DATA_DIR: directory };
		const store = openStore(env);
		let markEntered = () => {};
		let releaseCommand = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseCommand = resolve;
		});
		const saveAssistant = store.saveAssistant;
		store.saveAssistant = async (...args) => {
			markEntered();
			await release;
			return saveAssistant(...args);
		};
		const runtime = await createLocalRuntime({
			store,
			agents: createAgentFactory(env),
			plugins: createPlugins(env),
			traceToolStream: false,
		});
		try {
			const session = await runtime.createSession({ mode: "faux" });
			const first = await runtime.submitTurn(session.id, { text: "hello" });
			const command = runtime.saveAssistant({ name: "blocked", systemPrompt: "", toolIds: [] });
			await entered;
			const receipt = await Promise.race([
				runtime.cancelTurn(session.id, { turnId: first.turnId }),
				new Promise<never>((_, reject) => {
					const timer = setTimeout(() => reject(new Error("Local command queue blocked cancellation")), 500);
					timer.unref();
				}),
			]);
			assert.equal(receipt.turnId, first.turnId);
			assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "cancelled");
			assert.deepEqual(await runtime.cancelTurn(session.id, { turnId: first.turnId }), {
				...receipt,
				accepted: false,
				settled: true,
				cancellationRequested: false,
				durable: false,
			});
			releaseCommand();
			await command;
			const next = await runtime.submitTurn(session.id, { text: "next" });
			await assert.rejects(runtime.cancelTurn(session.id, { turnId: first.turnId }), { status: 409 });
			assert.equal((await runtime.waitForTurn(session.id)).turn?.id, next.turnId);
			assert.equal((await runtime.getSession(session.id)).execution.actions.submit.available, true);
		} finally {
			releaseCommand();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
