import { parseArgs } from "node:util";
import { createCoreServer } from "./server.ts";

const { values } = parseArgs({
	options: { port: { type: "string", default: "4318" }, "tools-dir": { type: "string" } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535 || values.port === "")
	throw new Error("port 必须在 0–65535 之间");
const core = createCoreServer({ ...process.env, PI_TOOLS_DIR: values["tools-dir"] ?? process.env.PI_TOOLS_DIR });
core.server.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
core.server.listen(port, "127.0.0.1", () => {
	const address = core.server.address();
	if (address && typeof address !== "string")
		console.log(JSON.stringify({ type: "ready", url: `http://127.0.0.1:${address.port}` }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void core.close();
	});
