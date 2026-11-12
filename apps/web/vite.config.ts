import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type UserConfig } from "vite";

export function createWebConfig(target: string, token?: string): UserConfig {
	const core = new URL(target);
	if (
		core.protocol !== "http:" ||
		core.hostname !== "127.0.0.1" ||
		core.username ||
		core.password ||
		core.pathname !== "/" ||
		core.search ||
		core.hash
	)
		throw new Error("PI_SERVER_URL 必须是 http://127.0.0.1:<端口>");
	const client = fileURLToPath(new URL("./client", import.meta.url));
	return {
		root: client,
		oxc: { jsx: { runtime: "automatic" } },
		plugins: [
			{
				name: "pie-local-origin",
				configResolved(config) {
					if (config.server.host !== "127.0.0.1") throw new Error("聊天页面只能监听 127.0.0.1");
				},
				configureServer(server) {
					server.middlewares.use((request, response, next) => {
						const address = server.httpServer?.address();
						const authority = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : undefined;
						if (
							!authority ||
							request.headers.host !== authority ||
							(request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)
						) {
							response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
							response.end("只接受本地聊天页面的请求");
							return;
						}
						next();
					});
				},
			},
		],
		server: {
			host: "127.0.0.1",
			port: 5174,
			strictPort: true,
			cors: false,
			fs: { strict: true, allow: [client] },
			proxy: {
				"^/api(?:/|$)": {
					target: core.origin,
					changeOrigin: true,
					rewrite: (path) => path.slice(4) || "/",
					configure(proxy) {
						proxy.on("proxyReq", (request) => {
							// Validate the browser Origin above before crossing into Core.
							request.removeHeader("origin");
							if (token) request.setHeader("authorization", `Bearer ${token}`);
						});
					},
				},
			},
		},
	};
}

export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, process.cwd(), "PI_"), ...process.env };
	return createWebConfig(env.PI_SERVER_URL ?? "http://127.0.0.1:4318", env.PI_SERVER_TOKEN);
});
