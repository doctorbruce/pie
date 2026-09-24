import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentFactory } from "../src/agent.ts";
import type { Assistant, InteractionRequest, SessionEvent, SessionSnapshot, ToolInfo } from "../src/protocol.ts";
import { createCoreServer } from "../src/server.ts";

async function request(base: string, path: string, body?: unknown) {
	return fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function put(base: string, path: string, body: unknown) {
	return fetch(`${base}${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function submit(
	base: string,
	sessionId: string,
	text: string,
	onPacket?: (packet: SessionEvent) => void | Promise<void>,
) {
	const response = await fetch(`${base}/sessions/${sessionId}/events`, { signal: AbortSignal.timeout(15000) });
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const packets: SessionEvent[] = [];
	let buffer = "";
	try {
		assert.equal((await request(base, `/sessions/${sessionId}/turns`, { text })).status, 202);
		while (true) {
			const { value, done } = await reader.read();
			assert(!done, "events ended before turn settlement");
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith("data: ")) {
					const packet = JSON.parse(frame.slice(6)) as SessionEvent;
					packets.push(packet);
					await onPacket?.(packet);
					if (packet.type === "turn.settled") return { snapshot: packet.snapshot, packets };
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel();
	}
}

test("external Astron tool runs from a copied file through HTTP/SSE, isolation, errors, cancellation and restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie external tools "));
	const toolsDir = join(directory, "external tools");
	await mkdir(toolsDir);
	const toolPath = join(toolsDir, "memory-manage.ts");
	await copyFile(fileURLToPath(new URL("../../../examples/tools/memory-manage.ts", import.meta.url)), toolPath);
	const calls: { method?: string; url: string; body?: Record<string, unknown> }[] = [];
	let rejectMemory = false;
	let waitForCancel = false;
	let receivedRequest = () => {};
	const astron = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			calls.push({ method: req.method, url: req.url ?? "", body: text ? JSON.parse(text) : undefined });
			if (waitForCancel) {
				receivedRequest();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify(
					rejectMemory
						? { code: "MEMORY_REJECTED", reason: "sensitive test value" }
						: {
								code: "0000",
								data: {
									entries: [{ id: "entry/1", text: "fixture memory" }],
									written: true,
									deleted: true,
									entry: { id: "entry/1" },
								},
							},
				),
			);
		})().catch((error: Error) => res.destroy(error));
	});
	const cores: ReturnType<typeof createCoreServer>[] = [];
	t.after(async () => {
		for (const core of cores) await core.close();
		await new Promise<void>((resolve) => {
			astron.close(() => resolve());
			astron.closeAllConnections();
		});
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => astron.listen(0, "127.0.0.1", resolve));
	const address = astron.address();
	assert(address && typeof address !== "string");
	const env = {
		PI_DATA_DIR: join(directory, "data"),
		PI_TOOLS_DIR: toolsDir,
		ASTRON_RPA_ROUTE_PORT: String(address.port),
	};
	async function start() {
		const core = createCoreServer(env);
		cores.push(core);
		await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
		const address = core.server.address();
		assert(address && typeof address !== "string");
		return { core, base: `http://127.0.0.1:${address.port}` };
	}
	const first = await start();
	const catalog = (await (await request(first.base, "/tools")).json()) as { tools: ToolInfo[] };
	assert(catalog.tools.some((tool) => tool.id === "memory-manage"));
	assert(!JSON.stringify(catalog).includes("ASTRON_RPA_ROUTE_PORT"));
	const assistantInput = { name: "Astron tools", systemPrompt: "", toolIds: ["memory-manage"] };
	for (const toolIds of [["missing"], ["memory-manage", "memory-manage"]])
		assert.equal((await request(first.base, "/assistants", { ...assistantInput, toolIds })).status, 400);
	const assistantResponse = await request(first.base, "/assistants", assistantInput);
	assert.equal(assistantResponse.status, 201);
	const assistant = (await assistantResponse.json()) as Assistant;
	const sessions: SessionSnapshot[] = [];
	for (let i = 0; i < 2; i++) {
		const response = await request(first.base, "/sessions", { assistantId: assistant.id });
		assert.equal(response.status, 201, await response.clone().text());
		sessions.push((await response.json()) as SessionSnapshot);
	}
	assert.equal(calls.length, 0, "configuration must not execute tools");
	const loaded = await Promise.all(
		sessions.map((session) => submit(first.base, session.id, '调用工具 memory-manage {"action":"list"}')),
	);
	assert.deepEqual(
		new Set(calls.map((call) => new URL(call.url, first.base).searchParams.get("sessionId"))),
		new Set(sessions.map((session) => session.id)),
	);
	for (const [index, result] of loaded.entries()) {
		const tool = result.snapshot.messages.find((message) => message.role === "toolResult");
		assert(tool && !tool.isError);
		assert.match(JSON.stringify(tool.details), new RegExp(sessions[index].id));
		assert.match(JSON.stringify(tool.content), /fixture memory/);
		assert(result.packets.some((packet) => packet.event?.type === "tool_execution_update"));
		assert(result.packets.some((packet) => packet.event?.type === "tool_execution_end"));
		assert.deepEqual(result.snapshot.activities, [], "system tools do not invent skill/plugin activity");
	}
	const session = sessions[0];
	const added = await submit(
		first.base,
		session.id,
		'调用工具 memory-manage {"action":"add","scope":"user","topic":"preferences","text":"use Chinese"}',
	);
	assert.deepEqual(calls.at(-1)?.body, {
		scope: "user",
		topic: "preferences",
		text: "use Chinese",
		origin: "agent_tool",
		sourceSessionId: session.id,
	});
	assert.match(
		JSON.stringify(added.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)),
		/saved/,
	);
	await submit(first.base, session.id, '调用工具 memory-manage {"action":"delete","entryId":"entry/1"}');
	assert.equal(calls.at(-1)?.url, "/agent/memories/entries/entry%2F1");
	assert.equal(calls.at(-1)?.method, "DELETE");
	const beforeInvalid = calls.length;
	const invalid = await submit(first.base, session.id, '调用工具 memory-manage {"action":"invented"}');
	assert.equal(calls.length, beforeInvalid);
	assert(invalid.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)?.isError);
	const empty = (await (await request(first.base, "/sessions", {})).json()) as SessionSnapshot;
	const denied = await submit(first.base, empty.id, '调用工具 memory-manage {"action":"list"}');
	assert(denied.snapshot.messages.find((message) => message.role === "toolResult")?.isError);
	assert.equal(calls.length, beforeInvalid);
	rejectMemory = true;
	const failed = await submit(first.base, session.id, '调用工具 memory-manage {"action":"list"}');
	const failure = failed.snapshot.messages.filter((message) => message.role === "toolResult").at(-1);
	assert(failure?.isError);
	assert.match(JSON.stringify(failure.content), /MEMORY_REJECTED/);
	rejectMemory = false;
	waitForCancel = true;
	const started = new Promise<void>((resolve) => {
		receivedRequest = resolve;
	});
	const pending = submit(first.base, session.id, '调用工具 memory-manage {"action":"list"}');
	await started;
	const running = (await (await request(first.base, `/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.equal(
		(await request(first.base, `/sessions/${session.id}/cancel`, { turnId: running.turn?.id })).status,
		202,
	);
	const cancelled = await pending;
	assert.equal(cancelled.snapshot.turn?.status, "cancelled");
	assert(cancelled.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)?.isError);
	waitForCancel = false;
	await first.core.close();
	const second = await start();
	const restored = (await (await request(second.base, `/sessions/${session.id}`)).json()) as SessionSnapshot;
	assert.deepEqual(restored.messages, cancelled.snapshot.messages);
	assert.deepEqual(restored.runtime?.toolIds, ["memory-manage"]);
	await submit(second.base, session.id, '调用工具 memory-manage {"action":"list"}');
	assert.equal(new URL(calls.at(-1)!.url, second.base).searchParams.get("sessionId"), session.id);
	await second.core.close();
	await rm(toolPath);
	const third = await start();
	assert.equal((await request(third.base, `/sessions/${session.id}`)).status, 200);
	assert.equal((await request(third.base, `/sessions/${session.id}/turns`, { text: "continue" })).status, 400);
});

test("external tools can pause for confirmation, resume, reject and cancel through the session protocol", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-interactions-"));
	const toolsDir = join(directory, "tools");
	await mkdir(toolsDir);
	await writeFile(
		join(toolsDir, "confirm.mjs"),
		`export default ({ Type, ask }) => ({
        name: "confirm", label: "Confirm", description: "Ask for confirmation", parameters: Type.Object({}),
        async execute(_id, _params, signal) {
            await ask({ type: "confirmation", title: "确认测试操作", message: "是否继续？" }, signal);
            return { content: [{type: "text", text: "confirmed"}], details: undefined };
        }
    });`,
	);
	const core = createCoreServer({ PI_DATA_DIR: join(directory, "data"), PI_TOOLS_DIR: toolsDir });
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
	const address = core.server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const assistant = (await (
		await request(base, "/assistants", {
			name: "交互助手",
			systemPrompt: "",
			toolIds: ["confirm"],
		})
	).json()) as Assistant;
	const session = (await (await request(base, "/sessions", { assistantId: assistant.id })).json()) as SessionSnapshot;
	assert.deepEqual(session.interactions, []);
	let requestCount = 0;
	const approved = await submit(base, session.id, "调用工具 confirm {}", async (packet) => {
		if (packet.type !== "interaction.requested") return;
		requestCount++;
		assert(packet.interaction);
		const interaction = packet.interaction as InteractionRequest;
		const current = await request(base, `/sessions/${session.id}`);
		assert.equal(((await current.json()) as SessionSnapshot).interactions.length, 1);
		const response = await request(base, `/sessions/${session.id}/interactions/${interaction.id}`, {
			approved: true,
		});
		assert.equal(response.status, 202);
	});
	assert.equal(requestCount, 1);
	assert.equal(approved.snapshot.interactions.length, 0);
	assert.match(JSON.stringify(approved.snapshot.messages.at(-1)), /confirmed/);

	const rejected = await submit(base, session.id, "调用工具 confirm {}", async (packet) => {
		if (packet.type !== "interaction.requested") return;
		assert.equal(
			(await request(base, `/sessions/${session.id}/interactions/${packet.interaction!.id}`, { approved: false }))
				.status,
			202,
		);
	});
	assert.equal(rejected.snapshot.turn?.status, "completed");
	assert(rejected.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)?.isError);

	const cancelled = await submit(base, session.id, "调用工具 confirm {}", async (packet) => {
		if (packet.type !== "interaction.requested") return;
		assert.equal((await request(base, `/sessions/${session.id}/cancel`, { turnId: packet.turnId })).status, 202);
	});
	assert.equal(cancelled.snapshot.turn?.status, "cancelled");

	assert.equal(
		(
			await put(base, "/host-runtimes", {
				runtimes: [
					{
						assistantId: "star",
						assistantRevision: "1",
						runtime: {
							systemPrompt: "父助手",
							toolIds: [],
							skills: [],
							subagents: [
								{
									id: "assistant-worker-confirm",
									name: "确认助手",
									description: "执行需要确认的任务",
									assistantId: "confirm-assistant",
								},
							],
						},
					},
					{
						assistantId: "confirm-assistant",
						assistantRevision: "1",
						runtime: {
							systemPrompt: "确认后执行",
							toolIds: ["confirm"],
							skills: [],
							subagents: [],
						},
					},
				],
			})
		).status,
		200,
	);
	const parent = (await (await request(base, "/sessions", { assistantId: "star" })).json()) as SessionSnapshot;
	let childInteractionCount = 0;
	const delegated = await submit(
		base,
		parent.id,
		`调用工具 task ${JSON.stringify({
			description: "确认任务",
			prompt: "调用工具 confirm {}",
			subagent_type: "assistant-worker-confirm",
		})}`,
		async (packet) => {
			if (packet.type !== "interaction.requested") return;
			childInteractionCount++;
			assert.equal(packet.sessionId, parent.id);
			assert.equal(
				(await request(base, `/sessions/${parent.id}/interactions/${packet.interaction!.id}`, { approved: true }))
					.status,
				202,
			);
		},
	);
	assert.equal(childInteractionCount, 1);
	assert.equal(delegated.snapshot.turn?.status, "completed");
	const taskResult = [...delegated.snapshot.messages]
		.reverse()
		.find((message) => message.role === "toolResult" && message.toolName === "task");
	assert(taskResult?.role === "toolResult");
	const details = taskResult.details as { childSessionId: string };
	const child = (await (await request(base, `/sessions/${details.childSessionId}`)).json()) as SessionSnapshot;
	assert.equal(child.parentSessionId, parent.id);
	assert.equal(child.turn?.status, "completed");
	assert.deepEqual(child.interactions, []);
});

test("tool loading rejects duplicate IDs and invalid modules while ignoring helper files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tool-validation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const env = { PI_DATA_DIR: directory, PI_TOOLS_DIR: join(directory, "tools") };
	await mkdir(env.PI_TOOLS_DIR);
	await writeFile(join(env.PI_TOOLS_DIR, "_helper.ts"), 'throw new Error("helper is not an entry");');
	await writeFile(join(env.PI_TOOLS_DIR, "declaration.d.ts"), "export type Ignored = string;");
	const empty = createAgentFactory(env);
	assert.equal(empty.toolCatalog.length, 8);
	const duplicate = join(env.PI_TOOLS_DIR, "read.ts");
	await writeFile(duplicate, "export default () => ({});");
	assert.throws(() => createAgentFactory(env), /工具 ID 重复/);
	await rm(duplicate);
	const invalid = join(env.PI_TOOLS_DIR, "invalid.mjs");
	await writeFile(invalid, "export default {};");
	assert.throws(() => createAgentFactory(env), /ToolFactory/);
	await rm(invalid);
	const valid = join(env.PI_TOOLS_DIR, "external.mjs");
	await writeFile(
		valid,
		`export default ({Type, sessionId, directory}) => ({
        name: "external", label: "External", description: "External test", parameters: Type.Object({}),
        async execute() { return { content: [{type: "text", text: sessionId}], details: {directory} }; }
    });`,
	);
	const factory = createAgentFactory(env);
	const agent = factory.create("faux", "session-a", {
		systemPrompt: "",
		toolIds: ["external"],
		skills: [],
		subagents: [],
	});
	const result = await agent.state.tools[0].execute("call", {});
	assert.deepEqual(result, { content: [{ type: "text", text: "session-a" }], details: { directory: process.cwd() } });
	assert.throws(
		() =>
			factory.create("faux", "missing", {
				systemPrompt: "",
				toolIds: ["absent"],
				skills: [],
				subagents: [],
			}),
		/toolIds/,
	);
	await writeFile(join(env.PI_TOOLS_DIR, "external.ts"), "export default () => ({});");
	assert.throws(() => createAgentFactory(env), /工具 ID 重复/);
});
