import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Script } from "node:vm";
import { createPromptViewer, localCoreUrl } from "../server.mjs";

async function listen(server, context) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	context.after(() => new Promise((done) => {
		server.close(done);
		server.closeAllConnections();
	}));
	return `http://127.0.0.1:${server.address().port}`;
}

function directory(context) {
	const path = mkdtempSync(join(tmpdir(), "pie-prompt-viewer-"));
	context.after(() => {
		assert.equal(dirname(path), resolve(tmpdir()));
		rmSync(path, { recursive: true, force: true });
	});
	return path;
}

test("only accepts local Core origins, without credentials or paths", () => {
	assert.equal(localCoreUrl("http://127.0.0.1:4318/"), "http://127.0.0.1:4318");
	for (const value of [
		"https://127.0.0.1:4318",
		"http://localhost:4318",
		"http://example.com:4318",
		"http://127.0.0.1:4318/sessions",
		"http://user:secret@127.0.0.1:4318",
		"http://127.0.0.1:4318/?token=secret",
		"http://127.0.0.1:4318/#secret",
	]) assert.throws(() => localCoreUrl(value));
});

test("HTML script parses and serves with local-only security headers", async (context) => {
	const url = await listen(createPromptViewer({ coreUrl: "http://127.0.0.1:4318" }), context);
	const response = await fetch(url);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
	const html = await response.text();
	assert.match(html, /用户 Prompt/);
	new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
	assert.equal((await fetch(`${url}/api/source`, { headers: { Origin: "https://example.com" } })).status, 403);
	const forgedHost = await new Promise((done, reject) => {
		const req = request(`${url}/api/source`, { headers: { Host: "example.com" } }, (res) => {
			res.resume();
			done(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(forgedHost, 403);
	assert.equal((await fetch(`${url}/api/sessions`, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${url}/api/sessions/id/turns`)).status, 404);
});

test("proxies only session reads, carries auth without exposing it, and includes subagents", async (context) => {
	const requests = [];
	const core = createServer((req, res) => {
		requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, origin: req.headers.origin });
		res.setHeader("Content-Type", "application/json");
		if (req.headers.authorization !== "Bearer fake-token") {
			res.writeHead(401);
			return res.end(JSON.stringify({ error: "认证失败" }));
		}
		res.end(JSON.stringify(req.url.startsWith("/sessions?") ? { sessions: [{ id: "session-1", kind: "subagent" }] } : { id: "session-1", messages: [{ role: "user", content: "你好" }] }));
	});
	const coreUrl = await listen(core, context);
	const url = await listen(createPromptViewer({ coreUrl, token: "fake-token" }), context);
	assert.deepEqual(await (await fetch(`${url}/api/source`)).json(), { mode: "live", url: coreUrl });
	assert.equal((await (await fetch(`${url}/api/sessions`)).json()).sessions[0].kind, "subagent");
	assert.equal((await (await fetch(`${url}/api/sessions/session-1`)).json()).messages[0].content, "你好");
	assert.equal((await fetch(`${url}/api/sessions`, { headers: { "X-Pie-Token": "wrong-token" } })).status, 401);
	const count = requests.length;
	assert.equal((await fetch(`${url}/api/sessions?core=https://example.com`)).status, 400);
	assert.equal(requests.length, count);
	assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET"]);
	assert.equal(requests[0].path, "/sessions?includeSubagents=true");
	assert.equal(requests[0].origin, undefined);
});

test("database mode returns sorted snapshots without modifying SQLite or creating a missing database", async (context) => {
	const dataDir = directory(context);
	const dbPath = join(dataDir, "agent.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
	const snapshots = [
		{ id: "old", updatedAt: 1, messages: [{ role: "user", content: "旧输入" }], runtime: { systemPrompt: "系统指令" } },
		{ id: "new", updatedAt: 2, messages: [{ role: "user", content: "新输入" }] },
	];
	for (const session of snapshots) db.prepare("INSERT INTO sessions VALUES (?, ?)").run(session.id, JSON.stringify(session));
	db.close();
	const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
	const url = await listen(createPromptViewer({ dataDir }), context);
	const summaries = (await (await fetch(`${url}/api/sessions`)).json()).sessions;
	assert.deepEqual(summaries.map((session) => session.id), ["new", "old"]);
	assert.equal(summaries[1].messages, undefined);
	assert.equal(summaries[1].runtime, undefined);
	assert.deepEqual(await (await fetch(`${url}/api/sessions/old`)).json(), snapshots[0]);
	assert.equal((await fetch(`${url}/api/sessions/missing`)).status, 404);
	assert.equal(createHash("sha256").update(readFileSync(dbPath)).digest("hex"), before);
	const missingDir = directory(context);
	const missing = await listen(createPromptViewer({ dataDir: missingDir }), context);
	assert.equal((await fetch(`${missing}/api/sessions`)).status, 503);
	assert.equal(existsSync(join(missingDir, "agent.sqlite")), false);
});

test("locked database reports the online alternative without changing the Core lock", async (context) => {
	const dataDir = directory(context);
	const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
	try {
		db.exec("CREATE TABLE sessions (id TEXT, payload TEXT); PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
		const url = await listen(createPromptViewer({ dataDir }), context);
		const response = await fetch(`${url}/api/sessions`);
		assert.equal(response.status, 503);
		assert.match((await response.json()).error, /在线模式/);
		assert.equal(db.prepare("PRAGMA locking_mode").get().locking_mode, "exclusive");
	} finally {
		db.close();
	}
});

test("request records are complete, ordered and isolated, with no database writes or temporary files exposed", async (context) => {
	const dataDir = directory(context);
	const sessionId = "session/with spaces";
	const requestsDir = join(dataDir, "custom-requests");
	const sessionDir = join(requestsDir, createHash("sha256").update(sessionId).digest("hex"));
	mkdirSync(sessionDir, { recursive: true });
	const first = { schemaVersion: 1, sessionId, id: "1791936000000-12345678-1234-1234-1234-123456789abc", createdAt: 1791936000000, purpose: "turn", provider: "fixture", model: "fixture-model", api: "openai-completions", payload: { messages: [{ role: "user", content: "x".repeat(1024 * 1024) }], tools: [{ name: "read" }] } };
	const second = { ...first, id: "1791936000001-12345678-1234-1234-1234-123456789abc", createdAt: 1791936000001, purpose: "compaction", payload: { messages: ["summary"] } };
	const invalid = { ...first, id: "1791936000002-12345678-1234-1234-1234-123456789abc", sessionId: "other-session" };
	for (const record of [second, first, invalid]) writeFileSync(join(sessionDir, `${record.id}.json`), JSON.stringify(record));
	writeFileSync(join(sessionDir, `${first.id}.json.tmp`), "incomplete");
	const before = createHash("sha256").update(readFileSync(join(sessionDir, `${first.id}.json`))).digest("hex");
	const url = await listen(createPromptViewer({ dataDir, requestsDir }), context);
	const base = `${url}/api/sessions/${encodeURIComponent(sessionId)}/requests`;
	const listing = await (await fetch(base)).json();
	assert.deepEqual(listing.requests.map((record) => record.id), [first.id, second.id, invalid.id]);
	assert.equal(listing.requests[0].payload, undefined);
	assert.equal(listing.requests[0].bytes, Buffer.byteLength(JSON.stringify(first)));
	assert.deepEqual(await (await fetch(`${base}/${first.id}`)).json(), first);
	assert.deepEqual(await (await fetch(`${base}/${second.id}`)).json(), second);
	assert.equal((await fetch(`${base}/${invalid.id}`)).status, 422);
	assert.equal((await fetch(`${base}/invalid`)).status, 400);
	assert.equal((await fetch(`${base}/..%2Fprivate`)).status, 400);
	assert.equal((await fetch(`${base}/1791936000003-12345678-1234-1234-1234-123456789abc`)).status, 404);
	assert.deepEqual((await (await fetch(`${url}/api/sessions/other-session/requests`)).json()).requests, []);
	assert.equal(existsSync(join(dataDir, "agent.sqlite")), false);
	assert.equal(createHash("sha256").update(readFileSync(join(sessionDir, `${first.id}.json`))).digest("hex"), before);
});

test("live request reads require authorization against the selected Core before accessing local records", async (context) => {
	const requestsDir = directory(context);
	const sessionId = "protected-session";
	const id = "1791936000000-12345678-1234-1234-1234-123456789abc";
	const sessionDir = join(requestsDir, createHash("sha256").update(sessionId).digest("hex"));
	mkdirSync(sessionDir);
	writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, sessionId, payload: { messages: ["private prompt"] } }));
	const core = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.headers.authorization !== "Bearer request-token") {
			res.writeHead(401);
			return res.end(JSON.stringify({ error: "认证失败" }));
		}
		assert.equal(req.method, "GET");
		assert.equal(req.url, `/sessions/${sessionId}`);
		res.end(JSON.stringify({ id: sessionId }));
	});
	const coreUrl = await listen(core, context);
	const url = await listen(createPromptViewer({ coreUrl, requestsDir, token: "request-token" }), context);
	const base = `${url}/api/sessions/${sessionId}/requests`;
	const denied = await fetch(`${base}/${id}`, { headers: { "X-Pie-Token": "wrong-token" } });
	assert.equal(denied.status, 401);
	assert.equal((await denied.text()).includes("private prompt"), false);
	const record = await (await fetch(`${base}/${id}`)).text();
	assert.equal(record.includes("private prompt"), true);
	assert.equal(record.includes("request-token"), false);
	assert.equal((await fetch(base)).status, 200);
});
