import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/local/agent";
import { checkpointMessage } from "@pie/runtime/compaction";
import type { Assistant, ContextCompaction, SessionSnapshot, SessionTransfer } from "@pie/runtime/protocol";
import type { SavedSession } from "@pie/runtime/runtime-store";
import { openStore } from "../../local/src/store.ts";
import { createCoreServer } from "../src/server.ts";

test("checkpoint tool exposure survives factory and MCP rebuilding without restoring cold discovery messages", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-working-tools-"));
	const toolsDirectory = join(directory, "tools");
	await mkdir(toolsDirectory);
	for (const name of ["mail", "weather"])
		await writeFile(
			join(toolsDirectory, `${name}.mjs`),
			`export default ({ Type }) => ({ name: "${name}", label: "${name}", description: "${name}", exposure: "deferred", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } });`,
		);
	const factory = createAgentFactory({ PI_DATA_DIR: directory, PI_TOOLS_DIR: toolsDirectory });
	context.after(async () => {
		await factory.mcp.close();
		await rm(directory, { recursive: true, force: true });
	});
	const checkpoint: ContextCompaction = {
		summary: "checkpoint",
		firstKeptMessage: 10,
		tokensBefore: 100,
		estimatedTokensAfter: 10,
		compactedAt: 1,
		generation: 1,
		loadedToolNames: ["mail", "disabled"],
	};
	for (const toolIds of [["mail", "weather"], ["weather"]]) {
		const agent = factory.create(
			"faux",
			"restored",
			{ systemPrompt: "", toolIds, skills: [], subagents: [] },
			undefined,
			[checkpointMessage(checkpoint)],
			() => {},
			async () => {},
			undefined,
			{ current: checkpoint, update: () => assert.fail("faux must not compact") },
		);
		const release = await agent.prepareMcp();
		try {
			await agent.prompt("show available tools");
			const text = contentText(agent.state.messages.at(-1)!.content);
			assert.equal(text.includes("mail"), toolIds.includes("mail"));
			assert(!text.includes("weather") && !text.includes("disabled"));
		} finally {
			release();
		}
	}
});

test("a running tool chain releases pruned results before the next provider response finishes", async () => {
	const current: AgentMessage = { role: "user", content: "current", timestamp: 1 };
	let calls = 0;
	let ended: AgentMessage[] = [];
	const agent = new Agent({
		initialState: {
			messages: [current],
			tools: [
				{
					name: "read",
					label: "read",
					description: "read",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "x".repeat(10000) }], details: {} };
					},
				},
			],
		},
		streamFn: async (_model, request) => {
			calls++;
			if (calls === 3) {
				const released = agent.state.messages.slice(1, 3).map((message) => new WeakRef(message));
				const kept = [current, ...agent.state.messages.slice(-2)];
				agent.replaceMessages(kept);
				request.messages.length = 0;
				for (const message of kept) request.messages.push(message);
				if (global.gc) {
					for (let attempt = 0; attempt < 5; attempt++) {
						await delay(0);
						global.gc();
					}
					assert(
						released.every((reference) => reference.deref() === undefined),
						"running loop retains pruned tool messages",
					);
				}
			}
			const output = createAssistantMessageEventStream();
			const message =
				calls < 3
					? fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
			output.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			return output;
		},
	});
	agent.subscribe((event) => {
		if (event.type === "agent_end") ended = event.messages;
	});
	await agent.continue();
	assert.equal(agent.state.errorMessage, undefined);
	assert.equal(calls, 3);
	assert.equal(agent.state.messages.length, 4);
	assert.equal(ended.length, 3);
});

test("working path reads only checkpoint boundaries and recent bodies; checkpoint commits are atomic", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-working-store-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	let store = openStore({ PI_DATA_DIR: directory });
	const saved: SavedSession = {
		id: "session",
		kind: "root",
		assistantId: "assistant",
		runtimeSource: "local",
		title: "test",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		messages: Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `body-${index}`, timestamp: index })),
	};
	store.saveSession(saved);
	const ids = store.readPathIds(saved.id);
	const checkpoint: ContextCompaction = {
		summary: "checkpoint",
		firstKeptMessage: 6,
		firstKeptEntryId: ids[6],
		turnStartEntryId: ids[4],
		turnStartIndex: 4,
		workingMessageCount: 4,
		messageCount: 8,
		tokensBefore: 100,
		estimatedTokensAfter: 10,
		compactedAt: 10,
		generation: 1,
	};
	store.close();
	const db = new DatabaseSync(join(directory, "agent.sqlite"));
	db.prepare("UPDATE session_entries SET payload = 'unreadable cold body' WHERE id = ?").run(ids[0]);
	db.exec(
		"CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON sessions WHEN json_extract(NEW.payload, '$.compaction') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END;",
	);
	db.close();
	store = openStore({ PI_DATA_DIR: directory });
	try {
		const tree = {
			leafId: "pending",
			nodes: [{ id: "pending", parentId: ids[7], message: { role: "user" as const, content: "new", timestamp: 9 } }],
		};
		assert.throws(
			() => store.saveSession({ ...saved, revision: 2, tree, compaction: checkpoint }),
			/checkpoint failure/,
		);
		assert.equal(tree.nodes[0].id, "pending");
		assert.deepEqual(store.readPathIds(saved.id), ids);
		assert.equal(store.sessions[0].compaction, undefined);
		assert.deepEqual(
			store.readWorkingPath(saved.id, checkpoint).nodes.map((node) => node.id),
			[ids[4], ids[6], ids[7]],
		);
		assert.throws(() => store.readPath(saved.id), /JSON/);
		assert.throws(
			() => store.readWorkingPath(saved.id, { ...checkpoint, firstKeptEntryId: "other-branch" }),
			/当前分支/,
		);
	} finally {
		store.close();
	}
});

// Regression for upstream #6841: compaction must release full historical bodies, not just project requests.
test("compressed sessions release old message objects and retain disk-backed forks, exports and restart history", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-working-server-"));
	const removed: WeakRef<AgentMessage>[] = [];
	const originalReplace = Agent.prototype.replaceMessages;
	const replacement = context.mock.method(
		Agent.prototype,
		"replaceMessages",
		function (this: Agent, messages: AgentMessage[]) {
			for (const message of this.state.messages) {
				if (!messages.includes(message)) removed.push(new WeakRef(message));
			}
			originalReplace.call(this, messages);
			assert(this.state.messages.length < 8);
		},
	);
	const requests: { summary: boolean; body: string }[] = [];
	const endpoint = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString();
			const summary = body.includes("You are a context summarization assistant");
			requests.push({ summary, body });
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "tiny", choices: [{ index: 0, delta: { content: summary ? "checkpoint" : "reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointAddress = endpoint.address();
	assert(endpointAddress && typeof endpointAddress !== "string");
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
					apiKey: "fixture",
					models: [{ id: "tiny", contextWindow: 600, maxTokens: 128 }],
				},
			},
			defaultModel: { provider: "local", id: "tiny" },
		}),
	);
	let core = createCoreServer({ PI_DATA_DIR: directory });
	context.after(async () => {
		await core.close();
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	async function listen() {
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let base = await listen();
	async function post(path: string, body: unknown) {
		return fetch(base + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}
	const assistant = (await (
		await post("/assistants", { name: "test", systemPrompt: "", toolIds: [] })
	).json()) as Assistant;
	const created = await post("/sessions", { mode: "real", assistantId: assistant.id });
	assert.equal(created.status, 201);
	const session = (await created.json()) as SessionSnapshot;
	async function submit(text: string) {
		assert.equal((await post(`/sessions/${session.id}/turns`, { text })).status, 202);
		for (let attempt = 0; attempt < 300; attempt++) {
			const result = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as SessionSnapshot;
			if (result.turn?.status !== "running") {
				assert.equal(result.turn?.status, "completed");
				return result;
			}
			await delay(10);
		}
		assert.fail("turn did not settle");
	}
	let snapshot = session;
	for (let index = 0; index < 7; index++) snapshot = await submit(`turn-${index}-${"x".repeat(700)}`);
	assert.equal(snapshot.messages.length, 14);
	assert((snapshot.compaction?.generation ?? 0) >= 3);
	assert(removed.length > 0);
	replacement.mock.resetCalls();
	if (global.gc) {
		for (let attempt = 0; attempt < 5; attempt++) {
			await delay(0);
			global.gc();
		}
		assert(
			removed.every((reference) => reference.deref() === undefined),
			"cold message objects remain strongly referenced",
		);
	} else context.diagnostic("GC assertion requires --expose-gc; reference replacement still verified");
	const transfer = (await (await fetch(`${base}/sessions/${session.id}/export`)).json()) as SessionTransfer;
	assert.equal(transfer.transcript.length, 14);
	assert.equal(transfer.transcript[0].content[0].type, "text");
	assert(!JSON.stringify(transfer.transcript).includes("context-checkpoint"));
	const forkResponse = await post(`/sessions/${session.id}/fork`, { messageIndex: 2 });
	assert.equal(forkResponse.status, 201);
	const fork = (await forkResponse.json()) as { session: SessionSnapshot };
	assert.deepEqual(fork.session.messages, snapshot.messages.slice(0, 2));
	const tree = (await (await fetch(`${base}/sessions/${session.id}/tree`)).json()) as { entries: { id: string }[] };
	assert.equal(tree.entries.length, 14);
	await core.close();
	const db = new DatabaseSync(join(directory, "agent.sqlite"));
	const metadata = JSON.parse(
		String(db.prepare("SELECT payload FROM sessions WHERE id = ?").get(session.id)!.payload),
	);
	assert(!("messages" in metadata) && !("tree" in metadata));
	assert.equal(
		db.prepare("SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?").get(session.id)!.count,
		14,
	);
	db.close();
	core = createCoreServer({ PI_DATA_DIR: directory });
	base = await listen();
	const restored = (await (await fetch(`${base}/sessions/${session.id}/export`)).json()) as SessionTransfer;
	assert.deepEqual(restored.transcript, transfer.transcript);
	const resumed = await submit(`turn-7-${"x".repeat(700)}`);
	assert.equal(resumed.messages.length, 16);
	assert(
		requests
			.filter((request) => request.summary)
			.at(-1)
			?.body.includes("<previous-summary>"),
	);
	const oldBranch = await post(`/sessions/${session.id}/tree`, { entryId: tree.entries[2].id });
	assert.equal(oldBranch.status, 200);
	const selected = (await oldBranch.json()) as { session: SessionSnapshot };
	assert.equal(selected.session.messages.length, 2);
	assert.equal(selected.session.compaction, undefined);
	const alternate = await submit("alternate branch");
	assert.equal(alternate.messages.length, 4);
	const restoredBranch = await post(`/sessions/${session.id}/tree`, { entryId: tree.entries[13].id });
	assert.equal(restoredBranch.status, 200);
	const original = (await restoredBranch.json()) as { session: SessionSnapshot };
	assert.deepEqual(original.session.messages, snapshot.messages);
});
