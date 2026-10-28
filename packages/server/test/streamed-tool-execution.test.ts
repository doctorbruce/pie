import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRuntime, type DurableJobReference, recoverInterruptedTurn, type SessionMetadata } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { jobAgents, jobDefinition, persistentJobs } from "./fixtures/durable-job-host.ts";

async function until<Value>(read: () => Value | undefined): Promise<Value> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const value = read();
		if (value !== undefined) return value;
		await delay(5);
	}
	throw new Error("Timed out waiting for streamed tool execution");
}

async function start(context: TestContext, rejectCheckpoint = false, ignoreAbort = false) {
	const directory = await mkdtemp(join(tmpdir(), "pie-streamed-tools-"));
	const local = openStore({ PI_DATA_DIR: directory, PI_TURN_RECOVERY: "manual" });
	const store = createSqliteRuntimeStore(local);
	const jobs = persistentJobs(directory);
	const stream = createAssistantMessageEventStream();
	const message = fauxAssistantMessage([], { stopReason: "pending" });
	let finished = false;
	let requests = 0;
	let submitted: DurableJobReference | undefined;
	let committed: SessionMetadata | undefined;
	const finish = (stopReason: "toolUse" | "aborted" = "toolUse") => {
		if (finished) return;
		finished = true;
		const finalMessage: AssistantMessage = { ...structuredClone(message), stopReason };
		if (stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: finalMessage });
		else stream.push({ type: "done", reason: stopReason, message: finalMessage });
	};
	const saveSession = store.saveSession;
	store.saveSession = async (...args) => {
		if (rejectCheckpoint && args[0].turnCheckpoint?.pendingAssistant) {
			rejectCheckpoint = false;
			throw new Error("checkpoint disk failure");
		}
		return saveSession(...args);
	};
	const factory = jobAgents();
	const runtime = await createRuntime({
		store,
		agents: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				agent.streamFunction = (_model, _context, options) => {
					requests++;
					if (requests === 1) {
						if (!ignoreAbort) options?.signal?.addEventListener("abort", () => finish("aborted"), { once: true });
						return stream;
					}
					const next = createAssistantMessageEventStream();
					next.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
					return next;
				};
				return agent;
			},
		},
		jobs: {
			...jobs.executor,
			async submit(...args) {
				committed = local.readSession(args[0].sessionId);
				await jobs.executor.submit(...args);
				submitted = args[0];
			},
		},
		hostRuntimes: [jobDefinition],
	});
	context.after(async () => {
		finish("aborted");
		await runtime.close();
		jobs.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "assistant" });
	await runtime.submitTurn(session.id, { text: "execute" });
	stream.push({ type: "start", partial: structuredClone(message) });
	const call = fauxToolCall("remote", { value: "effect" }, { id: "early-call" });
	message.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(message) });
	stream.push({
		type: "toolcall_delta",
		contentIndex: 0,
		delta: JSON.stringify(call.arguments),
		partial: structuredClone(message),
	});
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: structuredClone(message) });
	return {
		runtime,
		local,
		jobs,
		session,
		finish,
		get requests() {
			return requests;
		},
		get submitted() {
			return submitted;
		},
		get committed() {
			return committed;
		},
	};
}

test(
	"SQLite commits the early call before external submission and commits its final history exactly once",
	{ timeout: 10000 },
	async (context) => {
		const host = await start(context);
		const reference = await until(() => host.submitted);
		const saved = host.committed!;
		assert.equal(host.requests, 1);
		assert.equal(saved.turnCheckpoint?.pendingAssistant?.content[0].type, "toolCall");
		assert.equal(saved.turnCheckpoint?.jobs?.[0].id, reference.id);
		const path = host.local.readPath(host.session.id);
		assert.equal(
			path.nodes.some((node) => node.message.role === "assistant"),
			false,
		);
		const recovery = recoverInterruptedTurn(saved, path);
		assert.equal(recovery?.status, "failed");
		assert.match(recovery?.error ?? "", /模型响应尚未完成/);
		let ended = false;
		await host.runtime.subscribe(host.session.id, (packet) => {
			if (packet.event?.type === "tool_execution_end") ended = true;
		});
		host.jobs.update(reference, {
			status: "completed",
			result: { content: [{ type: "text", text: "result" }], details: {} },
		});
		await until(() => ended || undefined);
		assert.equal(host.requests, 1);
		assert(host.local.readSession(host.session.id)?.turnCheckpoint?.pendingAssistant);
		host.finish();
		const completed = await host.runtime.waitForTurn(host.session.id);
		assert.equal(completed.turn?.status, "completed");
		assert.equal(host.requests, 2);
		assert.equal(host.jobs.submissions, 1);
		assert.equal(host.local.readSession(host.session.id)?.turnCheckpoint, undefined);
		const messages = host.local.readPath(host.session.id).nodes.map((node) => node.message);
		assert.equal(
			messages.filter(
				(entry) => entry.role === "assistant" && entry.content.some((part) => part.type === "toolCall"),
			).length,
			1,
		);
		assert.equal(messages.filter((entry) => entry.role === "toolResult").length, 1);
	},
);

test(
	"a failed early-call checkpoint prevents external side effects and the next model request",
	{ timeout: 10000 },
	async (context) => {
		const host = await start(context, true);
		const completed = await host.runtime.waitForTurn(host.session.id);
		assert.equal(completed.turn?.status, "failed");
		assert.match(completed.turn?.error ?? "", /会话写入失败/);
		assert.equal(host.jobs.submissions, 0);
		assert.equal(host.requests, 1);
	},
);

test(
	"one cancellation settles SQLite and external jobs while the provider remains open",
	{ timeout: 10000 },
	async (context) => {
		const host = await start(context, false, true);
		const reference = await until(() => host.submitted);
		const startedAt = performance.now();
		await host.runtime.cancelTurn(host.session.id, { turnId: reference.turnId });
		const completed = await Promise.race([
			host.runtime.waitForTurn(host.session.id),
			delay(500).then(() => undefined),
		]);
		assert(completed, "The provider must not hold up cancellation settlement");
		assert.equal(completed.turn?.status, "cancelled");
		assert.equal(host.local.readSession(host.session.id)?.turn?.status, "cancelled");
		assert.equal((await host.jobs.executor.get(reference))?.status, "cancelled");
		assert.equal(host.requests, 1);
		context.diagnostic(`Cancellation and durable settlement took ${(performance.now() - startedAt).toFixed(1)} ms`);
		await host.runtime.submitTurn(host.session.id, { text: "next" });
		assert.equal((await host.runtime.waitForTurn(host.session.id)).turn?.status, "completed");
		const snapshot = await host.runtime.getSession(host.session.id);
		host.finish();
		await delay(10);
		assert.deepEqual(await host.runtime.getSession(host.session.id), snapshot);
	},
);

test("a late external submission cannot change the next turn or its history", { timeout: 10000 }, async (context) => {
	const host = await start(context, false, true);
	let entered = false;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const submit = host.jobs.executor.submit;
	host.jobs.executor.submit = async (...args) => {
		entered = true;
		await blocked;
		await submit(...args);
	};
	try {
		await until(() => entered || undefined);
		const turnId = host.local.readSession(host.session.id)!.turn!.id;
		await host.runtime.cancelTurn(host.session.id, { turnId });
		assert.equal((await host.runtime.waitForTurn(host.session.id)).turn?.status, "cancelled");
		await host.runtime.submitTurn(host.session.id, { text: "next" });
		assert.equal((await host.runtime.waitForTurn(host.session.id)).turn?.status, "completed");
		const snapshot = await host.runtime.getSession(host.session.id);
		release();
		await delay(20);
		assert.deepEqual(await host.runtime.getSession(host.session.id), snapshot);
	} finally {
		release();
	}
});
