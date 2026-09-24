import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const env = { ...loadEnv("development", process.cwd(), "PI_"), ...process.env };
export default defineConfig({
	root: fileURLToPath(new URL("./client", import.meta.url)),
	oxc: { jsx: { runtime: "automatic" } },
	server: {
		host: "127.0.0.1",
		port: 5174,
		strictPort: true,
		fs: { strict: true, allow: [fileURLToPath(new URL("./client", import.meta.url))] },
		proxy: {
			"/api": {
				target: env.PI_SERVER_URL ?? "http://127.0.0.1:4318",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
				headers: env.PI_SERVER_TOKEN ? { Authorization: `Bearer ${env.PI_SERVER_TOKEN}` } : {},
			},
		},
	},
});
