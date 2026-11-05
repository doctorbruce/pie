import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return {
		...core,
		request: (path: string, method = "GET", body?: unknown) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, {
				method,
				...(body === undefined
					? {}
					: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			}),
	};
}

test("input batch receipt survives HTTP retry and runtime restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-coordination-"));
	let core = await start(directory);
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const created = await core.request("/sessions", "POST", { title: "协调测试" });
	assert.equal(created.status, 201);
	const session = (await created.json()) as { id: string };
	const body = { batchId: "batch-http-1", content: "补充输入", requestFingerprint: "fingerprint-1" };
	const first = await core.request(`/sessions/${session.id}/input-batches`, "POST", body);
	assert.equal(first.status, 202);
	const retry = await core.request(`/sessions/${session.id}/input-batches`, "POST", body);
	assert.equal(retry.status, 202);
	assert.equal(((await retry.json()) as { batchId: string }).batchId, body.batchId);
	await core.close();
	core = await start(directory);
	const receipt = await core.request(`/sessions/${session.id}/input-batches/${body.batchId}`);
	assert.equal(receipt.status, 200);
	const saved = (await receipt.json()) as { status: string; content: string; batchId: string; sessionId: string };
	assert.equal(saved.status, "pending");
	assert.equal(saved.content, body.content);
	assert.equal(saved.batchId, body.batchId);
	assert.equal(saved.sessionId, session.id);
});
