import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSnapshot, TurnReceipt } from "@pie/runtime";
import { createCoreServer } from "../src/server.ts";

test("HTTP canonical identity survives SQLite reload and rejects conflicting request bindings", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-canonical-http-"));
	let core = createCoreServer({ PI_DATA_DIR: directory });
	context.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	async function listen() {
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let base = await listen();
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const session = (await (await post("/sessions", { mode: "faux" })).json()) as SessionSnapshot;
	const path = `/sessions/${session.id}/turns`;
	const firstInput = { text: "first", requestId: "1", canonicalTurnId: "canonical-A" };
	const firstResponse = await post(path, firstInput);
	assert.equal(firstResponse.status, 202);
	const first = (await firstResponse.json()) as TurnReceipt;
	await (await core.ready).waitForTurn(session.id);
	const nextInput = { text: "next", requestId: "1", canonicalTurnId: " canonical-B " };
	const nextResponse = await post(path, nextInput);
	assert.equal(nextResponse.status, 202);
	const next = (await nextResponse.json()) as TurnReceipt;
	assert.notEqual(next.turnId, first.turnId);
	assert.equal(next.canonicalTurnId, nextInput.canonicalTurnId);
	await (await core.ready).waitForTurn(session.id);
	await core.close();
	core = createCoreServer({ PI_DATA_DIR: directory });
	base = await listen();
	const restored = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.turn?.canonicalTurnId, nextInput.canonicalTurnId);
	assert.equal(restored.turn?.rootCanonicalTurnId, nextInput.canonicalTurnId);
	const retried = await post(path, nextInput);
	assert.equal(retried.status, 202);
	assert.deepEqual(await retried.json(), { ...next, started: false, settled: true });
	assert.equal((await post(path, { ...nextInput, requestId: "2" })).status, 409);
	for (const canonicalTurnId of ["", " ", "x".repeat(257), 1, null])
		assert.equal((await post(path, { ...nextInput, canonicalTurnId })).status, 400);
	const unchanged = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.equal(unchanged.turn?.id, next.turnId);
	assert.equal(unchanged.messages.filter((message) => message.role === "user").length, 2);
});
