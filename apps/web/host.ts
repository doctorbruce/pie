import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createCoreServer } from "../../packages/server/src/server.ts";
import { createWebConfig } from "./vite.config.ts";

export async function startChatHost(options: { environment?: NodeJS.ProcessEnv; port?: number } = {}) {
	const port = options.port ?? 5174;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port 必须在 0–65535 之间");
	const token = randomBytes(32).toString("hex");
	const core = createCoreServer({
		...(options.environment ?? process.env),
		PI_SERVER_TOKEN: token,
		PI_SERVER_ORIGIN: undefined,
	});
	let web: ViteDevServer | undefined;
	let closePromise: Promise<void> | undefined;
	const close = () => {
		closePromise ??= (async () => {
			try {
				await web?.close();
			} finally {
				await core.close();
			}
		})();
		return closePromise;
	};
	try {
		await core.ready;
		core.server.listen(0, "127.0.0.1");
		await once(core.server, "listening");
		const coreAddress = core.server.address();
		if (!coreAddress || typeof coreAddress === "string") throw new Error("Core 未监听本地端口");
		const config = createWebConfig(`http://127.0.0.1:${coreAddress.port}`, token);
		web = await createViteServer({
			...config,
			configFile: false,
			plugins: [
				...(config.plugins ?? []),
				{
					name: "pie-core-lifecycle",
					async closeServer({ reason }) {
						// Vite also handles SIGTERM; finish Core cleanup before its process exit.
						if (reason === "close") await core.close();
					},
				},
			],
			server: { ...config.server, port },
		});
		await web.listen();
		const address = web.httpServer?.address();
		if (!address || typeof address === "string") throw new Error("聊天页面未监听本地端口");
		return { url: `http://127.0.0.1:${address.port}`, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({ options: { port: { type: "string", default: "5174" } } });
		if (!values.port) throw new Error("port 必须在 0–65535 之间");
		const host = await startChatHost({ port: Number(values.port) });
		console.log(`Pie 聊天已启动：${host.url}`);
		for (const signal of ["SIGINT", "SIGTERM"] as const)
			process.once(signal, () => {
				void host.close().catch((error: unknown) => {
					console.error(error instanceof Error ? error.message : String(error));
					process.exitCode = 1;
				});
			});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
