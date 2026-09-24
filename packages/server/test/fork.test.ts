import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { SessionForkResult, SessionSnapshot } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

async function post(base: string, path: string, body: unknown) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function submit(base: string, sessionId: string, text: string) {
	assert.equal((await post(base, `/sessions/${sessionId}/turns`, { text })).status, 202);
	for (let attempt = 0; attempt < 200; attempt++) {
		const snapshot = (await (await fetch(`${base}/sessions/${sessionId}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") return snapshot;
		await setTimeout(10);
	}
	throw new Error("turn did not settle");
}

test("fork creates an independent session before the selected user message and restores it after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-fork-test-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});

	const created = await post(running.base, "/sessions", {
		title: "原会话",
	});
	assert.equal(created.status, 201);
	const source = (await created.json()) as SessionSnapshot;
	await submit(running.base, source.id, "第一条消息");
	const sourceAfterSecond = await submit(running.base, source.id, "第二条消息");
	assert.deepEqual(
		sourceAfterSecond.messages.map((message) => message.role),
		["user", "assistant", "user", "assistant"],
	);

	const response = await post(running.base, `/sessions/${source.id}/fork`, { messageIndex: 2 });
	assert.equal(response.status, 201);
	const result = (await response.json()) as SessionForkResult;
	assert.equal(result.selectedText, "第二条消息");
	assert.equal(result.session.forkedFromSessionId, source.id);
	assert.equal(result.session.title, "原会话（分支）");
	assert.equal(result.session.turn, undefined);
	assert.deepEqual(result.session.messages, sourceAfterSecond.messages.slice(0, 2));
	assert.deepEqual(result.session.runtime, sourceAfterSecond.runtime);

	assert.equal((await post(running.base, `/sessions/${source.id}/fork`, { messageIndex: 1 })).status, 400);
	const forkAfterTurn = await submit(running.base, result.session.id, "修改后的第二条消息");
	assert.equal(forkAfterTurn.messages.length, 4);
	assert.equal(
		((await (await fetch(`${running.base}/sessions/${source.id}`)).json()) as SessionSnapshot).messages.length,
		4,
	);

	await running.core.close();
	running = await start(directory);
	const restored = (await (await fetch(`${running.base}/sessions/${result.session.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.forkedFromSessionId, source.id);
	assert.equal(restored.messages.length, 4);
	assert.equal((await fetch(`${running.base}/sessions/${source.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${running.base}/sessions/${result.session.id}`)).status, 200);
});
