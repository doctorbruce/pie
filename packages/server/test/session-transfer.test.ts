import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSnapshot, SessionTransfer } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

async function jsonRequest(base: string, path: string, method: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

test("session transfer overwrites a Pie replica, survives restart, and remains usable", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-transfer-test-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});

	const createdResponse = await jsonRequest(running.base, "/sessions", "POST", {
		assistantId: "astron-assistant",
		assistantRevision: "7",
		runtime: { systemPrompt: "Answer directly.", toolIds: [], skills: [], subagents: [] },
	});
	assert.equal(createdResponse.status, 201);
	const created = (await createdResponse.json()) as SessionSnapshot;
	const transcript: SessionTransfer["transcript"] = [
		{
			id: "message-user",
			role: "user",
			content: [{ id: "part-user", type: "text", text: "read the project" }],
			createdAt: 100,
		},
		{
			id: "message-assistant",
			role: "assistant",
			content: [
				{ id: "part-thought", type: "thought", text: "I should inspect it." },
				{
					id: "part-tool",
					type: "tool",
					tool: "read",
					callID: "call-1",
					state: { status: "completed", input: { path: "README.md" }, output: "project readme" },
				},
				{ id: "part-text", type: "text", text: "The project is ready." },
			],
			createdAt: 200,
		},
	];
	const transfer: SessionTransfer = {
		schemaVersion: 1,
		source: { astronSessionId: "astron-session", coreId: "opencode", sessionId: "opencode-session" },
		title: "Migrated conversation",
		transcript,
		createdAt: 100,
		updatedAt: 200,
	};
	const importedResponse = await jsonRequest(running.base, `/sessions/${created.id}/import`, "PUT", transfer);
	assert.equal(importedResponse.status, 200);
	const imported = (await importedResponse.json()) as { transfer: SessionTransfer };
	assert.deepEqual(imported.transfer.transcript, transcript);

	await running.core.close();
	running = await start(directory);
	const exportedResponse = await fetch(`${running.base}/sessions/${created.id}/export`);
	assert.equal(exportedResponse.status, 200);
	const exported = (await exportedResponse.json()) as SessionTransfer;
	assert.deepEqual(exported.transcript, transcript);
	assert.equal(exported.source.astronSessionId, "astron-session");
	assert.equal(exported.source.coreId, "pie");
	assert.equal(exported.source.sessionId, created.id);
	assert.equal(exported.title, "Migrated conversation");

	const turnResponse = await jsonRequest(running.base, `/sessions/${created.id}/turns`, "POST", {
		text: "continue here",
	});
	assert.equal(turnResponse.status, 202);
	let snapshot: SessionSnapshot | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		snapshot = (await (await fetch(`${running.base}/sessions/${created.id}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") break;
	}
	assert.equal(snapshot?.turn?.status, "completed");
	const continued = (await (await fetch(`${running.base}/sessions/${created.id}/export`)).json()) as SessionTransfer;
	assert.deepEqual(continued.transcript.slice(0, transcript.length), transcript);
	assert.deepEqual(
		continued.transcript.slice(transcript.length).map((message) => message.role),
		["user", "assistant"],
	);
});
