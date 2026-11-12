import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, type Static, Type } from "@earendil-works/pi-ai";
import { createAgentFactory, createRuntime, type InteractionRequest } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

async function openRuntime(directory: string, agentDirectories: string[], rejectWorkspace?: () => string | undefined) {
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	return createRuntime({
		store: {
			...store,
			async saveSession(...args) {
				const rejectedWorkspace = rejectWorkspace?.();
				if (rejectedWorkspace !== undefined && rejectedWorkspace === args[0].workspacePath)
					throw new Error("workspace save failed");
				return store.saveSession(...args);
			},
		},
		agents: createAgentFactory({
			env: {},
			models: { current: { selected: undefined, models: createModels() } },
			skills: () => ({ tools: [], afterToolCall: async () => undefined }),
			mcp: {
				configure() {},
				status: () => ({ servers: {} }),
				acquire: async () => ({ tools: [], instructions: [], release() {} }),
				async close() {},
			},
			recordModelRequest: () => async () => undefined,
			tools: {
				catalog: [{ id: "workspace_probe", label: "Workspace probe" }],
				create(context) {
					agentDirectories.push(context.directory);
					const parameters = Type.Object({ text: Type.String(), confirm: Type.Optional(Type.Boolean()) });
					return [
						{
							name: "workspace_probe",
							label: "Workspace probe",
							description: "Write a file in the current workspace",
							parameters,
							async execute(_id, input, signal) {
								const args = input as Static<typeof parameters>;
								if (args.confirm)
									await context.ask({ type: "confirmation", title: "Probe", message: "Write?" }, signal);
								await writeFile(join(context.directory, "probe.txt"), args.text);
								return { content: [{ type: "text", text: args.text }], details: {} };
							},
						},
					];
				},
			},
		}),
		hostRuntimes: [
			{
				assistantId: "workspace",
				assistantRevision: "1",
				runtime: { systemPrompt: "", toolIds: ["workspace_probe"], skills: [], subagents: [] },
			},
		],
	});
}

test("explicit directory updates preserve history and affect subsequent turns before and after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-workspace-update-"));
	const source = join(directory, "source");
	const target = join(directory, "target");
	await Promise.all([mkdir(source), mkdir(target)]);
	const agentDirectories: string[] = [];
	let runtime = await openRuntime(directory, agentDirectories);
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "workspace", workspacePath: source });
	await runtime.submitTurn(session.id, { text: '调用工具 workspace_probe {"text":"before"}' });
	const before = await runtime.waitForTurn(session.id);
	assert.equal(before.turn?.status, "completed");
	assert.deepEqual(agentDirectories, [source]);

	const unchanged = await runtime.setSessionWorkspace(session.id, { workspacePath: source });
	assert.equal(unchanged.updatedAt, before.updatedAt);
	assert.deepEqual(agentDirectories, [source]);
	const updated = await runtime.setSessionWorkspace(session.id, { workspacePath: target });
	assert.equal(updated.workspacePath, target);
	assert.equal(updated.turn?.id, before.turn?.id);
	assert.deepEqual((await runtime.getSession(session.id)).messages, before.messages);
	await runtime.submitTurn(session.id, { text: '调用工具 workspace_probe {"text":"after"}' });
	const after = await runtime.waitForTurn(session.id);
	assert.equal(after.turn?.status, "completed");
	assert.equal(after.workspacePath, target);
	assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
	assert.equal(await readFile(join(source, "probe.txt"), "utf8"), "before");
	assert.equal(await readFile(join(target, "probe.txt"), "utf8"), "after");
	assert.deepEqual(agentDirectories, [source, target]);
	await runtime.close();
	runtime = await openRuntime(directory, agentDirectories);
	assert.equal((await runtime.getSession(session.id)).workspacePath, target);
	await runtime.submitTurn(session.id, { text: '调用工具 workspace_probe {"text":"restarted"}' });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(await readFile(join(target, "probe.txt"), "utf8"), "restarted");
});

test("a running turn rejects a directory change and permits same-directory verification", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-workspace-update-"));
	const source = join(directory, "source");
	const target = join(directory, "target");
	await Promise.all([mkdir(source), mkdir(target)]);
	const runtime = await openRuntime(directory, []);
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "workspace", workspacePath: source });
	let requested = (_request: InteractionRequest) => {};
	const permission = new Promise<InteractionRequest>((resolve) => {
		requested = resolve;
	});
	await runtime.subscribe(session.id, (packet) => {
		if (packet.type === "interaction.requested" && packet.interaction) requested(packet.interaction);
	});
	const accepted = await runtime.submitTurn(session.id, {
		text: '调用工具 workspace_probe {"text":"owner","confirm":true}',
	});
	const request = await permission;
	await assert.rejects(runtime.setSessionWorkspace(session.id, { workspacePath: target }), { status: 409 });
	assert.equal((await runtime.setSessionWorkspace(session.id, { workspacePath: source })).workspacePath, source);
	const running = await runtime.getSession(session.id);
	assert.equal(running.workspacePath, source);
	assert.equal(running.turn?.id, accepted.turnId);
	await runtime.replyInteraction(session.id, request.id, { approved: true });
	assert.equal((await runtime.waitForTurn(session.id)).turn?.status, "completed");
	assert.equal(await readFile(join(source, "probe.txt"), "utf8"), "owner");
});

test("explicit workspace updates reject invalid paths and roll back a failed durable save", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-workspace-update-"));
	const source = join(directory, "source");
	const target = join(directory, "target");
	await Promise.all([mkdir(source), mkdir(target)]);
	let rejectedWorkspace: string | undefined;
	let runtime = await openRuntime(directory, [], () => rejectedWorkspace);
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "workspace", workspacePath: source });
	await runtime.submitTurn(session.id, { text: "saved history" });
	const before = await runtime.waitForTurn(session.id);
	for (const workspacePath of [undefined, null, 1, "", " ", "bad\0path", "x".repeat(4097)])
		await assert.rejects(runtime.setSessionWorkspace(session.id, { workspacePath }), { status: 400 });
	rejectedWorkspace = target;
	await assert.rejects(runtime.setSessionWorkspace(session.id, { workspacePath: target }), { status: 503 });
	const failed = await runtime.getSession(session.id);
	assert.equal(failed.workspacePath, source);
	assert.deepEqual(failed.messages, before.messages);
	await runtime.close();
	runtime = await openRuntime(directory, []);
	const restored = await runtime.getSession(session.id);
	assert.equal(restored.workspacePath, source);
	assert.deepEqual(restored.messages, before.messages);
	await runtime.setSessionWorkspace(session.id, { workspacePath: target });
	assert.equal((await runtime.getSession(session.id)).workspacePath, target);
});
