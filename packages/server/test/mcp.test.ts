import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpManager, parseMcpServers } from "../src/mcp.ts";
import type { McpServerConfig, SessionSnapshot } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

async function httpFixture() {
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const message = JSON.parse(body) as {
			id?: number;
			method: string;
			params?: { name: string; arguments: { text?: string } };
		};
		if (message.id === undefined) {
			response.writeHead(204).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize")
			result = {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "http-fixture", version: "1" },
			};
		else if (message.method === "tools/list")
			result = {
				tools: ["echo", "fail", "wait", "a-b", "a_b"].map((name) => ({
					name,
					description: `fixture ${name}`,
					inputSchema: { type: "object", properties: { text: { type: "string" } } },
				})),
			};
		else if (message.method === "tools/call") {
			if (message.params?.name === "wait") await sleep(500);
			result = {
				content: [{ type: "text", text: message.params?.arguments.text ?? "FIXTURE_ERROR" }],
				isError: message.params?.name === "fail",
				structuredContent: { source: "fixture" },
			};
		} else result = {};
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

async function settled(
	base: string,
	id: string,
	predicate = (snapshot: SessionSnapshot) => snapshot.turn?.status !== "running",
) {
	for (let attempt = 0; attempt < 300; attempt++) {
		const snapshot = (await (await fetch(`${base}/sessions/${id}`)).json()) as SessionSnapshot;
		if (predicate(snapshot)) return snapshot;
		await sleep(20);
	}
	throw new Error("会话未在时限内完成");
}

test("native Pie MCP executes stdio and HTTP tools, preserves failures and isolates owners", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-mcp-"));
	const http = await httpFixture();
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	context.after(async () => {
		await core.close();
		await http.close();
		await rm(directory, { recursive: true, force: true });
	});
	const request = (method: string, url: string, body: unknown) =>
		fetch(base + url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const mcp = {
		stdio: {
			type: "local",
			command: [
				process.execPath,
				fileURLToPath(new URL("../../mcp/test/fixtures/stdio-server.mjs", import.meta.url)),
			],
			environment: null,
			timeout: null,
			enabled: true,
		},
		http: { type: "remote", url: http.url, headers: null, oauth: null, timeout: null },
	};
	const runtime = { systemPrompt: "", toolIds: [], skills: [], subagents: [], permissions: { "*": "allow" }, mcp };
	assert.equal(
		(
			await request("PUT", "/host-runtimes", {
				runtimes: [
					{ assistantId: "enabled", assistantRevision: "1", runtime },
					{ assistantId: "isolated", assistantRevision: "1", runtime: { ...runtime, mcp: {} } },
				],
			})
		).status,
		200,
	);
	const created = await request("POST", "/sessions", {
		assistantId: "enabled",
		mode: "faux",
		workspacePath: directory,
	});
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	for (const [tool, text, isError] of [
		["mcp__stdio__echo", "STDIO_OK", false],
		["mcp__http__echo", "HTTP_OK", false],
		["mcp__http__fail", "HTTP_FAILURE", true],
	] as const) {
		assert.equal(
			(
				await request("POST", `/sessions/${session.id}/turns`, {
					text: `调用工具 ${tool} ${JSON.stringify({ text })}`,
				})
			).status,
			202,
		);
		const snapshot = await settled(base, session.id);
		const output = snapshot.messages.filter((message) => message.role === "toolResult").at(-1);
		assert(output?.role === "toolResult");
		assert.equal(output.toolName, tool);
		assert.equal(output.isError, isError);
		assert.match(JSON.stringify(output.content), new RegExp(text));
	}
	const status = (await (await fetch(`${base}/mcp`)).json()) as { servers: Record<string, { status: string }> };
	assert.equal(status.servers.stdio.status, "connected");
	assert.equal(status.servers.http.status, "connected");
	const other = (await (
		await request("POST", "/sessions", { assistantId: "isolated", mode: "faux" })
	).json()) as SessionSnapshot;
	await request("POST", `/sessions/${other.id}/turns`, {
		text: '调用工具 mcp__stdio__echo {"text":"FORBIDDEN"}',
	});
	const isolated = await settled(base, other.id);
	assert(isolated.messages.some((message) => message.role === "toolResult" && message.isError));
	assert(
		!isolated.messages.some(
			(message) =>
				message.role === "toolResult" && !message.isError && JSON.stringify(message.content).includes("FORBIDDEN"),
		),
	);
	assert.equal(
		(
			await request("PUT", "/host-runtimes", {
				runtimes: [{ assistantId: "enabled", assistantRevision: "2", runtime: { ...runtime, mcp: {} } }],
			})
		).status,
		200,
	);
	assert.deepEqual(await (await fetch(`${base}/mcp`)).json(), { servers: {} });
	await request("POST", `/sessions/${session.id}/turns`, {
		text: '调用工具 mcp__stdio__echo {"text":"DISABLED"}',
	});
	assert(
		(await settled(base, session.id)).messages.filter((message) => message.role === "toolResult").at(-1)?.isError,
	);
});

test("MCP snapshots retain in-flight clients across refresh, cancel calls and avoid name collisions", async (context) => {
	const http = await httpFixture();
	const manager = new McpManager({});
	context.after(async () => {
		await manager.close();
		await http.close();
	});
	const config: Record<string, McpServerConfig> = { http: { type: "remote", url: http.url, oauth: false } };
	manager.configure([config]);
	const lease = await manager.acquire(config, process.cwd(), async () => {}, undefined, ["mcp__http__a_b"]);
	assert.equal(new Set(lease.tools.map((tool) => tool.name)).size, lease.tools.length);
	assert(lease.tools.every((tool) => tool.name !== "mcp__http__a_b"));
	assert(lease.tools.every((tool) => tool.name.length <= 64));
	manager.configure([]);
	const echo = lease.tools.find((tool) => tool.name === "mcp__http__echo");
	assert(echo);
	assert.match(JSON.stringify((await echo.execute("echo", { text: "IN_FLIGHT" })).content), /IN_FLIGHT/);
	const waiting = lease.tools.find((tool) => tool.name === "mcp__http__wait");
	assert(waiting);
	await assert.rejects(waiting.execute("cancel", {}, AbortSignal.timeout(30)));
	lease.release();
	assert.deepEqual(manager.status().servers, {});
});

test("MCP execution cannot bypass permission denial and rejects invalid transport configs", async (context) => {
	const http = await httpFixture();
	const manager = new McpManager({});
	context.after(async () => {
		await manager.close();
		await http.close();
	});
	const lease = await manager.acquire(
		{ http: { type: "remote", url: http.url, oauth: false } },
		process.cwd(),
		async () => {
			throw new Error("PERMISSION_DENIED");
		},
	);
	await assert.rejects(lease.tools[0].execute("denied", {}), /PERMISSION_DENIED/);
	lease.release();
	assert.throws(() => parseMcpServers({ bad: { type: "sse", url: http.url } }), /legacy SSE/);
	assert.throws(() => parseMcpServers({ bad: { type: "local", command: [] } }), /command/);
	assert.throws(() => parseMcpServers({ bad: { type: "remote", url: "file:///etc/passwd" } }), /HTTP/);
});

test("MCP OAuth completes a loopback callback and restores Core-private credentials", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-mcp-oauth-"));
	let base = "";
	const server = createServer(async (request, response) => {
		const send = (result: unknown, status = 200) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
		};
		if (request.url === "/resource-meta")
			return send({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
		if (request.url?.startsWith("/.well-known/"))
			return send({
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
			});
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		if (request.url === "/register") return send({ client_id: "fixture-client", ...JSON.parse(body) }, 201);
		if (request.url === "/token")
			return send({
				access_token: "fixture-access-token",
				refresh_token: "fixture-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			});
		if (request.url !== "/mcp") return send({}, 404);
		if (request.headers.authorization !== "Bearer fixture-access-token") {
			response.setHeader("www-authenticate", `Bearer resource_metadata="${base}/resource-meta"`);
			return send({}, 401);
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = JSON.parse(body) as { id?: number; method: string };
		if (message.id === undefined) {
			response.writeHead(204).end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "oauth", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: "OAUTH_OK" }] };
		return send({ jsonrpc: "2.0", id: message.id, result });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	base = `http://127.0.0.1:${address.port}`;
	const manager = new McpManager({ PI_DATA_DIR: directory });
	const restored = new McpManager({ PI_DATA_DIR: directory });
	context.after(async () => {
		await manager.close();
		await restored.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	const config: Record<string, McpServerConfig> = { oauth: { type: "remote", url: `${base}/mcp` } };
	manager.configure([config]);
	let authorizationUrl: string | undefined;
	for (let attempt = 0; attempt < 300; attempt++) {
		const status = manager.status().servers.oauth;
		if (status.status === "needs_auth") {
			authorizationUrl = status.authorizationUrl as string;
			break;
		}
		await sleep(20);
	}
	assert(authorizationUrl, JSON.stringify(manager.status()));
	const authorization = new URL(authorizationUrl);
	const callback = new URL(authorization.searchParams.get("redirect_uri")!);
	callback.searchParams.set("state", authorization.searchParams.get("state")!);
	callback.searchParams.set("code", "fixture-code");
	callback.searchParams.set("iss", base);
	assert.equal((await fetch(callback)).status, 200);
	for (let attempt = 0; attempt < 300 && manager.status().servers.oauth.status !== "connected"; attempt++)
		await sleep(20);
	assert.equal(manager.status().servers.oauth.status, "connected", JSON.stringify(manager.status()));
	const lease = await manager.acquire(config, directory, async () => {});
	assert.match(JSON.stringify((await lease.tools[0].execute("oauth", {})).content), /OAUTH_OK/);
	lease.release();
	assert(!JSON.stringify(manager.status()).includes("fixture-access-token"));
	await manager.close();
	restored.configure([config]);
	const recovered = await restored.acquire(config, directory, async () => {});
	assert.equal(recovered.tools.length, 1);
	assert.equal(restored.status().servers.oauth.status, "connected");
	assert.equal(restored.status().servers.oauth.authorizationUrl, undefined);
	recovered.release();
});
