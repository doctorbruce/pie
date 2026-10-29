import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentFactory, createLocalHost } from "@pie/local";
import { createRuntime, type SessionEvent, type SessionSnapshot } from "@pie/runtime";
import { applySessionEvent } from "@pie/runtime/session-events";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

async function* readEvents(response: Promise<Response>): AsyncGenerator<SessionEvent> {
	const stream = await response;
	assert.equal(stream.status, 200);
	assert(stream.body);
	const reader = stream.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			while (buffer.includes("\n\n")) {
				const boundary = buffer.indexOf("\n\n");
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6));
			}
		}
	} finally {
		await reader.cancel();
	}
}

test(
	"Local cancellation reaches active execution before queued history and shutdown",
	{ timeout: 10000 },
	async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-local-cancel-"));
		const host = createLocalHost({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
		let entered = () => {};
		let release = () => {};
		let aborted = false;
		const preparing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const acquire = host.agents.mcp.acquire.bind(host.agents.mcp);
		host.agents.mcp.acquire = async (...args) => {
			args[3]?.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			entered();
			await blocked;
			return acquire(...args);
		};
		const runtime = await host.ready;
		context.after(async () => {
			release();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		});
		const session = await runtime.createSession({});
		const turn = await runtime.submitTurn(session.id, { text: "original" });
		await preparing;
		await assert.rejects(runtime.cancelTurn(session.id, { turnId: "stale" }), { status: 409 });
		assert.equal(aborted, false);
		const reading = runtime.getSession(session.id, { limit: 1 });
		const cancellation = runtime.cancelTurn(session.id, { turnId: turn.turnId });
		assert.equal(aborted, true, "Cancellation must reach execution before queued Local reads run");
		await reading;
		assert.equal((await cancellation).cancellationRequested, true);
		const settlement = runtime.waitForTurn(session.id);
		const closing = runtime.close();
		await assert.rejects(runtime.cancelTurn(session.id, { turnId: turn.turnId }), { status: 503 });
		release();
		assert.equal((await settlement).turn?.status, "cancelled");
		await closing;
	},
);

for (const cancelAt of ["after confirmation", "during confirmation"]) {
	test(
		`HTTP snapshots, session deltas and every global event share execution when cancelling ${cancelAt}`,
		{ timeout: 15000 },
		async (context) => {
			const directory = await mkdtemp(join(tmpdir(), "pie-http-execution-"));
			const core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
			const abort = new AbortController();
			context.after(async () => {
				abort.abort();
				await core.close();
				await rm(directory, { recursive: true, force: true });
			});
			await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
			const address = core.server.address();
			assert(address && typeof address !== "string");
			const base = `http://127.0.0.1:${address.port}`;
			const post = (path: string, body: unknown) =>
				fetch(`${base}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: abort.signal,
				});
			const runtime = await core.ready;
			await runtime.registerHostRuntimes([
				{
					assistantId: "confirmation",
					assistantRevision: "1",
					runtime: { systemPrompt: "Test", toolIds: ["bash"], skills: [], subagents: [] },
				},
			]);
			const session = await runtime.createSession({ assistantId: "confirmation" });
			// Observe subscription readiness without relying on network timing or heartbeat delivery.
			let subscribed = () => {};
			const ready = new Promise<void>((resolve) => {
				subscribed = resolve;
			});
			const subscribeAll = runtime.subscribeAll;
			runtime.subscribeAll = (...args) => {
				const unsubscribe = subscribeAll(...args);
				subscribed();
				return unsubscribe;
			};
			const globalResponse = fetch(`${base}/events`, { signal: abort.signal });
			await ready;
			const globalPackets: SessionEvent[] = [];
			const collecting = (async () => {
				for await (const packet of readEvents(globalResponse)) {
					globalPackets.push(packet);
					if (packet.type === "turn.settled") return;
				}
			})();
			const sessionStream = readEvents(fetch(`${base}/sessions/${session.id}/events`, { signal: abort.signal }));
			const bootstrap = (await sessionStream.next()).value;
			const initial = bootstrap?.snapshot;
			assert(initial);
			assert.deepEqual(bootstrap.execution, initial.execution);
			const current = (await (await fetch(`${base}/sessions/${session.id}?limit=50`)).json()) as SessionSnapshot;
			assert.deepEqual(initial.execution, current.execution);
			const command = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
			assert.equal(
				(await post(`/sessions/${session.id}/turns`, { text: `调用工具 bash ${JSON.stringify({ command })}` }))
					.status,
				202,
			);
			const packets: SessionEvent[] = [];
			const waitingSnapshots: SessionSnapshot[] = [];
			let projected = initial;
			for await (const packet of sessionStream) {
				packets.push(packet);
				const next = applySessionEvent(projected, packet);
				assert(next);
				projected = next;
				if (packet.type === "interaction.requested") {
					assert(packet.interaction);
					assert.equal(packet.execution?.waitingForInteraction, true);
					const waiting = (await (
						await fetch(`${base}/sessions/${session.id}?limit=50`)
					).json()) as SessionSnapshot;
					assert.equal(waiting.execution.waitingForInteraction, true);
					const waitingStream = readEvents(
						fetch(`${base}/sessions/${session.id}/events`, { signal: abort.signal }),
					);
					const waitingBootstrap = (await waitingStream.next()).value;
					assert(waitingBootstrap?.snapshot);
					assert.equal(waitingBootstrap.execution?.waitingForInteraction, true);
					assert.deepEqual(waitingBootstrap.execution, waitingBootstrap.snapshot.execution);
					waitingSnapshots.push(waiting, waitingBootstrap.snapshot);
					await waitingStream.return(undefined);
					const response =
						cancelAt === "after confirmation"
							? await post(`/sessions/${session.id}/interactions/${packet.interaction.id}`, { approved: true })
							: await post(`/sessions/${session.id}/cancel`, { turnId: packet.turnId });
					assert.equal(response.status, 202);
				}
				if (packet.type === "interaction.resolved") {
					assert.equal(packet.execution?.waitingForInteraction, false);
					if (cancelAt === "after confirmation")
						assert.equal((await post(`/sessions/${session.id}/cancel`, { turnId: packet.turnId })).status, 202);
				}
				if (packet.type === "turn.settled") break;
			}
			await collecting;
			for (const snapshot of waitingSnapshots) {
				const packet = packets.find((entry) => entry.revision === snapshot.revision);
				assert(packet);
				assert.deepEqual(snapshot.execution, packet.execution);
			}
			assert(packets.some((packet) => packet.type === "interaction.resolved"));
			assert(packets.some((packet) => packet.execution?.cancellationRequested));
			assert(packets.some((packet) => packet.execution?.modelStreaming));
			assert(packets.some((packet) => packet.execution?.activeTools.length));
			assert.deepEqual(
				globalPackets.map((packet) => packet.revision),
				packets.map((packet) => packet.revision),
			);
			for (const packet of packets) {
				const global = globalPackets.find((entry) => entry.revision === packet.revision);
				assert(global);
				assert.equal(global.instanceId, packet.instanceId);
				assert.deepEqual(global.execution, packet.execution);
				assert.equal("messages" in (global.snapshot ?? {}), false);
				if (packet.type === "interaction.requested" || packet.type === "interaction.resolved")
					assert.deepEqual(global.interaction, packet.interaction);
			}
			const final = (await (await fetch(`${base}/sessions/${session.id}?limit=50`)).json()) as SessionSnapshot;
			assert.equal(final.turn?.status, "cancelled");
			assert.deepEqual(projected.execution, final.execution);
			const reconnect = readEvents(fetch(`${base}/sessions/${session.id}/events`, { signal: abort.signal }));
			assert.deepEqual((await reconnect.next()).value?.snapshot?.execution, final.execution);
			await reconnect.return(undefined);
		},
	);
}

test("global streaming does not read full history and permits cancellation followed by a new session", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-global-stream-"));
	const environment = { PI_DATA_DIR: directory, PI_TOOLS_DIR: join(directory, "tools") };
	await mkdir(environment.PI_TOOLS_DIR);
	const store = createSqliteRuntimeStore(openStore(environment));
	const readPath = store.readPath;
	let historyReads = 0;
	store.readPath = async (...args) => {
		historyReads++;
		return readPath(...args);
	};
	const runtime = await createRuntime({
		store,
		agents: createAgentFactory(environment),
		hostRuntimes: [
			{
				assistantId: "host-assistant",
				assistantRevision: "1",
				runtime: { systemPrompt: "Reply briefly.", toolIds: [], skills: [], subagents: [] },
			},
		],
	});
	context.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "host-assistant" });
	const baselineReads = historyReads;
	let resolveFirstDelta: () => void = () => {};
	const firstDelta = new Promise<void>((resolve) => {
		resolveFirstDelta = resolve;
	});
	const completedSessions = new Set<string>();
	let globalHistoryIncluded = false;
	let globalMutationLeaked = false;
	runtime.subscribeAll((packet) => {
		if (packet.snapshot.turn) packet.snapshot.turn.id = "mutated-by-subscriber";
	});
	runtime.subscribeAll((packet) => {
		globalHistoryIncluded ||= "messages" in packet.snapshot;
		globalMutationLeaked ||= packet.snapshot.turn?.id === "mutated-by-subscriber";
		if (packet.sessionId === session.id && packet.event?.type === "message_update") resolveFirstDelta();
		if (packet.type === "turn.settled") completedSessions.add(packet.sessionId);
	});
	const accepted = await runtime.submitTurn(session.id, {
		text: "hello",
		images: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(128 * 1024).toString("base64") }],
	});
	await firstDelta;
	assert.equal(historyReads, baselineReads, "global token events must not decode the persisted conversation");
	await runtime.cancelTurn(session.id, { turnId: accepted.turnId });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "cancelled");
	const next = await runtime.createSession({ assistantId: "host-assistant" });
	await runtime.submitTurn(next.id, { text: "hello" });
	assert.equal((await runtime.waitForTurn(next.id)).turn?.status, "completed");
	assert(completedSessions.has(session.id));
	assert(completedSessions.has(next.id));
	assert.equal(globalHistoryIncluded, false);
	assert.equal(globalMutationLeaked, false);
	const baseline = await runtime.getSession(session.id);
	const fullPackets: SessionEvent[] = [];
	await runtime.subscribe(session.id, (packet) => fullPackets.push(packet));
	await runtime.submitTurn(session.id, { text: "hello again" });
	const completed = await runtime.waitForTurn(session.id);
	assert.equal(completed.turn?.status, "completed");
	const settled = fullPackets.find((packet) => packet.type === "turn.settled");
	assert(settled);
	assert(fullPackets.every((packet) => !packet.snapshot));
	let reconstructed = baseline;
	for (const packet of fullPackets) {
		const next = applySessionEvent(reconstructed, packet);
		assert(next);
		reconstructed = next;
	}
	assert.deepEqual(reconstructed.messages, completed.messages);
	assert(
		reconstructed.messages.some(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "image"),
		),
	);
});
