import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, StdioTransport, StreamableHttpTransport, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";
import type { McpServerInstructions } from "@pie/runtime/mcp";
import type { McpServerConfig } from "@pie/runtime/protocol";
import type { ExternalTool, ToolAsk } from "@pie/runtime/tools";

type Entry = {
	name: string;
	fingerprint: string;
	client: McpClient;
	tools: Tool[];
	status: string;
	error?: string;
	authorizationUrl?: string;
	ready: Promise<void>;
	references: number;
	controller: AbortController;
	callback?: OAuthCallbackServer;
	oauth?: McpOAuthProvider;
	authorizing?: Promise<void>;
};

function fingerprint(config: McpServerConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason ?? new Error("MCP 请求已取消"));
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export class McpManager {
	private entries = new Map<string, Entry>();
	private configured = new Map<string, McpServerConfig>();
	private fingerprints = new Set<string>();
	private pendingCloses = new Set<Promise<void>>();
	private env: NodeJS.ProcessEnv;
	private closed = false;

	constructor(env: NodeJS.ProcessEnv) {
		this.env = { ...env };
	}

	configure(configs: readonly Record<string, McpServerConfig>[]): void {
		if (this.closed) return;
		this.configured = new Map(configs.flatMap((config) => Object.entries(config)));
		this.fingerprints = new Set(
			configs.flatMap((config) =>
				Object.values(config)
					.filter((server) => server.enabled !== false)
					.map(fingerprint),
			),
		);
		for (const [key, entry] of this.entries)
			if (!this.fingerprints.has(entry.fingerprint) && !entry.references) this.dispose(key, entry);
		for (const config of configs)
			for (const [name, server] of Object.entries(config))
				if (server.enabled !== false) this.entry(name, server, process.cwd());
	}

	status(): { servers: Record<string, Record<string, unknown>> } {
		return {
			servers: Object.fromEntries(
				[...this.configured].map(([name, config]) => {
					const candidates = [...this.entries.values()].filter(
						(entry) => entry.fingerprint === fingerprint(config),
					);
					const entry = candidates.find((candidate) => candidate.status === "connected") ?? candidates[0];
					return [
						name,
						config.enabled === false
							? { status: "disabled" }
							: {
									status: entry?.status ?? "disconnected",
									toolCount: entry?.tools.length ?? 0,
									...(entry?.error ? { error: entry.error } : {}),
									...(entry?.authorizationUrl ? { authorizationUrl: entry.authorizationUrl } : {}),
								},
					];
				}),
			),
		};
	}

	private value(value: string): string {
		const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$|^\{env:([^}]+)\}$/.exec(value);
		if (!match) return value;
		const resolved = this.env[match[1] ?? match[2]];
		if (resolved === undefined) throw new Error(`MCP 环境变量未设置：${match[1] ?? match[2]}`);
		return resolved;
	}

	private entry(name: string, config: McpServerConfig, directory: string): Entry {
		if (this.closed) throw new Error("MCP 已关闭");
		const cwd = config.type === "local" && config.cwd ? resolve(directory, config.cwd) : resolve(directory);
		const signature = fingerprint(config);
		const key = `${signature}:${config.type === "remote" ? "remote" : cwd}`;
		const existing = this.entries.get(key);
		if (existing && !(["failed", "disconnected"].includes(existing.status) && !existing.references)) return existing;
		if (existing) this.dispose(key, existing);
		const entry: Entry = {
			name,
			fingerprint: signature,
			client: new McpClient({
				name: "pie",
				version: "1.0.0",
				requestTimeoutMs: config.timeout ?? 30000,
				roots: config.type === "local" ? [{ uri: pathToFileURL(cwd).href, name: "workspace" }] : [],
			}),
			tools: [],
			status: "connecting",
			ready: Promise.resolve(),
			references: 0,
			controller: new AbortController(),
		};
		this.entries.set(key, entry);
		entry.ready = this.connect(entry, config, cwd);
		return entry;
	}

	private async connect(entry: Entry, config: McpServerConfig, cwd: string): Promise<void> {
		try {
			let transport: StdioTransport | StreamableHttpTransport;
			if (config.type === "local")
				transport = new StdioTransport({
					command: this.value(config.command[0]),
					args: config.command.slice(1).map((argument) => this.value(argument)),
					cwd,
					env: {
						...Object.fromEntries(
							Object.entries(this.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
						),
						...Object.fromEntries(
							Object.entries(config.environment ?? {}).map(([name, value]) => [name, this.value(value)]),
						),
					},
					inheritEnv: false,
				});
			else {
				const headers = Object.fromEntries(
					Object.entries(config.headers ?? {}).map(([name, value]) => [name, this.value(value)]),
				);
				if (
					config.oauth !== false &&
					!Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
				) {
					if (!entry.oauth) await this.oauth(entry, config);
				}
				transport = new StreamableHttpTransport({
					url: this.value(config.url),
					headers,
					...(entry.oauth ? { authProvider: adaptOAuthProvider(entry.oauth) } : {}),
				});
			}
			entry.controller.signal.throwIfAborted();
			await entry.client.connect(transport);
			entry.tools = await entry.client.listTools({ signal: entry.controller.signal });
			entry.status = "connected";
			entry.error = undefined;
			entry.authorizationUrl = undefined;
			entry.client.onClose(() => {
				if (entry.status !== "closed") entry.status = "disconnected";
			});
		} catch (error) {
			if (entry.controller.signal.aborted) {
				entry.status = "closed";
				return;
			}
			entry.status = error instanceof McpOAuthAuthorizationRequiredError ? "needs_auth" : "failed";
			entry.error =
				error instanceof McpOAuthAuthorizationRequiredError
					? "MCP 需要 OAuth 授权，请打开 authorizationUrl"
					: "MCP 连接失败，请检查服务配置或日志";
			await entry.client.close();
			if (
				error instanceof McpOAuthAuthorizationRequiredError &&
				entry.oauth &&
				entry.callback &&
				!entry.authorizing
			) {
				entry.authorizing = (async () => {
					const callback = await entry.callback!.waitForCallback(await entry.oauth!.state());
					if (config.type !== "remote") return;
					await authorizeMcp(entry.oauth!, {
						serverUrl: this.value(config.url),
						authorizationCode: callback.code,
						iss: callback.iss,
						signal: entry.controller.signal,
					});
					entry.client = new McpClient({
						name: "pie",
						version: "1.0.0",
						requestTimeoutMs: config.timeout ?? 30000,
					});
					entry.ready = this.connect(entry, config, cwd);
					await entry.ready;
				})()
					.catch(() => {
						if (!entry.controller.signal.aborted) {
							entry.status = "failed";
							entry.error = "MCP OAuth 授权失败或已超时";
						}
					})
					.finally(() => {
						entry.authorizing = undefined;
					});
			}
		}
	}

	private async oauth(entry: Entry, config: Extract<McpServerConfig, { type: "remote" }>): Promise<void> {
		const serverUrl = this.value(config.url);
		const settings = config.oauth || {};
		const statePath = join(
			resolve(this.env.PI_DATA_DIR || ".pie"),
			"mcp-oauth",
			`${createHash("sha256")
				.update(`${serverUrl}\0${settings.clientId ?? ""}`)
				.digest("hex")}.json`,
		);
		let saved: { redirectUrl: string; state: McpOAuthState } | undefined;
		try {
			saved = JSON.parse(await readFile(statePath, "utf8")) as typeof saved;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		}
		entry.callback = await OAuthCallbackServer.listen({
			...(saved ? { port: Number(new URL(saved.redirectUrl).port) } : {}),
		});
		entry.oauth = new McpOAuthProvider({
			serverUrl,
			redirectUrl: entry.callback.redirectUrl,
			clientMetadata: { client_name: "Pie", ...(settings.scope ? { scope: settings.scope } : {}) },
			clientId: settings.clientId,
			clientSecret: settings.clientSecret ? this.value(settings.clientSecret) : undefined,
			onRedirect: (url) => {
				entry.authorizationUrl = url.href;
			},
			store: {
				load: () => saved?.state,
				save: async (state) => {
					saved = { redirectUrl: entry.callback!.redirectUrl, state };
					await mkdir(dirname(statePath), { recursive: true });
					const temporary = `${statePath}.${randomUUID()}.tmp`;
					await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
					await rename(temporary, statePath);
				},
			},
		});
	}

	async acquire(
		configs: Record<string, McpServerConfig>,
		directory: string,
		ask: ToolAsk,
		signal?: AbortSignal,
		reservedNames: readonly string[] = [],
	): Promise<{ tools: ExternalTool[]; instructions: McpServerInstructions[]; release: () => void }> {
		const retained: { key: string; entry: Entry; name: string; config: McpServerConfig }[] = [];
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			for (const { key, entry } of retained) {
				entry.references--;
				if (!entry.references && !this.fingerprints.has(entry.fingerprint)) this.dispose(key, entry);
			}
		};
		try {
			for (const [name, config] of Object.entries(configs)) {
				if (config.enabled === false) continue;
				const entry = this.entry(name, config, directory);
				entry.references++;
				const key = [...this.entries].find(([, candidate]) => candidate === entry)![0];
				retained.push({ key, entry, name, config });
			}
			await cancellable(Promise.all(retained.map(({ entry }) => entry.ready)), signal);
			const used = new Set(reservedNames);
			const toolServers = new Map<string, string>();
			const outputDirectory = resolve(this.env.PI_DATA_DIR || ".pie", "mcp-output");
			const tools = retained.flatMap(({ entry, name, config }) =>
				entry.status === "connected"
					? entry.tools.map((tool) => {
							let id = `mcp__${name}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_");
							if (id.length > 64 || used.has(id))
								id =
									id.slice(0, 55) +
									"_" +
									createHash("sha256").update(`${name}\0${tool.name}`).digest("hex").slice(0, 8);
							used.add(id);
							toolServers.set(id, name);
							return {
								name: id,
								label: `${name}/${tool.name}`,
								description: tool.description?.trim() || tool.title || tool.name,
								parameters: Type.Unsafe({
									...tool.inputSchema,
									type: "object",
									properties: tool.inputSchema.properties ?? {},
								}),
								exposure: "deferred" as const,
								async execute(_toolCallId, args, callSignal, onUpdate) {
									await ask(
										{
											type: "confirmation",
											title: "调用 MCP 工具",
											message: `${name}/${tool.name}\n${JSON.stringify(args)}`,
											metadata: { permission: id, mcpServer: name, mcpTool: tool.name },
										},
										callSignal,
									);
									const result = await entry.client.callTool(tool.name, args as Record<string, unknown>, {
										signal: callSignal,
										timeoutMs: config.timeout,
										onProgress: (progress) =>
											onUpdate?.({
												content: [{ type: "text", text: progress.message ?? String(progress.progress) }],
												details: { mcp: { server: name, tool: tool.name } },
											}),
									});
									const content = toLlmContent(result);
									const text = content
										.filter((block) => block.type === "text")
										.map((block) => block.text)
										.join("\n");
									let fullOutputPath: string | undefined;
									if (Buffer.byteLength(text) > 20 * 1024) {
										fullOutputPath = join(outputDirectory, `${randomUUID()}.txt`);
										await mkdir(dirname(fullOutputPath), { recursive: true });
										await writeFile(fullOutputPath, text, { mode: 0o600 });
										const preview = Buffer.from(text);
										content.splice(0, content.length, ...content.filter((block) => block.type === "image"), {
											type: "text",
											text:
												preview.subarray(0, 10 * 1024).toString() +
												"\n... truncated; full output: " +
												fullOutputPath +
												"\n" +
												preview.subarray(-10 * 1024).toString(),
										});
									}
									if (result.isError && !content.length)
										content.push({ type: "text", text: "MCP 工具返回错误" });
									return {
										content,
										details: {
											mcp: {
												server: name,
												tool: tool.name,
												isError: result.isError === true,
												structuredContent: result.structuredContent,
												fullOutputPath,
											},
										},
									};
								},
							} satisfies AgentTool & { exposure: "deferred" };
						})
					: [],
			);
			const instructions = retained.flatMap(({ entry, name }) => {
				const content = entry.status === "connected" ? entry.client.instructions?.trim() : undefined;
				return content
					? [
							{
								server: name,
								content,
								toolNames: [...toolServers].filter(([, server]) => server === name).map(([id]) => id),
							},
						]
					: [];
			});
			return { tools, instructions, release };
		} catch (error) {
			release();
			throw error;
		}
	}

	private dispose(key: string, entry: Entry): void {
		this.entries.delete(key);
		entry.status = "closed";
		entry.controller.abort();
		const closing = (async () => {
			await entry.client.close();
			await entry.ready;
			await entry.callback?.close();
			await entry.authorizing;
		})();
		this.pendingCloses.add(closing);
		void closing.then(
			() => this.pendingCloses.delete(closing),
			() => this.pendingCloses.delete(closing),
		);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const [key, entry] of this.entries) this.dispose(key, entry);
		await Promise.all(this.pendingCloses);
	}
}
