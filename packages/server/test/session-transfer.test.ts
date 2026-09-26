import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionSnapshot, SessionTransfer } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";
import { agentMessagesToTransfer, displayAgentMessages, transferToAgentMessages } from "../src/session-transfer.ts";

async function start(directory: string) {
	const core = createCoreServer({ PI_DATA_DIR: directory });
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	return { core, base: `http://127.0.0.1:${address.port}` };
}

async function jsonRequest(base: string, path: string, method: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

test("session transfer overwrites a Pie replica, survives restart, and remains usable", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-transfer-test-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});

	const createdResponse = await jsonRequest(running.base, "/sessions", "POST", {
		assistantId: "astron-assistant",
		assistantRevision: "7",
		runtime: { systemPrompt: "Answer directly.", toolIds: [], skills: [], subagents: [] },
	});
	assert.equal(createdResponse.status, 201);
	const created = (await createdResponse.json()) as SessionSnapshot;
	const transcript: SessionTransfer["transcript"] = [
		{
			id: "message-user",
			role: "user",
			content: [{ id: "part-user", type: "text", text: "read the project" }],
			createdAt: 100,
		},
		{
			id: "message-assistant",
			role: "assistant",
			content: [
				{ id: "part-thought", type: "thought", text: "I should inspect it." },
				{
					id: "part-tool",
					type: "tool",
					tool: "read",
					callID: "call-1",
					state: { status: "completed", input: { path: "README.md" }, output: "project readme" },
				},
				{ id: "part-text", type: "text", text: "The project is ready." },
			],
			createdAt: 200,
		},
	];
	const transfer: SessionTransfer = {
		schemaVersion: 1,
		source: { astronSessionId: "astron-session", coreId: "opencode", sessionId: "opencode-session" },
		title: "Migrated conversation",
		transcript,
		createdAt: 100,
		updatedAt: 200,
	};
	const importedResponse = await jsonRequest(running.base, `/sessions/${created.id}/import`, "PUT", transfer);
	assert.equal(importedResponse.status, 200);
	const imported = (await importedResponse.json()) as { transfer: SessionTransfer };
	assert.deepEqual(imported.transfer.transcript, transcript);

	await running.core.close();
	running = await start(directory);
	const exportedResponse = await fetch(`${running.base}/sessions/${created.id}/export`);
	assert.equal(exportedResponse.status, 200);
	const exported = (await exportedResponse.json()) as SessionTransfer;
	assert.deepEqual(exported.transcript, transcript);
	assert.equal(exported.source.astronSessionId, "astron-session");
	assert.equal(exported.source.coreId, "pie");
	assert.equal(exported.source.sessionId, created.id);
	assert.equal(exported.title, "Migrated conversation");

	const turnResponse = await jsonRequest(running.base, `/sessions/${created.id}/turns`, "POST", {
		text: "continue here",
	});
	assert.equal(turnResponse.status, 202);
	let snapshot: SessionSnapshot | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		snapshot = (await (await fetch(`${running.base}/sessions/${created.id}`)).json()) as SessionSnapshot;
		if (snapshot.turn?.status !== "running") break;
	}
	assert.equal(snapshot?.turn?.status, "completed");
	const continued = (await (await fetch(`${running.base}/sessions/${created.id}/export`)).json()) as SessionTransfer;
	assert.deepEqual(continued.transcript.slice(0, transcript.length), transcript);
	assert.deepEqual(
		continued.transcript.slice(transcript.length).map((message) => message.role),
		["user", "assistant"],
	);
});

test("session hydration hides model-only turn context for current and legacy prompts", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-display-prompt-test-"));
	let running = await start(directory);
	t.after(async () => {
		await running.core.close();
		await rm(directory, { recursive: true, force: true });
	});

	async function createSettledSession(text: string, displayText?: string) {
		const created = (await (await jsonRequest(running.base, "/sessions", "POST", {})).json()) as SessionSnapshot;
		const response = await jsonRequest(running.base, `/sessions/${created.id}/turns`, "POST", {
			text,
			...(displayText ? { displayText } : {}),
		});
		assert.equal(response.status, 202);
		for (let attempt = 0; attempt < 100; attempt++) {
			const snapshot = (await (await fetch(`${running.base}/sessions/${created.id}`)).json()) as SessionSnapshot;
			if (snapshot.turn?.status !== "running") return created.id;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail("Pie turn did not settle");
	}

	const internalContext = [
		'<turn_instructions scope="current_user_turn">',
		"TURN_PRODUCT_CONTEXT=null",
		"</turn_instructions>",
		"",
		'<turn_context scope="current_user_turn">',
		"## 长期记忆",
		"内部记忆",
		"</turn_context>",
	].join("\n");
	const fullPrompt = `你好啊\n\n${internalContext}`;
	const currentSessionId = await createSettledSession(fullPrompt, "你好啊");

	const currentSnapshot = (await (
		await fetch(`${running.base}/sessions/${currentSessionId}`)
	).json()) as SessionSnapshot;
	assert.equal(currentSnapshot.messages[0]?.role, "user");
	assert.equal(currentSnapshot.messages[0]?.content, "你好啊");
	const currentExport = (await (
		await fetch(`${running.base}/sessions/${currentSessionId}/export`)
	).json()) as SessionTransfer;
	assert.deepEqual(currentExport.transcript[0]?.content, [{ type: "text", text: "你好啊" }]);

	await running.core.close();
	running = await start(directory);
	const restartedSnapshot = (await (
		await fetch(`${running.base}/sessions/${currentSessionId}`)
	).json()) as SessionSnapshot;
	assert.equal(restartedSnapshot.messages[0]?.role, "user");
	assert.equal(restartedSnapshot.messages[0]?.content, "你好啊");

	const legacySessionId = await createSettledSession(fullPrompt);
	const legacyExport = (await (
		await fetch(`${running.base}/sessions/${legacySessionId}/export`)
	).json()) as SessionTransfer;
	assert.deepEqual(legacyExport.transcript[0]?.content, [{ type: "text", text: "你好啊" }]);
});

test("background completion notifications remain model-only", () => {
	const syntheticContent = [
		{
			type: "text" as const,
			text: '<background_job id="new-job" type="bash" state="completed">done</background_job>',
			synthetic: true as const,
		},
	];
	const messages: AgentMessage[] = [
		{ role: "user", content: "用户消息", timestamp: 1 },
		{ role: "user", content: syntheticContent, timestamp: 2 },
		{
			role: "user",
			content: '<background_job id="legacy-job" type="bash" state="completed">done</background_job>',
			timestamp: 3,
		},
		{
			role: "user",
			content: '<task id="legacy-task" state="completed">done</task>',
			timestamp: 4,
		},
	];

	assert.deepEqual(displayAgentMessages(messages), [{ role: "user", content: "用户消息", timestamp: 1 }]);
	assert.deepEqual(agentMessagesToTransfer(messages, "session"), [
		{
			id: "pie:session:0",
			role: "user",
			content: [{ type: "text", text: "用户消息" }],
			createdAt: 1,
		},
	]);
});

test("session transfer preserves the final assistant stop reason after a failed tool", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const messages: AgentMessage[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing.pdf" } }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "pdf worker missing" }],
			isError: true,
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "文档已生成。" }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "stop",
			timestamp: 3,
		},
	];

	const transcript = agentMessagesToTransfer(messages, "session");
	assert.equal(transcript[0]?.stopReason, "toolUse");
	assert.equal(transcript[1]?.stopReason, "stop");
	assert.deepEqual(transcript[0]?.content[0]?.state, {
		status: "error",
		input: { path: "missing.pdf" },
		output: "pdf worker missing",
	});

	const restored = transferToAgentMessages({
		schemaVersion: 1,
		source: { astronSessionId: "astron", coreId: "pie", sessionId: "session" },
		transcript,
	});
	assert.deepEqual(
		restored.filter((message) => message.role === "assistant").map((message) => message.stopReason),
		["toolUse", "stop"],
	);
});
