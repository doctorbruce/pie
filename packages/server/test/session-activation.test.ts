import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionSummary } from "@pie/runtime/protocol";
import type { SavedSession } from "@pie/runtime/runtime-store";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

test("SQLite metadata queries page tied timestamps and filter unloaded sessions without a startup snapshot", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-query-"));
	const environment = { PI_DATA_DIR: directory };
	let local = openStore(environment);
	context.after(async () => {
		local.close();
		await rm(directory, { recursive: true, force: true });
	});
	const assistantId = local.assistants[0].id;
	for (let index = 0; index < 260; index++) {
		local.saveSession({
			id: `session-${index.toString().padStart(4, "0")}`,
			kind: index % 3 ? "root" : "subagent",
			parentSessionId: index % 3 ? undefined : "parent",
			assistantId: index % 2 ? "other" : assistantId,
			runtimeSource: "local",
			title: "cold",
			mode: "faux",
			model: "faux",
			createdAt: 1,
			updatedAt: 10,
			revision: 1,
			messages: [],
		});
	}
	local.close();
	local = openStore(environment);
	const store = createSqliteRuntimeStore(local);
	assert.equal(Object.getOwnPropertyDescriptor(local, "sessions")?.value, undefined);
	const ids: string[] = [];
	let page = await store.listSessions({ limit: 37 });
	while (true) {
		assert(page.sessions.length <= 37);
		ids.push(...page.sessions.map((session) => session.id));
		if (!page.nextCursor) break;
		page = await store.listSessions({ limit: 37, cursor: page.nextCursor });
	}
	assert.equal(ids.length, 260);
	assert.equal(new Set(ids).size, 260);
	assert.deepEqual(ids, [...ids].sort().reverse());
	const children = await store.listSessions({ limit: 200, parentSessionId: "parent", kind: "subagent" });
	assert.equal(children.sessions.length, 87);
	const roots = await store.listSessions({ limit: 200, assistantId, kind: "root" });
	assert.equal(roots.sessions.length, 86);
	assert(roots.sessions.every((session) => session.assistantId === assistantId && session.kind === "root"));
	assert.equal(await store.readSession("absent"), undefined);
	const session = (await store.readSession(ids[0]))!;
	assert.equal(session.id, ids[0]);
	assert(!("messages" in session));
	assert(!("tree" in session));
	assert(!("transferBase" in session));
	const updated: SavedSession = { ...session, updatedAt: 11, title: "changed", messages: [] };
	await store.saveSession(updated);
	assert.equal((await store.readSession(session.id))?.title, "changed");
	assert.equal((await store.listSessions({ limit: 1 })).sessions[0].updatedAt, 11);
});

test("SQLite startup recovery uses its durable recovery index and clears repaired work", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-recovery-index-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const environment = { PI_DATA_DIR: directory };
	let store = openStore(environment);
	store.saveSession({
		id: "running",
		kind: "root",
		assistantId: store.assistants[0].id,
		runtimeSource: "local",
		title: "running",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		messages: [],
		turn: { id: "turn", status: "running" },
	});
	store.close();
	const database = new DatabaseSync(join(directory, "agent.sqlite"));
	try {
		assert.equal(
			database.prepare("SELECT needs_recovery FROM sessions WHERE id = 'running'").get()!.needs_recovery,
			1,
		);
		const plans = database.prepare("EXPLAIN QUERY PLAN SELECT payload FROM sessions WHERE needs_recovery = 1").all();
		assert(plans.some((row) => String(row.detail).includes("sessions_recovery")));
		const legacyPlans = database
			.prepare("EXPLAIN QUERY PLAN SELECT payload FROM sessions WHERE json_type(payload, '$.messages') = 'array'")
			.all();
		assert(legacyPlans.some((row) => String(row.detail).includes("sessions_legacy")));
	} finally {
		database.close();
	}
	store = openStore(environment);
	assert.equal(store.readSession("running")?.turn?.status, "failed");
	const revision = store.readSession("running")!.revision;
	store.close();
	store = openStore(environment);
	try {
		assert.equal(store.readSession("running")!.revision, revision);
	} finally {
		store.close();
	}
});

test("local HTTP keeps its complete session list and checks assistant references in unloaded sessions", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-local-"));
	const environment = { PI_DATA_DIR: directory, PI_TOOLS_DIR: directory };
	const store = openStore(environment);
	const assistant = store.assistants[0];
	store.saveAssistant({ ...assistant, id: "other", name: "other" });
	for (let index = 0; index < 230; index++) {
		store.saveSession({
			id: `root-${index.toString().padStart(4, "0")}`,
			kind: "root",
			assistantId: index ? assistant.id : "other",
			runtimeSource: "local",
			title: "cold",
			mode: "faux",
			model: "faux",
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			messages: [],
		});
	}
	store.close();
	const core = createCoreServer(environment);
	context.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	await core.ready;
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	assert.equal((await fetch(`${base}/health`)).status, 200);
	const listed = await fetch(`${base}/sessions`);
	assert.equal(listed.status, 200);
	const body = (await listed.json()) as { sessions: SessionSummary[] };
	assert.deepEqual(Object.keys(body), ["sessions"]);
	assert.equal(body.sessions.length, 230);
	assert.equal((await fetch(`${base}/assistants/other`, { method: "DELETE" })).status, 409);
	const deleted = await fetch(`${base}/sessions/root-0000`, { method: "DELETE" });
	assert.equal(deleted.status, 200);
	assert.equal((await fetch(`${base}/assistants/other`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${base}/sessions/root-0001?limit=1`)).status, 200);
	assert.equal((await fetch(`${base}/sessions/missing`)).status, 404);
});
