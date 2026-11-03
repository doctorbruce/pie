import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
	createAgentFactory,
	createRuntime,
	type HostRuntimeDefinition,
	type InteractionReply,
	type InteractionRequest,
	type PermissionGrant,
	type PieRuntime,
	type RuntimeStore,
} from "@pie/runtime";
import type { ExternalTool } from "@pie/runtime/tools";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";

function permissionRequest(patterns: string[], permission: PermissionGrant["permission"] = "bash") {
	return {
		type: "confirmation" as const,
		title: "Permission probe",
		message: "Perform a scoped operation",
		metadata: { permission },
		remember: { permission, patterns },
	};
}

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-permission-grants-"));
	let runtime: PieRuntime | undefined;
	let store: RuntimeStore;
	context.after(async () => {
		await runtime?.close();
		await rm(directory, { recursive: true, force: true });
	});
	const state: {
		requests: Omit<InteractionRequest, "id">[];
		completed: number;
		cancelBeforeAsk: boolean;
	} = { requests: [permissionRequest(["git status"])], completed: 0, cancelBeforeAsk: false };
	const definition: HostRuntimeDefinition = {
		assistantId: "helper",
		assistantRevision: "1",
		runtime: { systemPrompt: "", toolIds: ["permission_probe"], skills: [], subagents: [] },
	};
	const requested: { sessionId: string; request: InteractionRequest }[] = [];
	let notify = () => {};
	async function open() {
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
				catalog: [{ id: "permission_probe", label: "Permission probe" }],
				create(toolContext) {
					const tool: ExternalTool = {
						name: "permission_probe",
						label: "Permission probe",
						description: "Request confirmation before recording an operation",
						parameters: Type.Object({}),
						async execute(_id, _input, signal) {
							if (state.cancelBeforeAsk) signal = AbortSignal.abort();
							await Promise.all(state.requests.map((request) => toolContext.ask(request, signal)));
							state.completed++;
							return { content: [{ type: "text", text: "operation completed" }], details: {} };
						},
					};
					return [tool];
				},
			},
		});
		store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
		runtime = await createRuntime({ agents, store, hostRuntimes: [definition] });
		runtime.subscribeAll((event) => {
			if (event.type !== "interaction.requested" || !event.interaction) return;
			requested.push({ sessionId: event.sessionId, request: event.interaction });
			notify();
		});
	}
	await open();
	return {
		state,
		definition,
		requested,
		get runtime() {
			assert(runtime);
			return runtime;
		},
		get store() {
			return store;
		},
		async restart() {
			await runtime!.close();
			await open();
		},
		async nextRequest() {
			while (requested.length === 0)
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			return requested.shift()!;
		},
	};
}

test(
	"once affects one request while remembered scopes survive Turns and runtime restarts",
	{ timeout: 10000 },
	async (context) => {
		const setup = await fixture(context);
		const session = await setup.runtime.createSession({ assistantId: "helper" });
		setup.state.requests = [permissionRequest(["git status"]), permissionRequest(["git status"])];
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		const first = await setup.nextRequest();
		const second = await setup.nextRequest();
		await setup.runtime.replyInteraction(session.id, first.request.id, { approved: true });
		assert.equal((await setup.runtime.getSession(session.id)).interactions.length, 1);
		await setup.runtime.replyInteraction(session.id, second.request.id, { approved: true });
		await setup.runtime.waitForTurn(session.id);
		assert.equal((await setup.store.readSession(session.id))?.permissionGrants, undefined);

		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		const remembered = await setup.nextRequest();
		await setup.nextRequest();
		await setup.runtime.replyInteraction(session.id, remembered.request.id, { approved: true, remember: true });
		assert.equal((await setup.runtime.getSession(session.id)).interactions.length, 0);
		assert.equal((await setup.runtime.waitForTurn(session.id)).turn?.status, "completed");
		assert.deepEqual((await setup.store.readSession(session.id))?.permissionGrants, [
			permissionRequest(["git status"]).remember,
		]);
		await setup.runtime.registerHostRuntimes([{ ...setup.definition, assistantRevision: "2" }]);
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		assert.equal((await setup.runtime.waitForTurn(session.id)).turn?.status, "completed");
		assert.equal(setup.requested.length, 0);
		await setup.restart();
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		assert.equal((await setup.runtime.waitForTurn(session.id)).turn?.status, "completed");
		assert.equal(setup.requested.length, 0);
		assert.equal(setup.state.completed, 4);

		const fork = await setup.runtime.forkSession(session.id, { beforeMessageId: null });
		assert.equal((await setup.store.readSession(fork.session.id))?.permissionGrants, undefined);
		setup.state.requests = [permissionRequest(["git status"])];
		const other = await setup.runtime.createSession({ assistantId: "helper" });
		await setup.runtime.submitTurn(other.id, { text: "调用工具 permission_probe {}" });
		const isolated = await setup.nextRequest();
		assert.equal(isolated.sessionId, other.id);
		await setup.runtime.replyInteraction(other.id, isolated.request.id, { approved: true });
		await setup.runtime.waitForTurn(other.id);
	},
);

test(
	"remembered permission patterns use literal matching and require all scoped resources",
	{ timeout: 10000 },
	async (context) => {
		const setup = await fixture(context);
		const session = await setup.runtime.createSession({ assistantId: "helper" });
		setup.state.requests = [permissionRequest(["git *"]), permissionRequest(["cwd:/workspace"])];
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		for (let index = 0; index < 2; index++) {
			const pending = await setup.nextRequest();
			await setup.runtime.replyInteraction(session.id, pending.request.id, { approved: true, remember: true });
		}
		await setup.runtime.waitForTurn(session.id);
		setup.state.requests = [permissionRequest(["git *", "cwd:/workspace"])];
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		await setup.runtime.waitForTurn(session.id);
		assert.equal(setup.requested.length, 0);
		for (const request of [
			permissionRequest(["git status", "cwd:/workspace"]),
			permissionRequest(["git *", "cwd:/other"]),
			permissionRequest(["git *"], "external_directory"),
		]) {
			setup.state.requests = [request];
			await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
			const pending = await setup.nextRequest();
			await setup.runtime.replyInteraction(session.id, pending.request.id, { approved: true });
			await setup.runtime.waitForTurn(session.id);
		}
		setup.state.requests = [permissionRequest(["git *"])];
		setup.state.cancelBeforeAsk = true;
		const completed = setup.state.completed;
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		await setup.runtime.waitForTurn(session.id);
		assert.equal(setup.state.completed, completed);
		assert.equal(setup.requested.length, 0);
	},
);

test(
	"a failed grant save does not release pending operations or retain an in-memory grant",
	{ timeout: 10000 },
	async (context) => {
		const setup = await fixture(context);
		const session = await setup.runtime.createSession({ assistantId: "helper" });
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		const pending = await setup.nextRequest();
		const save = setup.store.saveSession;
		setup.store.saveSession = async (...args) => {
			if (args[0].permissionGrants?.length) throw new Error("grant storage rejected");
			return save(...args);
		};
		await assert.rejects(
			setup.runtime.replyInteraction(session.id, pending.request.id, { approved: true, remember: true }),
			{ status: 503 },
		);
		assert.equal(setup.state.completed, 0);
		assert.equal((await setup.runtime.getSession(session.id)).interactions.length, 1);
		assert.equal((await setup.store.readSession(session.id))?.permissionGrants, undefined);
		assert.equal((await setup.runtime.listSessionMetadata())[0].permissionGrants, undefined);
		assert.equal(setup.runtime.storageAvailable, false);
	},
);

test("remembering requires a valid permission request and boolean consent", { timeout: 10000 }, async (context) => {
	const setup = await fixture(context);
	const session = await setup.runtime.createSession({ assistantId: "helper" });
	setup.state.requests = [{ type: "confirmation", title: "Business confirmation", message: "Confirm this operation" }];
	await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
	const pending = await setup.nextRequest();
	const invalid: InteractionReply = { approved: true, remember: true };
	Reflect.set(invalid, "remember", "true");
	for (const reply of [invalid, { approved: false, remember: true }, { approved: true, remember: true }]) {
		await assert.rejects(setup.runtime.replyInteraction(session.id, pending.request.id, reply), { status: 400 });
		assert.equal(setup.state.completed, 0);
		assert.equal((await setup.runtime.getSession(session.id)).interactions.length, 1);
	}
	await setup.runtime.replyInteraction(session.id, pending.request.id, { approved: true });
	await setup.runtime.waitForTurn(session.id);
	assert.equal((await setup.store.readSession(session.id))?.permissionGrants, undefined);
	for (const request of [
		{ ...permissionRequest(["git status"]), metadata: { permission: "credential" } },
		permissionRequest(Array.from({ length: 129 }, (_, index) => `scope:${index}`)),
		permissionRequest(["a".repeat(16385)]),
	]) {
		setup.state.requests = [request];
		await setup.runtime.submitTurn(session.id, { text: "调用工具 permission_probe {}" });
		await setup.runtime.waitForTurn(session.id);
		assert.equal(setup.state.completed, 1);
		assert.equal(setup.requested.length, 0);
	}
});
