import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { createAgentFactory, createRuntime, type InteractionRequest, type SessionTransfer } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

test(
	"workspace junction changes preserve the running owner, permission reply and guidance",
	{ timeout: 10000 },
	async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pie-workspace-owner-"));
		const workspace = join(directory, "workspace");
		const target = join(directory, "target");
		await Promise.all([mkdir(workspace), mkdir(target)]);
		const toolDirectories: string[] = [];
		let completed = 0;
		const agents = createAgentFactory({
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
				create(toolContext) {
					toolDirectories.push(toolContext.directory);
					return [
						{
							name: "workspace_probe",
							label: "Workspace probe",
							description: "Wait for confirmation in the bound workspace",
							parameters: Type.Object({}),
							async execute(_id, _input, signal) {
								await toolContext.ask(
									{ type: "confirmation", title: "Workspace", message: "Continue in this workspace?" },
									signal,
								);
								completed++;
								return { content: [{ type: "text", text: "confirmed" }], details: {} };
							},
						},
					];
				},
			},
		});
		const runtime = await createRuntime({
			agents,
			store: createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory })),
			hostRuntimes: [
				{
					assistantId: "workspace-owner",
					assistantRevision: "1",
					runtime: { systemPrompt: "", toolIds: ["workspace_probe"], skills: [], subagents: [] },
				},
			],
		});
		context.after(async () => {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		});
		const session = await runtime.createSession({ assistantId: "workspace-owner", workspacePath: workspace });
		let requested = (_request: InteractionRequest) => {};
		const permission = new Promise<InteractionRequest>((resolve) => {
			requested = resolve;
		});
		await runtime.subscribe(session.id, (packet) => {
			if (packet.type === "interaction.requested" && packet.interaction) requested(packet.interaction);
		});
		const accepted = await runtime.submitTurn(session.id, { text: "调用工具 workspace_probe {}" });
		const request = await permission;
		await rmdir(workspace);
		await symlink(target, workspace, process.platform === "win32" ? "junction" : "dir");

		const running = await runtime.getSession(session.id);
		assert.equal(running.turn?.id, accepted.turnId);
		assert.equal(running.turn?.status, "running");
		assert.equal(running.execution.actions.submit.available, false);
		assert.equal(running.interactions[0]?.id, request.id);
		const transfer: SessionTransfer = {
			schemaVersion: 1,
			source: { astronSessionId: session.id, coreId: "pie", sessionId: session.id },
			workspacePath: target,
			transcript: [],
		};
		await assert.rejects(runtime.importSession(session.id, transfer), { status: 409 });
		assert.equal((await runtime.getSession(session.id)).workspacePath, workspace);
		const guidance = await runtime.steer(session.id, {
			turnId: accepted.turnId,
			text: "继续",
			requestId: "guidance",
		});
		assert.equal(guidance.accepted, true);
		assert.equal(guidance.turnId, accepted.turnId);
		await runtime.replyInteraction(session.id, request.id, { approved: true });
		const settled = await runtime.waitForTurn(session.id);
		assert.equal(completed, 1);
		assert.equal(settled.turn?.status, "completed");
		assert.equal(settled.execution.actions.submit.available, true);
		assert.deepEqual(toolDirectories, [workspace]);

		await runtime.importSession(session.id, transfer);
		await runtime.submitTurn(session.id, { text: "workspace updated" });
		assert.equal((await runtime.waitForTurn(session.id)).workspacePath, target);
		assert.deepEqual(toolDirectories, [workspace, target]);
	},
);
