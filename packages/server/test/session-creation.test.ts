import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentFactory, createSqliteRuntimeStore, openStore } from "@pie/local";
import { createRuntime, type SavedSession, type SessionCreationRecord } from "@pie/runtime";
import type { SessionCreationReceipt, SessionSnapshot, SessionSummary } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	return {
		...core,
		request: (path: string, method = "GET", body?: unknown) =>
			fetch(`${base}${path}`, {
				method,
				...(body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			}),
	};
}

test("HTTP creation retries share one session; ordinary creates and distinct keys stay independent", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	const core = await start(directory);
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const body = { creationKey: "worker/session A", title: "合同甲" };
	const responses = await Promise.all(Array.from({ length: 8 }, () => core.request("/sessions", "POST", body)));
	const sessions: SessionSnapshot[] = [];
	for (const response of responses) {
		assert.equal(response.status, 201);
		sessions.push((await response.json()) as SessionSnapshot);
	}
	assert.equal(new Set(sessions.map((session) => session.id)).size, 1);
	const retry = await core.request("/sessions", "POST", {
		...body,
		creationKey: ` ${body.creationKey} `,
		title: " 合同甲 ",
	});
	assert.equal(retry.status, 201);
	assert.equal(((await retry.json()) as SessionSnapshot).id, sessions[0].id);
	const receipt = await core.request(`/session-creations?creationKey=${encodeURIComponent(body.creationKey)}`);
	assert.equal(receipt.status, 200);
	assert.deepEqual(await receipt.json(), {
		creationKey: body.creationKey,
		sessionId: sessions[0].id,
		createdAt: sessions[0].createdAt,
		sessionExists: true,
	});
	for (const input of [{ ...body, creationKey: "worker/session B" }, { title: body.title }, { title: body.title }]) {
		const response = await core.request("/sessions", "POST", input);
		assert.equal(response.status, 201);
		assert.notEqual(((await response.json()) as SessionSnapshot).id, sessions[0].id);
	}
	const listed = (await (await core.request("/sessions")).json()) as { sessions: SessionSummary[] };
	assert.equal(listed.sessions.length, 4);
});

test("conflicting or invalid creation keys do not create sessions or disable subsequent writes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	const core = await start(directory);
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const body = { creationKey: "request-1", title: "original" };
	assert.equal((await core.request("/sessions", "POST", body)).status, 201);
	for (const change of [
		{ title: "different" },
		{ workspacePath: "other" },
		{ assistantId: "missing" },
		{ mode: "real" },
		{ model: { provider: "other", id: "other" } },
	]) {
		assert.equal((await core.request("/sessions", "POST", { ...body, ...change })).status, 409);
	}
	for (const creationKey of [null, 1, "", " ", "x".repeat(257), "bad\0key"]) {
		assert.equal((await core.request("/sessions", "POST", { creationKey })).status, 400);
	}
	assert.equal((await core.request("/session-creations")).status, 400);
	assert.equal((await core.request("/session-creations?creationKey=absent")).status, 404);
	assert.equal((await core.request("/sessions", "POST", { creationKey: "valid-next" })).status, 201);
	const listed = (await (await core.request("/sessions")).json()) as { sessions: SessionSummary[] };
	assert.equal(listed.sessions.length, 2);
});

test("creation identity survives restart and assistant removal; deleted sessions cannot be recreated by late retries", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	let core = await start(directory);
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	assert.equal(
		(
			await core.request("/host-runtimes", "PUT", {
				runtimes: [
					{
						assistantId: "worker",
						assistantRevision: "1",
						runtime: { systemPrompt: "", toolIds: [], skills: [], subagents: [] },
					},
				],
			})
		).status,
		200,
	);
	const body = { creationKey: "work-item/session", assistantId: "worker" };
	const original = (await (await core.request("/sessions", "POST", body)).json()) as SessionSnapshot;
	assert(original.id);
	assert.equal((await core.request(`/sessions/${original.id}`, "PATCH", { title: "updated" })).status, 200);
	assert.equal((await core.request("/host-runtimes", "PUT", { runtimes: [] })).status, 200);
	await core.close();
	core = await start(directory);
	const retried = await core.request("/sessions", "POST", body);
	assert.equal(retried.status, 201);
	const session = (await retried.json()) as SessionSnapshot;
	assert.equal(session.id, original.id);
	assert.equal(session.title, "updated");
	assert.equal((await core.request(`/sessions/${original.id}`, "DELETE")).status, 200);
	await core.close();
	core = await start(directory);
	const receipt = await core.request(`/session-creations?creationKey=${encodeURIComponent(body.creationKey)}`);
	assert.equal(receipt.status, 200);
	const creation = (await receipt.json()) as SessionCreationReceipt;
	assert.equal(creation.sessionId, original.id);
	assert.equal(creation.sessionExists, false);
	assert.equal((await core.request("/sessions", "POST", body)).status, 409);
});

test("SQLite rolls back both creation identity and session/history when their atomic save fails", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	const store = openStore({ PI_DATA_DIR: directory });
	t.after(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session: SavedSession = {
		id: "first",
		kind: "root",
		assistantId: "worker",
		runtimeSource: "host",
		title: "first",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 0,
		messages: [],
	};
	const creation: SessionCreationRecord = {
		creationKey: "key",
		sessionId: session.id,
		requestFingerprint: "fingerprint",
		createdAt: 1,
	};
	store.saveSession(session, false, [], { creation });
	assert.throws(() =>
		store.saveSession(
			{ ...session, id: "second", messages: [{ role: "user", content: "rollback", timestamp: 1 }] },
			false,
			[],
			{
				creation: { ...creation, sessionId: "second" },
			},
		),
	);
	assert.equal(store.readSession("second"), undefined);
	store.saveSession({ ...session, id: "second" });
	assert.equal(store.readTree("second").nodes.length, 0);
	assert.deepEqual(store.readSessionCreation("key"), creation);
	assert.throws(() =>
		store.saveSession({ ...session, id: "third" }, false, [], {
			creation: { ...creation, creationKey: "unused", sessionId: "wrong" },
		}),
	);
	assert.equal(store.readSession("third"), undefined);
	assert.equal(store.readSessionCreation("unused"), undefined);
});

test("stores without atomic creation support reject keys while ordinary creates still work", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	const store = openStore({ PI_DATA_DIR: directory });
	const runtime = await createRuntime({
		store: { ...createSqliteRuntimeStore(store), readSessionCreation: undefined },
		agents: createAgentFactory({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" }),
		assistants: {
			list: () => store.assistants,
			runtime: (assistant) => ({ systemPrompt: assistant.systemPrompt, toolIds: [], skills: [], subagents: [] }),
		},
	});
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	await assert.rejects(runtime.createSession({ creationKey: "key" }), { status: 405 });
	await assert.rejects(runtime.getSessionCreation("key"), { status: 405 });
	assert((await runtime.createSession({})).id);
});

test("a lost save response can be reconciled by creation key without another session", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-creation-"));
	let store = openStore({ PI_DATA_DIR: directory });
	const atomicStore = createSqliteRuntimeStore(store);
	const runtime = await createRuntime({
		store: {
			...atomicStore,
			async saveSession(...args) {
				const metadata = await atomicStore.saveSession(...args);
				if (args[3]?.creation) throw new Error("lost response after commit");
				return metadata;
			},
		},
		agents: createAgentFactory({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" }),
		assistants: {
			list: () => store.assistants,
			runtime: (assistant) => ({ systemPrompt: assistant.systemPrompt, toolIds: [], skills: [], subagents: [] }),
		},
	});
	let restarted: Awaited<ReturnType<typeof createRuntime>> | undefined;
	t.after(async () => {
		await (restarted ?? runtime).close();
		await rm(directory, { recursive: true, force: true });
	});
	await assert.rejects(runtime.createSession({ creationKey: "lost" }), { status: 503 });
	const receipt = await runtime.getSessionCreation("lost");
	assert.equal(receipt.sessionExists, true);
	await runtime.close();
	store = openStore({ PI_DATA_DIR: directory });
	restarted = await createRuntime({
		store: createSqliteRuntimeStore(store),
		agents: createAgentFactory({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" }),
		assistants: {
			list: () => store.assistants,
			runtime: (assistant) => ({ systemPrompt: assistant.systemPrompt, toolIds: [], skills: [], subagents: [] }),
		},
	});
	assert.equal((await restarted.createSession({ creationKey: "lost" })).id, receipt.sessionId);
	assert.equal(store.sessions.length, 1);
});
