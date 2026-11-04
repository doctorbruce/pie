import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import {
	createAgentFactory,
	createRuntime,
	type ExecutionStreamEvent,
	type GlobalSessionEvent,
	type ModelRetryEvent,
	type SessionEvent,
} from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

for (const scoped of [false, true]) {
	test(
		`HTTP ${scoped ? "scoped" : "global"} SSE retains model retry payload and execution owner`,
		{ timeout: 10000 },
		async (context) => {
			const directory = await mkdtemp(join(tmpdir(), "pie-http-retry-"));
			const core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
			const abort = new AbortController();
			context.after(async () => {
				abort.abort();
				await core.close();
				await rm(directory, { recursive: true, force: true });
			});
			const runtime = await core.ready;
			const session = await runtime.createSession({});
			await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
			const address = core.server.address();
			assert(address && typeof address !== "string");
			let send: ((packet: GlobalSessionEvent) => void) | undefined;
			let subscribed = () => {};
			const ready = new Promise<void>((resolve) => {
				subscribed = resolve;
			});
			if (scoped) {
				context.mock.method(
					runtime,
					"subscribeExecutions",
					async (_ids: string[], next: (packet: ExecutionStreamEvent) => void) => {
						send = next;
						subscribed();
						return () => {};
					},
				);
			} else {
				context.mock.method(runtime, "subscribeAll", (next: (packet: GlobalSessionEvent) => void) => {
					send = next;
					subscribed();
					return () => {};
				});
			}
			const response = fetch(`http://127.0.0.1:${address.port}/events${scoped ? `?sessionId=${session.id}` : ""}`, {
				signal: abort.signal,
			});
			await ready;
			assert(send);
			const events: ModelRetryEvent[] = (["started", "completed", "failed"] as const).map((status) => ({
				type: "model.retry",
				retryId: "model-call",
				status,
				attempt: 1,
				message: "Upstream API error: 530",
				...(status === "started" ? { next: 1793701532760 } : {}),
			}));
			const turn = {
				id: "native-turn",
				requestId: "request-A",
				canonicalTurnId: "canonical-A",
				status: "running" as const,
			};
			for (const [index, event] of events.entries())
				send({
					type: "model.retry",
					sessionId: session.id,
					turnId: turn.id,
					event,
					snapshot: {
						instanceId: session.instanceId,
						revision: session.revision + index + 1,
						turn,
						execution: session.execution,
					},
				});
			const stream = await response;
			assert.equal(stream.status, 200);
			assert(stream.body);
			const reader = stream.body.getReader();
			const decoder = new TextDecoder();
			let text = "";
			while (text.split("\n\n").length <= events.length) {
				const { done, value } = await reader.read();
				assert.equal(done, false);
				text += decoder.decode(value, { stream: true });
			}
			await reader.cancel();
			const received = text
				.trim()
				.split("\n\n")
				.map((frame) => JSON.parse(frame.slice(6)) as SessionEvent);
			assert.deepEqual(
				received.map((packet) => packet.event),
				events,
			);
			for (const packet of received) {
				assert.equal(packet.type, "model.retry");
				assert.equal(packet.sessionId, session.id);
				assert.equal(packet.turnId, turn.id);
				assert.deepEqual(packet.snapshot?.turn, turn);
				assert.deepEqual(packet.execution, session.execution);
				assert(!("messages" in packet.snapshot!));
			}
		},
	);
}

for (const outcome of ["completed", "failed", "cancelled", "steered"] as const) {
	test(`ordinary model retry publishes ${outcome} to both subscriptions with compaction disabled`, async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-retry-events-"));
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		let attempts = 0;
		let steering: Promise<unknown> | undefined;
		context.mock.method(models, "streamSimple", () => {
			const output = createAssistantMessageEventStream();
			attempts++;
			const message =
				(outcome === "completed" && attempts > 1) || (outcome === "steered" && attempts % 2 === 0)
					? fauxAssistantMessage("recovered")
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: "Upstream API error: 530" });
			if (outcome === "steered" && attempts === 2) {
				assert(steering);
				void steering.then(() => output.push({ type: "done", reason: "stop", message }));
				return output;
			}
			output.push(
				message.stopReason === "error"
					? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message },
			);
			return output;
		});
		const agents = createAgentFactory({
			models: { current: { models, selected: { provider: model.provider, id: model.id } } },
			tools: { catalog: [], create: () => [] },
			skills: () => ({ tools: [], afterToolCall: async () => undefined }),
			mcp: {
				configure() {},
				status: () => ({ servers: {} }),
				acquire: async () => ({ tools: [], instructions: [], release() {} }),
				async close() {},
			},
			recordModelRequest: () => async () => undefined,
			compactionSettings: () => ({
				compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: outcome === "cancelled" ? 60000 : 1 },
			}),
		});
		const runtime = await createRuntime({
			store: createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory })),
			agents,
			hostRuntimes: [
				{
					assistantId: "retry-assistant",
					assistantRevision: "1",
					runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
				},
			],
		});
		context.after(async () => {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		});
		const session = await runtime.createSession({ assistantId: "retry-assistant", mode: "real" });
		const globals: GlobalSessionEvent[] = [];
		const deltas: SessionEvent[] = [];
		const timeline: string[] = [];
		let cancellation: Promise<unknown> | undefined;
		runtime.subscribeAll((packet) => {
			if (packet.type === "turn.settled") timeline.push(packet.type);
			if (packet.type !== "model.retry") return;
			globals.push(packet);
			timeline.push(`retry.${packet.event?.status}`);
			if (outcome === "cancelled" && packet.event?.status === "started")
				cancellation = runtime.cancelTurn(session.id, { turnId: packet.turnId! });
			if (outcome === "steered" && globals.length === 1)
				steering = runtime.steer(session.id, {
					turnId: packet.turnId!,
					text: "follow up",
					requestId: "request-B",
					canonicalTurnId: "canonical-B",
				});
		});
		await runtime.subscribe(session.id, (packet) => {
			if (packet.type === "model.retry") deltas.push(packet);
		});
		const receipt = await runtime.submitTurn(session.id, {
			text: "hello",
			requestId: "request-A",
			canonicalTurnId: "canonical-A",
		});
		const final = await runtime.waitForTurn(session.id);
		await cancellation;
		assert.equal(final.turn?.status, outcome === "steered" ? "completed" : outcome);
		assert.equal(attempts, outcome === "cancelled" ? 1 : outcome === "steered" ? 4 : 2);
		assert.deepEqual(
			globals.map((packet) => packet.event?.status),
			outcome === "steered"
				? ["started", "completed", "started", "completed"]
				: ["started", outcome === "completed" ? "completed" : "failed"],
		);
		assert.deepEqual(timeline.slice(-2), [
			`retry.${outcome === "completed" || outcome === "steered" ? "completed" : "failed"}`,
			"turn.settled",
		]);
		assert.equal(globals.length, deltas.length);
		for (const [index, packet] of globals.entries()) {
			const owner = index < 2 ? "A" : "B";
			assert.equal(packet.turnId, receipt.turnId);
			assert.equal(packet.sessionId, session.id);
			assert.equal(packet.snapshot.turn?.requestId, `request-${owner}`);
			assert.equal(packet.snapshot.turn?.canonicalTurnId, `canonical-${owner}`);
			assert.deepEqual(packet.event, deltas[index].event);
			assert.equal(packet.event?.retryId, globals[index < 2 ? 0 : 2].event?.retryId);
			assert.equal(packet.event?.attempt, 1);
			assert.equal("next" in packet.event!, packet.event?.status === "started");
		}
		if (outcome === "steered") assert.notEqual(globals[0].event?.retryId, globals[2].event?.retryId);
		assert.equal(globals.at(-1)?.event?.message, "Upstream API error: 530");
		assert(!globals.some((packet) => "messages" in packet.snapshot));
	});
}
