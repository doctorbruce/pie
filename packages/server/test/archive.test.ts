import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionSnapshot, SessionSummary } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

test("archive hides sessions before pagination, preserves history across restart, and can be undone", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-archive-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		fetch(`${running.base}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const source = (await (await post("/sessions", { title: "保留历史" })).json()) as SessionSnapshot;
	const other = (await (await post("/sessions", { title: "正常会话" })).json()) as SessionSnapshot;
	const runtime = await running.core.ready;
	await runtime.submitTurn(source.id, { text: "归档前的消息" });
	await runtime.waitForTurn(source.id);
	const before = await runtime.getSession(source.id);
	assert(before.messages.length > 0);
	for (const archived of ["true", 1, null, undefined])
		assert.equal((await post(`/sessions/${source.id}/archive`, { archived })).status, 400);
	assert.equal((await post("/sessions/missing/archive", { archived: true })).status, 404);
	const response = await post(`/sessions/${source.id}/archive`, { archived: true });
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as SessionSnapshot).archived, true);
	assert.equal((await post(`/sessions/${source.id}/archive`, { archived: true })).status, 200);
	const page = await runtime.listSessions({ limit: 1 });
	assert.deepEqual(
		page.sessions.map((session) => session.id),
		[other.id],
	);
	assert.equal(page.nextCursor, null);
	const list = (await (await fetch(`${running.base}/sessions?includeArchived=true`)).json()) as {
		sessions: SessionSummary[];
	};
	assert.equal(list.sessions.length, 2);
	assert.equal(list.sessions.find((session) => session.id === source.id)?.archived, true);
	await running.core.close();
	running = await start(directory);
	const restored = (await (await fetch(`${running.base}/sessions/${source.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.archived, true);
	assert.deepEqual(restored.messages, before.messages);
	const hidden = (await (await fetch(`${running.base}/sessions`)).json()) as { sessions: SessionSummary[] };
	assert.deepEqual(
		hidden.sessions.map((session) => session.id),
		[other.id],
	);
	assert.equal((await post(`/sessions/${source.id}/archive`, { archived: false })).status, 200);
	await running.core.close();
	running = await start(directory);
	const visible = (await (await fetch(`${running.base}/sessions`)).json()) as { sessions: SessionSummary[] };
	assert.equal(visible.sessions.length, 2);
	assert.equal(visible.sessions.find((session) => session.id === source.id)?.archived, false);
});
