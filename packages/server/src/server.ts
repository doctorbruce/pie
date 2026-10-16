import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createLocalHost } from "@pie/local";
import { PluginError } from "@pie/local/plugins";
import { type CreateSessionInput, type PieRuntime, RuntimeError, type TurnInput } from "@pie/runtime";
import { ModelSettingsError } from "@pie/runtime/capabilities";
import { SkillConfigError } from "@pie/runtime/config";
import { McpConfigError } from "@pie/runtime/mcp";
import type { GlobalSessionEvent, HostRuntimeDefinition, SessionEvent } from "@pie/runtime/protocol";
import { historyMessageId } from "@pie/runtime/session-tree";
import { ToolConfigError } from "@pie/runtime/tools";

const HOST_RUNTIME_REQUEST_LIMIT = 4 * 1024 * 1024;
const TURN_REQUEST_LIMIT = 32 * 1024 * 1024;

async function readJson(req: IncomingMessage, maxBytes = 65536): Promise<Record<string, unknown>> {
	if (req.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new RuntimeError(415, "需要 application/json");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new RuntimeError(413, `请求超过 ${Math.floor(maxBytes / 1024)} KiB`);
		chunks.push(chunk);
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new RuntimeError(400, "JSON 对象无效");
	}
}

function globalToolResult(result: unknown) {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	const details = Reflect.get(result, "details");
	if (!details || typeof details !== "object" || Array.isArray(details)) return result;
	return { ...details, ...result };
}
function globalAgentEvent(event: SessionEvent["event"]) {
	if (!event) return undefined;
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return { type: event.type };
		case "message_end": {
			const message = event.message;
			if (
				!message ||
				typeof message !== "object" ||
				!("role" in message) ||
				message.role !== "assistant" ||
				!("timestamp" in message) ||
				!("usage" in message)
			)
				return undefined;
			return {
				type: event.type,
				messageId: historyMessageId(message as AgentMessage),
				usage: message.usage,
			};
		}
		case "message_update": {
			const update = event.assistantMessageEvent as AssistantMessageEvent;
			if (!("partial" in update)) return undefined;
			const message = event.message;
			if (!message || typeof message !== "object" || !("timestamp" in message)) return undefined;
			const messageId = historyMessageId(message as AgentMessage);
			const { partial: _partial, ...assistantMessageEvent } = update;
			if (update.type !== "toolcall_start") return { type: event.type, messageId, assistantMessageEvent };
			const toolCall = update.partial.content[update.contentIndex];
			return {
				type: event.type,
				messageId,
				assistantMessageEvent: {
					...assistantMessageEvent,
					...(toolCall?.type === "toolCall" ? { toolCall } : {}),
				},
			};
		}
		case "tool_execution_start":
			return event;
		case "tool_execution_update":
			return { ...event, partialResult: globalToolResult(event.partialResult) };
		case "tool_execution_end":
			return { ...event, result: globalToolResult(event.result) };
		default:
			return undefined;
	}
}

function projectGlobalPacket(packet: GlobalSessionEvent) {
	const { type, sessionId, turnId, snapshot, interaction, event } = packet;
	const base = { type, sessionId, turnId, instanceId: snapshot.instanceId, revision: snapshot.revision };
	if (type === "agent.event") {
		const projected = globalAgentEvent(event);
		return projected ? { ...base, event: projected } : undefined;
	}
	if (type === "snapshot" || type === "turn.settled") return { ...base, snapshot: { turn: snapshot.turn } };
	if (type === "interaction.requested") return { ...base, interaction };
	if (type.startsWith("compaction.")) return { ...base, event };
	return undefined;
}

async function streamEvents(runtime: PieRuntime, res: ServerResponse, sessionId?: string) {
	let initialized = false;
	const pending: (GlobalSessionEvent | SessionEvent)[] = [];
	const write = (packet: GlobalSessionEvent | SessionEvent) => {
		if (!initialized) {
			pending.push(packet);
			return;
		}
		const value = sessionId ? packet : projectGlobalPacket(packet as GlobalSessionEvent);
		if (value === undefined) return;
		if (res.writableLength > 1024 * 1024) res.destroy();
		else res.write(`data: ${JSON.stringify(value)}\n\n`);
	};
	const unsubscribe = sessionId
		? runtime.subscribe(sessionId, write, () => res.end())
		: runtime.subscribeAll(write, () => res.end());
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	res.on("close", () => {
		clearInterval(heartbeat);
		unsubscribe();
	});
	try {
		const snapshot = sessionId ? await runtime.getSession(sessionId, { limit: 50 }) : undefined;
		if (res.destroyed) return;
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
		});
		if (snapshot)
			res.write(
				`data: ${JSON.stringify({ type: "snapshot", sessionId, turnId: snapshot.turn?.id, instanceId: snapshot.instanceId, revision: snapshot.revision, turn: snapshot.turn, snapshot })}\n\n`,
			);
		initialized = true;
		for (const packet of pending)
			if (!snapshot || ("revision" in packet ? packet.revision : packet.snapshot.revision) > snapshot.revision)
				write(packet);
		pending.length = 0;
		heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
	} catch (error) {
		unsubscribe();
		throw error;
	}
}

export function createCoreServer(environment: NodeJS.ProcessEnv = process.env) {
	const env = Object.freeze({ ...environment });
	const { settings, agents: factory, ready } = createLocalHost(env);
	void ready.catch(() => {});
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const server = createServer((req, res) => {
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(value));
		};
		void (async () => {
			if (closing) throw new RuntimeError(503, "服务正在关闭");
			const origin = req.headers.origin;
			if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) throw new RuntimeError(403, "只接受本地地址");
			if (origin && origin !== (env.PI_WEB_ORIGIN ?? "http://127.0.0.1:5174"))
				throw new RuntimeError(403, "来源不允许");
			if (env.PI_SERVER_TOKEN && req.headers.authorization !== `Bearer ${env.PI_SERVER_TOKEN}`)
				throw new RuntimeError(401, "认证失败");
			const runtime = await ready;
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = url.pathname;
			if (!runtime.storageAvailable && req.method !== "GET")
				throw new RuntimeError(503, "存储不可用，请检查后重启服务");
			if (path === "/health" && req.method === "GET") return json(200, { healthy: true, ...runtime.info });
			if (path === "/tools" && req.method === "GET") return json(200, { tools: runtime.tools });
			if (path === "/plugins" && req.method === "GET") return json(200, { plugins: await runtime.listPlugins() });
			if (path === "/plugins/import" && req.method === "POST")
				return json(201, await runtime.importPlugin(await readJson(req)));
			const pluginMatch = /^\/plugins\/([^/]+)$/.exec(path);
			if (pluginMatch && req.method === "DELETE")
				return json(200, await runtime.deletePlugin(decodeURIComponent(pluginMatch[1])));
			if (path === "/assistants" && req.method === "GET")
				return json(200, { assistants: await runtime.listAssistants() });
			const assistantMatch = /^\/assistants\/([^/]+)$/.exec(path);
			if ((path === "/assistants" && req.method === "POST") || (assistantMatch && req.method === "PUT"))
				return json(
					assistantMatch ? 200 : 201,
					await runtime.saveAssistant(await readJson(req), assistantMatch?.[1]),
				);
			if (assistantMatch && req.method === "DELETE")
				return json(200, await runtime.deleteAssistant(assistantMatch[1]));
			if (path === "/sessions" && req.method === "GET")
				return json(
					200,
					await runtime.listSessions({
						assistantId: url.searchParams.get("assistantId") ?? undefined,
						includeSubagents: url.searchParams.get("includeSubagents") === "true",
					}),
				);
			if (path === "/events" && req.method === "GET") return streamEvents(runtime, res);
			if (path === "/mcp" && req.method === "GET") return json(200, factory.mcp.status());
			if (path === "/host-runtimes" && req.method === "PUT") {
				const body = await readJson(req, HOST_RUNTIME_REQUEST_LIMIT);
				if (!Array.isArray(body.runtimes)) throw new RuntimeError(400, "runtimes 需要数组");
				return json(200, await runtime.registerHostRuntimes(body.runtimes as HostRuntimeDefinition[]));
			}
			if (path === "/models" && req.method === "GET") return json(200, settings.catalog());
			if (path === "/providers" && req.method === "GET") return json(200, settings.providers());
			if (path === "/providers/config" && req.method === "PUT") {
				settings.saveProvider(await readJson(req));
				return json(200, settings.providers());
			}
			if (path === "/providers/discover" && req.method === "POST")
				return json(200, { models: await settings.discover(await readJson(req)) });
			if (path === "/models/config" && req.method === "PUT") {
				settings.update(await readJson(req));
				return json(200, settings.catalog());
			}
			if (path === "/models/reload" && req.method === "POST") {
				await readJson(req);
				settings.reload();
				return json(200, settings.catalog());
			}
			if (path === "/sessions" && req.method === "POST")
				return json(201, await runtime.createSession((await readJson(req)) as CreateSessionInput));
			const match =
				/^\/sessions\/([^/]+)(?:\/(events|history|turns|steer|cancel|interactions|export|import|fork|tree|model-override)(?:\/([^/]+))?)?$/.exec(
					path,
				);
			if (!match) throw new RuntimeError(404, "会话或接口不存在");
			const [, id, action, interactionId] = match;
			if (req.method === "GET" && !action)
				return json(
					200,
					await runtime.getSession(
						id,
						url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : undefined,
					),
				);
			if (req.method === "GET" && action === "events") return streamEvents(runtime, res, id);
			if (req.method === "GET" && action === "history")
				return json(
					200,
					await runtime.readHistory(id, {
						limit: Number(url.searchParams.get("limit") ?? "50"),
						...(url.searchParams.has("beforeSeq")
							? { beforeSeq: Number(url.searchParams.get("beforeSeq")) }
							: {}),
						...(url.searchParams.has("leafId")
							? { leafId: url.searchParams.get("leafId") === "null" ? null : url.searchParams.get("leafId") }
							: {}),
					}),
				);
			if (req.method === "GET" && action === "export") return json(200, await runtime.exportSession(id));
			if (req.method === "POST" && action === "fork")
				return json(201, await runtime.forkSession(id, await readJson(req)));
			if (req.method === "GET" && action === "tree") return json(200, await runtime.getTree(id));
			if (req.method === "POST" && action === "tree")
				return json(200, await runtime.selectTree(id, await readJson(req)));
			if (req.method === "PUT" && action === "import")
				return json(200, await runtime.importSession(id, await readJson(req, TURN_REQUEST_LIMIT)));
			if (req.method === "PUT" && action === "model-override")
				return json(200, await runtime.setModelOverride(id, await readJson(req)));
			if (req.method === "PATCH" && !action) return json(200, await runtime.renameSession(id, await readJson(req)));
			if (req.method === "POST" && action === "cancel")
				return json(202, await runtime.cancelTurn(id, (await readJson(req)) as { turnId: string }));
			if (req.method === "POST" && action === "steer")
				return json(
					202,
					await runtime.steer(id, (await readJson(req, TURN_REQUEST_LIMIT)) as TurnInput & { turnId: string }),
				);
			if (req.method === "POST" && action === "interactions")
				return json(
					202,
					await runtime.replyInteraction(id, interactionId, (await readJson(req)) as { approved: boolean }),
				);
			if (req.method === "POST" && action === "turns")
				return json(202, await runtime.submitTurn(id, (await readJson(req, TURN_REQUEST_LIMIT)) as TurnInput));
			if (req.method === "DELETE" && !action) return json(200, await runtime.deleteSession(id));
			await runtime.getSession(id);
			throw new RuntimeError(405, "不支持此操作");
		})().catch((error: unknown) => {
			if (res.headersSent) return res.destroy();
			json(
				error instanceof RuntimeError
					? error.status
					: error instanceof ModelSettingsError ||
							error instanceof ToolConfigError ||
							error instanceof PluginError ||
							error instanceof SkillConfigError ||
							error instanceof McpConfigError
						? 400
						: 500,
				{ error: error instanceof Error ? error.message : "服务错误" },
			);
		});
	});
	return {
		server,
		ready,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				try {
					await (await ready).close();
				} finally {
					await new Promise<void>((resolve, reject) => {
						if (!server.listening) return resolve();
						server.close((error) => (error ? reject(error) : resolve()));
						server.closeAllConnections();
					});
				}
			})();
			return closePromise;
		},
	};
}
