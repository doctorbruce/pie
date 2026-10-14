import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const html = readFileSync(new URL("./index.html", import.meta.url));

export function localCoreUrl(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Core 地址必须是 http://127.0.0.1:<端口>，不能包含路径或凭据");
	return url.origin;
}

async function discoverCoreUrl() {
	if (process.platform === "win32") {
		const { stdout } = await run(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='pie-agent.exe'\" | Select-Object -ExpandProperty CommandLine",
			],
			{ windowsHide: true, timeout: 5000 },
		);
		const ports = [...stdout.matchAll(/--port(?:=|\s+)(\d+)\b/g)].map((match) => match[1]);
		if (ports.length > 1) throw new Error("发现多个 Pie Core，请用 --core-url 明确选择");
		if (ports.length === 1) return localCoreUrl(`http://127.0.0.1:${ports[0]}`);
	}
	return "http://127.0.0.1:4318";
}

function modelRequestRoots(dataDir, requestsDir) {
	if (requestsDir) return [resolve(requestsDir)];
	if (dataDir) return [resolve(dataDir, "model-requests")];
	const roots = [resolve(process.env.PI_DATA_DIR || ".pie", "model-requests")];
	if (process.platform === "win32" && process.env.APPDATA) {
		const users = join(process.env.APPDATA, "astron-cowork", "pie-agent", "users");
		if (existsSync(users)) {
			for (const user of readdirSync(users, { withFileTypes: true })) {
				if (user.isDirectory()) roots.push(join(users, user.name, "cores", "pie", "data", "model-requests"));
			}
		}
	}
	return [...new Set(roots)];
}

export function createPromptViewer({ coreUrl, token = "", dataDir, requestsDir } = {}) {
	const fixedUrl = coreUrl ? localCoreUrl(coreUrl) : undefined;
	const dbPath = dataDir ? join(resolve(dataDir), "agent.sqlite") : undefined;
	let discoveredUrl;
	const coreTarget = async (url) => {
		const selected = url.searchParams.get("core");
		return selected ? localCoreUrl(selected) : (fixedUrl ?? (discoveredUrl ??= await discoverCoreUrl()));
	};
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");
		const json = (status, body) => {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(body));
		};
		void (async () => {
			const address = server.address();
			const host = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
			if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`))
				return json(403, { error: "只接受本地页面访问" });
			if (req.method !== "GET") return json(405, { error: "查看器只允许 GET，不会修改会话" });
			const url = new URL(req.url ?? "/", `http://${host}`);
			if (url.pathname === "/" || url.pathname === "/index.html") {
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy":
						"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
				});
				return res.end(html);
			}
			const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
			const requestMatch = /^\/api\/sessions\/([^/]+)\/requests(?:\/([^/]+))?$/.exec(url.pathname);
			if (url.pathname !== "/api/source" && url.pathname !== "/api/sessions" && !detail && !requestMatch)
				return json(404, { error: "不存在的只读接口" });
			if (requestMatch) {
				const sessionId = decodeURIComponent(requestMatch[1]);
				if (!dbPath) {
					const target = await coreTarget(url);
					const credential = req.headers["x-pie-token"] || token;
					const response = await fetch(`${target}/sessions/${encodeURIComponent(sessionId)}`, {
						headers: credential ? { Authorization: `Bearer ${credential}` } : {},
						redirect: "error",
						signal: AbortSignal.timeout(10000),
					});
					if (!response.ok) return json(response.status, await response.json());
					await response.body?.cancel();
				}
				const sessionKey = createHash("sha256").update(sessionId).digest("hex");
				const directories = modelRequestRoots(dataDir, requestsDir)
					.map((root) => join(root, sessionKey))
					.filter((directory) => existsSync(directory));
				if (directories.length > 1)
					return json(409, { error: "多个数据目录包含此会话的请求记录，请用 --requests-dir 明确选择，不能混合不同 Core 的记录。" });
				const directory = directories[0];
				const requestId = requestMatch[2] ? decodeURIComponent(requestMatch[2]) : undefined;
				if (requestId) {
					if (!/^\d{13}-[a-f0-9-]{36}$/.test(requestId)) return json(400, { error: "请求记录 ID 无效" });
					const path = directory ? join(directory, `${requestId}.json`) : undefined;
					if (!path || !existsSync(path)) return json(404, { error: "请求记录不存在" });
					const record = JSON.parse(readFileSync(path, "utf8"));
					if (record.schemaVersion !== 1 || record.sessionId !== sessionId || record.id !== requestId || !Object.hasOwn(record, "payload"))
						return json(422, { error: "请求记录格式或会话身份不匹配" });
					return json(200, record);
				}
				const requests = directory ? readdirSync(directory)
					.filter((name) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name))
					.sort()
					.map((name) => ({ id: name.slice(0, -5), createdAt: Number(name.slice(0, 13)), bytes: statSync(join(directory, name)).size })) : [];
				return json(200, { requests, directory });
			}
			if (dbPath) {
				if (url.pathname === "/api/source") return json(200, { mode: "database", path: dbPath });
				let db;
				try {
					db = new DatabaseSync(dbPath, { readOnly: true });
					db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 500;");
					if (detail) {
						const row = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(decodeURIComponent(detail[1]));
						return row ? json(200, JSON.parse(row.payload)) : json(404, { error: "会话不存在" });
					}
					const sessions = db
						.prepare("SELECT payload FROM sessions")
						.all()
						.map((row) => {
							const session = JSON.parse(row.payload);
							const { messages, runtime, assistant, activities, tree, transferBase, ...summary } = session;
							return summary;
						})
						.sort((first, second) => second.updatedAt - first.updatedAt);
					return json(200, { sessions });
				} catch (error) {
					return json(503, {
						error: `无法只读打开会话库：${error.message}。运行中的 Core 会独占数据库，请改用在线模式；离线模式需要 Core 已退出。`,
					});
				} finally {
					db?.close();
				}
			}
			if (url.pathname === "/api/source") discoveredUrl = undefined;
			const target = await coreTarget(url);
			if (url.pathname === "/api/source") return json(200, { mode: "live", url: target });
			const path = detail
				? `/sessions/${encodeURIComponent(decodeURIComponent(detail[1]))}`
				: "/sessions?includeSubagents=true";
			try {
				const credential = req.headers["x-pie-token"] || token;
				const response = await fetch(`${target}${path}`, {
					headers: credential ? { Authorization: `Bearer ${credential}` } : {},
					redirect: "error",
					signal: AbortSignal.timeout(10000),
				});
				const body = await response.text();
				res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8" });
				res.end(body);
			} catch {
				discoveredUrl = undefined;
				json(502, { error: `无法连接 ${target}。确认 Pie Core 正在运行，或填写新的地址后点击连接。` });
			}
		})().catch((error) => {
			if (!res.headersSent) json(400, { error: error.message });
			else res.end();
		});
	});
	return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "4319" },
			"core-url": { type: "string" },
			"data-dir": { type: "string" },
			"requests-dir": { type: "string" },
		},
	});
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535 || values.port === "")
		throw new Error("port 必须在 0–65535 之间");
	if (values["data-dir"] && values["core-url"]) throw new Error("--data-dir 与 --core-url 不能同时使用");
	const server = createPromptViewer({
		coreUrl: values["core-url"] ?? process.env.PI_SERVER_URL,
		token: process.env.PI_SERVER_TOKEN,
		dataDir: values["data-dir"],
		requestsDir: values["requests-dir"],
	});
	server.on("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`Pie Core Prompt Viewer: http://127.0.0.1:${server.address().port}`);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
