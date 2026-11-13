import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCoreServer } from "../src/server.ts";

async function start(environment: NodeJS.ProcessEnv) {
	const core = createCoreServer(environment);
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

test("installed DeepSeek search becomes the default assistant tool", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie default tools "));
	const toolsDirectory = join(directory, "tools");
	const cores: { close: () => Promise<void> }[] = [];
	t.after(async () => {
		for (const core of cores.reverse()) await core.close();
		await rm(directory, { recursive: true, force: true });
	});

	const first = await start({ PI_DATA_DIR: directory });
	cores.push(first.core);
	const before = (await (await fetch(`${first.base}/assistants`)).json()) as {
		assistants: { name: string; toolIds: string[] }[];
	};
	assert.deepEqual(before.assistants[0]?.toolIds, []);
	await first.core.close();
	cores.pop();

	await mkdir(toolsDirectory);
	await copyFile(
		fileURLToPath(new URL("../../../examples/tools/deepseek-web-search.ts", import.meta.url)),
		join(toolsDirectory, "deepseek-web-search.ts"),
	);
	const second = await start({ PI_DATA_DIR: directory, PI_TOOLS_DIR: toolsDirectory });
	cores.push(second.core);
	const after = (await (await fetch(`${second.base}/assistants`)).json()) as {
		assistants: { name: string; toolIds: string[] }[];
	};
	assert.deepEqual(after.assistants[0]?.toolIds, ["deepseek-web-search"]);
});
