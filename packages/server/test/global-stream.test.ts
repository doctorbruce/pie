import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentFactory } from "@pie/local";
import { createRuntime, type SessionEvent } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

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
	const fullPackets: SessionEvent[] = [];
	runtime.subscribe(session.id, (packet) => fullPackets.push(packet));
	await runtime.submitTurn(session.id, { text: "hello again" });
	const completed = await runtime.waitForTurn(session.id);
	assert.equal(completed.turn?.status, "completed");
	const settled = fullPackets.find((packet) => packet.type === "turn.settled");
	assert(settled);
	assert.deepEqual(settled.snapshot.messages, completed.messages);
	assert(
		settled.snapshot.messages.some(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "image"),
		),
	);
});
