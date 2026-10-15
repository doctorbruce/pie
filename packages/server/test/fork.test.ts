import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type {
	SessionEvent,
	SessionForkResult,
	SessionSnapshot,
	SessionTransfer,
	SessionTree,
} from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

async function post(base: string, path: string, body: unknown) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function submit(base: string, sessionId: string, text: string) {
	assert.equal((await post(base, `/sessions/${sessionId}/turns`, { text })).status, 202);
	for (let attempt = 0; attempt < 200; attempt++) {
		const snapshot = (await (await fetch(`${base}/sessions/${sessionId}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") return snapshot;
		await setTimeout(10);
	}
	throw new Error("turn did not settle");
}

test("fork creates an independent session before the selected user message and restores it after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-fork-test-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});

	const created = await post(running.base, "/sessions", {
		title: "原会话",
	});
	assert.equal(created.status, 201);
	const source = (await created.json()) as SessionSnapshot;
	const modelOverride = { providerId: "custom", model: "custom-model" };
	assert.equal(
		(
			await fetch(`${running.base}/sessions/${source.id}/model-override`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelOverride }),
			})
		).status,
		200,
	);
	await submit(running.base, source.id, "第一条消息");
	const sourceAfterSecond = await submit(running.base, source.id, "第二条消息");
	assert.deepEqual(
		sourceAfterSecond.messages.map((message) => message.role),
		["user", "assistant", "user", "assistant"],
	);

	const response = await post(running.base, `/sessions/${source.id}/fork`, { messageIndex: 2 });
	assert.equal(response.status, 201);
	const result = (await response.json()) as SessionForkResult;
	assert.equal(result.selectedText, "第二条消息");
	assert.equal(result.session.forkedFromSessionId, source.id);
	assert.equal(result.session.title, "原会话（分支）");
	assert.equal(result.session.turn, undefined);
	assert.deepEqual(result.session.messages, sourceAfterSecond.messages.slice(0, 2));
	assert.deepEqual(result.session.runtime, sourceAfterSecond.runtime);
	assert.deepEqual(result.session.modelOverride, modelOverride);

	assert.equal((await post(running.base, `/sessions/${source.id}/fork`, { messageIndex: 1 })).status, 400);
	const forkAfterTurn = await submit(running.base, result.session.id, "修改后的第二条消息");
	assert.equal(forkAfterTurn.messages.length, 4);
	assert.equal(
		((await (await fetch(`${running.base}/sessions/${source.id}`)).json()) as SessionSnapshot).messages.length,
		4,
	);

	await running.core.close();
	running = await start(directory);
	const restored = (await (await fetch(`${running.base}/sessions/${result.session.id}`)).json()) as SessionSnapshot;
	assert.equal(restored.forkedFromSessionId, source.id);
	assert.deepEqual(restored.modelOverride, modelOverride);
	assert.equal(restored.messages.length, 4);
	assert.equal((await fetch(`${running.base}/sessions/${source.id}`, { method: "DELETE" })).status, 200);
	assert.equal((await fetch(`${running.base}/sessions/${result.session.id}`)).status, 200);
});

test("tree retains alternate branches, restores them after restart, and forks after a reply", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tree-test-"));
	let running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = (await (await post(running.base, "/sessions", { title: "树会话" })).json()) as SessionSnapshot;
	const first = await submit(running.base, source.id, "第一条消息");
	const original = await submit(running.base, source.id, "原第二条消息");
	const getTree = async () =>
		(await (await fetch(`${running.base}/sessions/${source.id}/tree`)).json()) as SessionTree;
	const tree = await getTree();
	const selected = tree.entries.find((entry) => entry.text === "原第二条消息");
	assert(selected);
	const originalLeaf = tree.leafId;
	const navigation = await post(running.base, `/sessions/${source.id}/tree`, { entryId: selected.id });
	assert.equal(navigation.status, 200);
	const rewind = (await navigation.json()) as SessionForkResult;
	assert.equal(rewind.session.id, source.id);
	assert.equal(rewind.selectedText, "原第二条消息");
	assert.deepEqual(rewind.session.messages, first.messages);
	assert.equal(rewind.session.turn, undefined);
	const alternative = await submit(running.base, source.id, "修改后的第二条消息");
	const branched = await getTree();
	assert.equal(branched.entries.length, original.messages.length + 2);
	assert.equal(branched.entries.filter((entry) => entry.active).length, alternative.messages.length);
	assert.equal(branched.entries.find((entry) => entry.id === originalLeaf)?.active, false);
	assert.equal((await post(running.base, `/sessions/${source.id}/tree`, { entryId: "missing" })).status, 400);
	assert.deepEqual(
		((await (await fetch(`${running.base}/sessions/${source.id}`)).json()) as SessionSnapshot).messages,
		alternative.messages,
	);
	await running.core.close();
	running = await start(directory);
	assert.deepEqual(await getTree(), branched);
	const restored = (await (
		await post(running.base, `/sessions/${source.id}/tree`, { entryId: originalLeaf })
	).json()) as SessionForkResult;
	assert.deepEqual(restored.session.messages, original.messages);
	const secondUser = tree.entries.find((entry) => entry.id === selected.id);
	assert(secondUser);
	const fork = await post(running.base, `/sessions/${source.id}/fork`, { beforeMessageId: secondUser.messageId });
	assert.equal(fork.status, 201);
	assert.deepEqual(((await fork.json()) as SessionForkResult).session.messages, first.messages);
	const fullFork = await post(running.base, `/sessions/${source.id}/fork`, { beforeMessageId: null });
	assert.equal(fullFork.status, 201);
	assert.deepEqual(((await fullFork.json()) as SessionForkResult).session.messages, original.messages);
	const root = tree.entries.find((entry) => entry.parentId === null);
	assert(root);
	const reset = (await (
		await post(running.base, `/sessions/${source.id}/tree`, { messageId: root.messageId })
	).json()) as SessionForkResult;
	assert.deepEqual(reset.session.messages, []);
	assert.equal((await getTree()).entries.length, branched.entries.length);
});

test("tree keeps imported IDs, images, metadata and completed tool results without unsafe cuts", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tree-import-"));
	const running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = (await (await post(running.base, "/sessions", {})).json()) as SessionSnapshot;
	const transcript: SessionTransfer["transcript"] = [
		{
			id: "import-user",
			role: "user",
			content: [
				{ type: "text", text: "看图" },
				{ type: "file", mimeType: "image/png", uri: "data:image/png;base64,aGVsbG8=" },
			],
			metadata: { clientMessageId: "client-image" },
			createdAt: 100,
		},
		{
			id: "import-answer",
			role: "assistant",
			content: [
				{
					type: "tool",
					tool: "read",
					callID: "call-import",
					state: { status: "completed", input: {}, output: "saved output" },
				},
			],
			createdAt: 100,
		},
		{ id: "import-next", role: "user", content: [{ type: "text", text: "继续" }], createdAt: 100 },
		{ id: "import-final", role: "assistant", content: [{ type: "text", text: "完成" }], createdAt: 100 },
	];
	const imported = await fetch(`${running.base}/sessions/${source.id}/import`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			source: { astronSessionId: "astron-import", coreId: "test", sessionId: "source" },
			transcript,
		}),
	});
	assert.equal(imported.status, 200);
	const tree = (await (await fetch(`${running.base}/sessions/${source.id}/tree`)).json()) as SessionTree;
	const unsafe = tree.entries.find((entry) => entry.messageId === "import-answer");
	assert(unsafe);
	assert.equal(unsafe.selectable, false);
	assert.equal((await post(running.base, `/sessions/${source.id}/tree`, { entryId: unsafe.id })).status, 409);
	const boundary = tree.entries.find((entry) => entry.messageId === "import-next");
	assert(boundary);
	assert.equal((await post(running.base, `/sessions/${source.id}/tree`, { entryId: boundary.id })).status, 200);
	const exported = (await (await fetch(`${running.base}/sessions/${source.id}/export`)).json()) as SessionTransfer;
	assert.equal(exported.transcript[0].id, "import-user");
	assert.deepEqual(exported.transcript[0].content, transcript[0].content);
	assert.deepEqual(exported.transcript[0].metadata, transcript[0].metadata);
	assert.equal(exported.transcript[1].content[0].type, "tool");
	assert.deepEqual(exported.transcript[1].content[0].state, {
		status: "completed",
		input: {},
		output: "saved output",
	});
	assert.equal((await post(running.base, `/sessions/${source.id}/tree`, { entryId: tree.leafId })).status, 200);
	assert.equal(
		((await (await fetch(`${running.base}/sessions/${source.id}/export`)).json()) as SessionTransfer).transcript
			.length,
		4,
	);
});

test("tree refuses navigation when a turn starts while the request body is arriving", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tree-concurrent-"));
	const running = await start(directory);
	context.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = (await (await post(running.base, "/sessions", {})).json()) as SessionSnapshot;
	await submit(running.base, source.id, "已有消息");
	const tree = (await (await fetch(`${running.base}/sessions/${source.id}/tree`)).json()) as SessionTree;
	const body = JSON.stringify({ entryId: tree.leafId });
	const entered = new Promise<void>((resolve) => running.core.server.once("request", () => resolve()));
	const pendingRequest = request(`${running.base}/sessions/${source.id}/tree`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
	});
	context.after(() => pendingRequest.destroy());
	const response = new Promise<number>((resolve, reject) => {
		pendingRequest.once("response", (result) => {
			result.resume();
			resolve(result.statusCode ?? 0);
		});
		pendingRequest.once("error", reject);
	});
	pendingRequest.write(body.slice(0, 1));
	await entered;
	const accepted = await post(running.base, `/sessions/${source.id}/turns`, { text: "新回合" });
	assert.equal(accepted.status, 202);
	const turn = (await accepted.json()) as { turnId: string };
	pendingRequest.end(body.slice(1));
	assert.equal(await response, 409);
	const active = (await (await fetch(`${running.base}/sessions/${source.id}`)).json()) as SessionSnapshot;
	assert.equal(active.turn?.id, turn.turnId);
	assert.equal((await post(running.base, `/sessions/${source.id}/cancel`, { turnId: turn.turnId })).status, 202);
});

test("live assistant identity matches the historical fork boundary", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-fork-identity-"));
	const running = await start(directory);
	const controller = new AbortController();
	context.after(async () => {
		controller.abort();
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const source = (await (await post(running.base, "/sessions", {})).json()) as SessionSnapshot;
	const subscribed = new Promise<void>((resolve) => running.core.server.once("request", () => resolve()));
	const subscription = fetch(`${running.base}/events`, {
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
	});
	await subscribed;
	const final = await submit(running.base, source.id, "身份一致性");
	const response = await subscription;
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const packets: SessionEvent[] = [];
	let buffer = "";
	try {
		while (!packets.some((packet) => packet.type === "turn.settled")) {
			const { value, done } = await reader.read();
			assert(!done);
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames)
				if (frame.startsWith("data: ")) packets.push(JSON.parse(frame.slice(6)) as SessionEvent);
		}
	} finally {
		await reader.cancel();
	}
	const assistant = final.messages.at(-1);
	assert(assistant?.role === "assistant");
	assert.equal(
		packets.find((packet) => packet.event?.type === "message_end")?.event?.messageId,
		`pie:assistant:${assistant.timestamp}`,
	);
});
