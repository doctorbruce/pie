import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSnapshot, SteerReceipt, TurnReceipt } from "@pie/runtime";
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

test(
	"HTTP steer reports the replaced canonical and SQLite reload retains the handoff",
	{ timeout: 15000 },
	async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-handoff-http-"));
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
		const runtime = await core.ready;
		await runtime.registerHostRuntimes([
			{
				assistantId: "handoff",
				assistantRevision: "1",
				runtime: {
					systemPrompt: "Test",
					toolIds: ["bash"],
					skills: [],
					subagents: [],
					permissions: { "*": "ask" },
				},
			},
		]);
		const session = await runtime.createSession({ assistantId: "handoff", mode: "faux" });
		let requested = () => {};
		const waiting = new Promise<void>((resolve) => {
			requested = resolve;
		});
		await runtime.subscribe(session.id, (packet) => {
			if (packet.type === "interaction.requested") requested();
		});
		const firstInput = {
			text: '调用工具 bash {"command":"must-not-execute"}',
			requestId: "1",
			canonicalTurnId: "canonical-A",
		};
		const response = await post(`/sessions/${session.id}/turns`, firstInput);
		assert.equal(response.status, 202);
		const accepted = (await response.json()) as TurnReceipt;
		await waiting;
		const steering = await post(`/sessions/${session.id}/steer`, {
			turnId: accepted.turnId,
			text: "queued",
			requestId: "2",
			canonicalTurnId: "canonical-B",
		});
		assert.equal(steering.status, 202);
		const receipt = (await steering.json()) as SteerReceipt;
		assert.equal(receipt.turnId, accepted.turnId);
		assert.equal(receipt.canonicalTurnId, "canonical-B");
		assert.equal(receipt.replacesCanonicalTurnId, "canonical-A");
		assert.equal(receipt.durable, false);
		assert.equal(receipt.started, false);
		assert.equal(receipt.applied, false);
		assert.equal(receipt.admission?.status, "queued");
		const retry = await post(`/sessions/${session.id}/turns`, firstInput);
		assert.deepEqual(await retry.json(), accepted);
		const snapshot = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
		assert.equal(snapshot.turn?.canonicalTurnId, "canonical-A");
		assert.equal(snapshot.turn?.replacesCanonicalTurnId, undefined);
		assert.deepEqual(snapshot.turn?.steerAdmissions, [receipt.admission]);
		await runtime.replyInteraction(session.id, snapshot.interactions[0].id, { approved: false });
		const completed = await runtime.waitForTurn(session.id);
		assert.equal(completed.turn?.steerAdmissions?.[0].applied, true);
		assert.equal(completed.turn?.steerAdmissions?.[0].status, "settled");
		await core.close();
		core = createCoreServer({ PI_DATA_DIR: directory });
		base = await listen();
		const restored = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
		assert.equal(restored.turn?.id, accepted.turnId);
		assert.equal(restored.turn?.canonicalTurnId, "canonical-B");
		assert.equal(restored.turn?.rootCanonicalTurnId, "canonical-A");
		assert.equal(restored.turn?.replacesCanonicalTurnId, "canonical-A");
		assert.deepEqual(restored.turn?.steerAdmissions, completed.turn?.steerAdmissions);
	},
);
