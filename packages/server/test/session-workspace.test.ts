import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

test("HTTP workspace changes persist before input and Worker inbox turns use the new directory after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-session-workspace-"));
	const source = join(directory, "source");
	const target = join(directory, "target");
	const tools = join(directory, "tools");
	await Promise.all([mkdir(source), mkdir(target), mkdir(tools)]);
	await writeFile(
		join(tools, "workspace_probe.mjs"),
		`import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default ({ Type, directory }) => ({
  name: "workspace_probe", label: "Workspace probe", description: "Write in the session directory",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, args) {
    await writeFile(join(directory, "probe.txt"), args.text);
    return { content: [{ type: "text", text: args.text }], details: {} };
  },
});`,
	);
	const env = {
		PI_DATA_DIR: join(directory, "data"),
		PI_TOOLS_DIR: tools,
		PI_TOOL_STREAM_TRACE: "0",
		PI_MODEL_REQUEST_RECORDING: "0",
	};
	async function start() {
		const core = createCoreServer(env);
		const runtime = await core.ready;
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return { ...core, runtime, base: `http://127.0.0.1:${address.port}` };
	}
	let core = await start();
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	await core.runtime.registerHostRuntimes(
		["a", "b"].map((assistantId) => ({
			assistantId,
			assistantRevision: "1",
			runtime: { systemPrompt: "", toolIds: ["workspace_probe"], skills: [], subagents: [] },
		})),
	);
	const session = await core.runtime.createSession({
		assistantId: "a",
		workerId: "a",
		astronSessionId: "product-a",
		workspacePath: source,
		mode: "faux",
	});
	const turnResponse = await fetch(`${core.base}/sessions/${session.id}/turns`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: '调用工具 workspace_probe {"text":"before"}', workspacePath: target }),
	});
	assert.equal(turnResponse.status, 202, await turnResponse.clone().text());
	const before = await core.runtime.waitForTurn(session.id);
	assert.equal(before.turn?.status, "completed");
	assert.equal(before.workspacePath, source);
	const response = await fetch(`${core.base}/sessions/${session.id}/workspace`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ workspacePath: target }),
	});
	assert.equal(response.status, 200, await response.clone().text());
	const updated = (await response.json()) as SessionSummary;
	assert.equal(updated.workspacePath, target);
	assert.equal("messages" in updated, false);
	assert.deepEqual((await core.runtime.getSession(session.id)).messages, before.messages);
	await core.close();
	core = await start();
	assert.equal((await core.runtime.getSession(session.id)).workspacePath, target);
	const delivery = await core.runtime.enqueueWorkerMessage({
		messageId: "after-workspace-change",
		sourceWorkerId: "b",
		workerId: "a",
		targetSessionId: session.id,
		kind: "request",
		content: '调用工具 workspace_probe {"text":"worker after migration"}',
	});
	assert.equal((await core.runtime.waitWorkerDelivery(delivery.delivery.deliveryId)).status, "consumed");
	assert.equal((await core.runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(await readFile(join(source, "probe.txt"), "utf8"), "before");
	assert.equal(await readFile(join(target, "probe.txt"), "utf8"), "worker after migration");
});
