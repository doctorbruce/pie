import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import { createAgentFactory } from "@pie/local/agent";
import { createRuntime } from "@pie/runtime";
import { BackgroundJobs } from "@pie/runtime/jobs";
import { withToolProgress } from "@pie/runtime/tool-progress";
import { createSqliteRuntimeStore, openStore } from "../../local/src/store.ts";
import { jobTools } from "../../local/src/tools/job.ts";

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function notificationRuntime(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-job-notifications-"));
	const factory = createAgentFactory({ PI_DATA_DIR: directory });
	const first = createAssistantMessageEventStream();
	let native!: NonNullable<Parameters<typeof factory.create>[9]>;
	let agent!: ReturnType<typeof factory.create>;
	let requests = 0;
	const runtime = await createRuntime({
		store: createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory })),
		agents: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				native = args[9]!;
				agent = factory.create(...args);
				agent.streamFunction = () => {
					if (++requests === 1) return first;
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("finished") });
					return stream;
				};
				return agent;
			},
		},
		hostRuntimes: [
			{
				assistantId: "assistant",
				assistantRevision: "1",
				runtime: { systemPrompt: "Test", toolIds: ["bash"], skills: [], subagents: [] },
			},
		],
	});
	context.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const session = await runtime.createSession({ assistantId: "assistant" });
	await runtime.submitTurn(session.id, { text: "Finish the work" });
	return {
		runtime,
		session,
		native,
		agent,
		get requests() {
			return requests;
		},
		respond(message: ReturnType<typeof fauxAssistantMessage>) {
			first.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		},
	};
}

test("terminal job_output removes queued receipts without removing other follow-ups", async (context) => {
	const host = await notificationRuntime(context);
	const ids: string[] = [];
	for (const failed of [false, true]) {
		const notified = deferred<void>();
		const job = host.native.jobs.start({
			ownerSessionId: host.session.id,
			type: "task",
			title: "Old screenshot",
			async run() {
				if (failed) throw new Error("render failed");
				return { output: "render finished" };
			},
			async onSettled(settled) {
				await host.native.notifyBackground!(`Receipt ${settled.id}`, settled.id);
				notified.resolve();
			},
		});
		ids.push(job.id);
		await notified.promise;
	}
	host.agent.followUp({ role: "user", content: "Keep this separate follow-up", timestamp: Date.now() });
	host.respond(
		fauxAssistantMessage(
			ids.map((job_id) => fauxToolCall("job_output", { job_id })),
			{ stopReason: "toolUse" },
		),
	);
	await host.runtime.waitForTurn(host.session.id);
	assert.equal(host.requests, 3);
	assert.equal(host.agent.state.messages.filter((message) => message.role === "user").length, 2);
	assert.doesNotMatch(JSON.stringify(host.agent.state.messages), /Receipt /);
});

test("late completion receipts do not wake a model after terminal job_output", async (context) => {
	const host = await notificationRuntime(context);
	const release = deferred<void>();
	const notified = deferred<void>();
	const job = host.native.jobs.start({
		ownerSessionId: host.session.id,
		type: "task",
		title: "Screenshot",
		async run() {
			return { output: "finished" };
		},
		async onSettled(settled) {
			await release.promise;
			await host.native.notifyBackground!(`Late receipt ${settled.id}`, settled.id);
			notified.resolve();
		},
	});
	await host.native.jobs.wait(job.id);
	host.respond(fauxAssistantMessage([fauxToolCall("job_output", { job_id: job.id })], { stopReason: "toolUse" }));
	await host.runtime.waitForTurn(host.session.id);
	release.resolve();
	await notified.promise;
	assert.equal(host.requests, 2);
	assert.equal(host.agent.state.messages.filter((message) => message.role === "user").length, 1);
});

test("unread completion receipts are delivered together in one follow-up model request", async (context) => {
	const host = await notificationRuntime(context);
	for (let index = 0; index < 3; index++) {
		const notified = deferred<void>();
		host.native.jobs.start({
			ownerSessionId: host.session.id,
			type: "task",
			title: "Unread result",
			async run() {
				return { output: "finished" };
			},
			async onSettled(settled) {
				await host.native.notifyBackground!(`Unread receipt ${settled.id}`, settled.id);
				notified.resolve();
			},
		});
		await notified.promise;
	}
	host.respond(fauxAssistantMessage("Initial answer"));
	await host.runtime.waitForTurn(host.session.id);
	assert.equal(host.requests, 2);
	assert.equal(host.agent.state.messages.filter((message) => message.role === "user").length, 4);
});

test("running job_output preserves the later completion notification", async (context) => {
	const host = await notificationRuntime(context);
	const completion = deferred<{ output: string }>();
	const notified = deferred<void>();
	const job = host.native.jobs.start({
		ownerSessionId: host.session.id,
		type: "task",
		title: "Still running",
		run: () => completion.promise,
		async onSettled(settled) {
			await host.native.notifyBackground!(`Real completion ${settled.id}`, settled.id);
			notified.resolve();
		},
	});
	host.respond(fauxAssistantMessage([fauxToolCall("job_output", { job_id: job.id })], { stopReason: "toolUse" }));
	await host.runtime.waitForTurn(host.session.id);
	assert.equal(host.requests, 2);
	completion.resolve({ output: "finished" });
	await notified.promise;
	assert.equal(host.requests, 3);
	assert.equal(host.agent.state.messages.filter((message) => message.role === "user").length, 2);
});

function tool(execute: AgentTool["execute"]): AgentTool {
	return {
		name: "slow",
		label: "Slow tool",
		description: "Wait for completion",
		parameters: Type.Object({}),
		execute,
	};
}

const finalResult: AgentToolResult<unknown> = {
	content: [{ type: "text", text: "final output" }],
	details: { done: true },
};

test("silent tools emit bounded heartbeats without refreshing the real activity clock", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const completion = deferred<AgentToolResult<unknown>>();
	const updates: AgentToolResult<unknown>[] = [];
	const execution = withToolProgress(tool(() => completion.promise)).execute("silent", {}, undefined, (update) => {
		updates.push(update);
	});
	context.mock.timers.tick(59_999);
	assert.equal(updates.length, 0);
	context.mock.timers.tick(1);
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0].details, {
		progress: {
			message: "仍在执行（已等待 60 秒，最近活动距今 60 秒）",
			elapsedMs: 60_000,
			quietMs: 60_000,
			lastActivityAt: 1000,
			health: "ok",
		},
	});
	context.mock.timers.tick(60_000);
	assert.deepEqual(updates[1].details, {
		progress: {
			message: "仍在执行（已等待 120 秒，最近活动距今 120 秒）",
			elapsedMs: 120_000,
			quietMs: 120_000,
			lastActivityAt: 1000,
			health: "quiet",
		},
	});
	completion.resolve(finalResult);
	assert.equal(await execution, finalResult);
	context.mock.timers.tick(180_000);
	assert.equal(updates.length, 2);
});

test("real updates retain their output and details while heartbeats track their activity", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const completion = deferred<AgentToolResult<unknown>>();
	let publish: AgentToolUpdateCallback<unknown> | undefined;
	const updates: AgentToolResult<unknown>[] = [];
	const wrapped = withToolProgress(
		tool((_id, _args, _signal, onUpdate) => {
			publish = onUpdate;
			return completion.promise;
		}),
	);
	const execution = wrapped.execute("active", {}, undefined, (update) => updates.push(update));
	context.mock.timers.tick(45_000);
	const partial: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "real output" }],
		details: { jobId: "job" },
	};
	assert(publish);
	publish(partial);
	assert.equal(updates[0], partial);
	context.mock.timers.tick(15_000);
	assert.equal(updates[1].content[0], partial.content[0]);
	assert.deepEqual(updates[1].details, {
		jobId: "job",
		progress: {
			message: "仍在执行（已等待 60 秒，最近活动距今 15 秒）",
			elapsedMs: 60_000,
			quietMs: 15_000,
			lastActivityAt: 46_000,
			health: "ok",
		},
	});
	assert.deepEqual(partial.details, { jobId: "job" });
	completion.resolve(finalResult);
	await execution;
	publish(partial);
	assert.equal(updates.length, 2);
});

test("cancellation stops heartbeats and late updates even when the tool ignores abort", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const completion = deferred<AgentToolResult<unknown>>();
	const controller = new AbortController();
	let publish: AgentToolUpdateCallback<unknown> | undefined;
	const updates: AgentToolResult<unknown>[] = [];
	const execution = withToolProgress(
		tool((_id, _args, signal, onUpdate) => {
			assert.equal(signal, controller.signal);
			publish = onUpdate;
			return completion.promise;
		}),
	).execute("cancel", {}, controller.signal, (update) => updates.push(update));
	context.mock.timers.tick(60_000);
	controller.abort();
	context.mock.timers.tick(180_000);
	assert(publish);
	publish(finalResult);
	assert.equal(updates.length, 1);
	completion.resolve(finalResult);
	await execution;
});

test("tool failures clear heartbeats and pre-aborted calls never execute", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const completion = deferred<AgentToolResult<unknown>>();
	const updates: AgentToolResult<unknown>[] = [];
	const execution = withToolProgress(tool(() => completion.promise)).execute("failure", {}, undefined, (update) => {
		updates.push(update);
	});
	context.mock.timers.tick(60_000);
	const rejected = assert.rejects(execution, /tool failed/);
	completion.reject(new Error("tool failed"));
	await rejected;
	context.mock.timers.tick(180_000);
	assert.equal(updates.length, 1);
	const execute = context.mock.fn(async () => finalResult);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(withToolProgress(tool(execute)).execute("aborted", {}, controller.signal), {
		name: "AbortError",
	});
	assert.equal(execute.mock.callCount(), 0);
});

test("concurrent calls keep separate heartbeat lifetimes and unobserved calls keep their result", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const first = deferred<AgentToolResult<unknown>>();
	const second = deferred<AgentToolResult<unknown>>();
	const wrapped = withToolProgress(tool((callId) => (callId === "first" ? first.promise : second.promise)));
	const updates: string[] = [];
	const firstRun = wrapped.execute("first", {}, undefined, () => updates.push("first"));
	const secondRun = wrapped.execute("second", {}, undefined, () => updates.push("second"));
	context.mock.timers.tick(60_000);
	assert.deepEqual(updates, ["first", "second"]);
	first.resolve(finalResult);
	await firstRun;
	context.mock.timers.tick(60_000);
	assert.deepEqual(updates, ["first", "second", "second"]);
	second.resolve(finalResult);
	await secondRun;
	assert.equal(await withToolProgress(tool(async () => finalResult)).execute("plain", {}), finalResult);
});

test("job_output cancels only the wait and releases its timeout without consuming output", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const clearTimer = context.mock.method(globalThis, "clearTimeout");
	const jobs = new BackgroundJobs();
	const completion = deferred<{ output: string }>();
	const job = jobs.start({
		ownerSessionId: "owner",
		type: "task",
		title: "Silent job",
		run: () => completion.promise,
	});
	const output = jobTools({ sessionId: "owner", directory: process.cwd(), jobs, ask: async () => {} })[0];
	assert.match(output.description, /without ending your turn/);
	assert.match(JSON.stringify(output.parameters), /wait in chunks.*30000/);
	const controller = new AbortController();
	const execution = output.execute("wait", { job_id: job.id, wait_ms: 300_000 }, controller.signal);
	controller.abort();
	await assert.rejects(execution, { name: "AbortError" });
	assert.equal(jobs.get(job.id)?.status, "running");
	assert.equal(clearTimer.mock.callCount(), 1);
	completion.resolve({ output: "final job output" });
	await jobs.wait(job.id);
	const result = await output.execute("read", { job_id: job.id });
	assert.match(JSON.stringify(result.content), /final job output/);
	const repeated = await output.execute("read-again", { job_id: job.id });
	assert.match(JSON.stringify(repeated.content), /no new output/);
});

for (const type of ["shell", "task"] as const) {
	test(`job_kill stops a background ${type} without a synthetic follow-up or extra model call`, async (context) => {
		const jobs = new BackgroundJobs();
		context.after(() => jobs.close());
		const provider = fauxProvider();
		const models = createModels();
		models.setProvider(provider.provider);
		const histories: Message[][] = [];
		const tools = jobTools({ sessionId: "owner", directory: process.cwd(), jobs, ask: async () => {} });
		const agent = new Agent({
			initialState: { tools, model: provider.getModel() },
			streamFn(model, request, options) {
				histories.push(structuredClone(request.messages));
				return models.streamSimple(model, request, options);
			},
		});
		const completion = deferred<{ output: string }>();
		const job = jobs.start({
			ownerSessionId: "owner",
			type,
			title: "Background work",
			run(signal, append) {
				append("partial job output");
				signal.addEventListener("abort", () => completion.reject(signal.reason), { once: true });
				return completion.promise;
			},
			onSettled(settled) {
				const content = [{ type: "text" as const, text: `Background job ${settled.status}`, synthetic: true }];
				agent.followUp({
					role: "user",
					content,
					timestamp: Date.now(),
				});
			},
		});
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("job_kill", { job_id: job.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopped the background job."),
			fauxAssistantMessage("Unexpected extra response to a cancellation notification."),
		]);

		await agent.prompt("Stop the background job");

		assert.equal(histories.length, 2);
		assert.equal(agent.state.messages.filter((message) => message.role === "user").length, 1);
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult");
		assert.match(JSON.stringify(result.details), /"status":"cancelled"/);
		assert.equal(jobs.get(job.id)?.status, "cancelled");
		const output = await tools[0].execute("read-cancelled", { job_id: job.id });
		assert.match(JSON.stringify(output.content), /partial job output/);
	});
}

test("job_kill keeps a late cancellation silent after its bounded wait expires", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const jobs = new BackgroundJobs();
	const completion = deferred<{ output: string }>();
	const notifications: string[] = [];
	const job = jobs.start({
		ownerSessionId: "owner",
		type: "task",
		title: "Slow cancellation",
		run: () => completion.promise,
		onSettled(settled) {
			notifications.push(settled.status);
		},
	});
	const kill = jobTools({ sessionId: "owner", directory: process.cwd(), jobs, ask: async () => {} })[1];
	const execution = kill.execute("stop", { job_id: job.id });
	context.mock.timers.tick(5_000);
	const result = await execution;
	assert.match(JSON.stringify(result.details), /"status":"running"/);
	completion.resolve({ output: "late output" });
	assert.equal((await jobs.wait(job.id))?.status, "cancelled");
	assert.deepEqual(notifications, []);
});

test("background completion, failure, and ordinary cancellation still notify", async () => {
	const jobs = new BackgroundJobs();
	const notifications: string[] = [];
	for (const status of ["completed", "failed", "cancelled"] as const) {
		const completion = deferred<{ output: string }>();
		const job = jobs.start({
			ownerSessionId: "owner",
			type: "task",
			title: status,
			run: () => completion.promise,
			onSettled(settled) {
				notifications.push(settled.status);
			},
		});
		if (status === "cancelled") jobs.cancel(job.id);
		if (status === "failed") completion.reject(new Error("job failed"));
		else completion.resolve({ output: "job output" });
		assert.equal((await jobs.wait(job.id))?.status, status);
	}
	assert.deepEqual(notifications, ["completed", "failed", "cancelled"]);
});

test("bounded job waits release timeout handles on completion and return running jobs on timeout", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const clearTimer = context.mock.method(globalThis, "clearTimeout");
	const jobs = new BackgroundJobs();
	const completion = deferred<{ output: string }>();
	const job = jobs.start({
		ownerSessionId: "owner",
		type: "task",
		title: "Silent job",
		run: () => completion.promise,
	});
	const bounded = jobs.wait(job.id, 30_000);
	context.mock.timers.tick(30_000);
	assert.equal((await bounded)?.status, "running");
	assert.equal(clearTimer.mock.callCount(), 1);
	const settled = jobs.wait(job.id, 300_000);
	completion.resolve({ output: "done" });
	assert.equal((await settled)?.status, "completed");
	assert.equal(clearTimer.mock.callCount(), 2);
});

test("factory job heartbeats reach Agent events but never model requests or final tool results", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tool-progress-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
	const jobs = new BackgroundJobs();
	const completion = deferred<{ output: string }>();
	const waiting = deferred<void>();
	context.after(() => completion.resolve({ output: "cleanup" }));
	const job = jobs.start({
		ownerSessionId: "owner",
		type: "task",
		title: "Silent job",
		run: () => completion.promise,
	});
	const originalWait = jobs.wait.bind(jobs);
	context.mock.method(jobs, "wait", (id: string, waitMs?: number, signal?: AbortSignal) => {
		waiting.resolve();
		return originalWait(id, waitMs, signal);
	});
	const configured = createAgentFactory({ PI_DATA_DIR: directory }).create(
		"faux",
		"owner",
		{ systemPrompt: "", toolIds: ["bash"], skills: [], subagents: [] },
		undefined,
		[],
		undefined,
		undefined,
		undefined,
		undefined,
		{ directory, jobs },
	);
	const provider = fauxProvider();
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("job_output", { job_id: job.id, wait_ms: 300_000 })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("finished"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const histories: Message[][] = [];
	const agent = new Agent({
		initialState: { tools: configured.state.tools, model: provider.getModel() },
		streamFn(model, request, options) {
			histories.push(structuredClone(request.messages));
			return models.streamSimple(model, request, options);
		},
	});
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	const execution = agent.prompt("Wait for the job");
	await waiting.promise;
	context.mock.timers.tick(60_000);
	assert(events.some((event) => event.type === "tool_execution_update"));
	assert.equal(histories.length, 1);
	assert.equal(
		agent.state.messages.some((message) => message.role === "toolResult"),
		false,
	);
	completion.resolve({ output: "final job output" });
	await execution;
	assert.equal(histories.length, 2);
	assert.doesNotMatch(JSON.stringify(histories), /仍在执行|quietMs/);
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert(result?.role === "toolResult");
	assert.match(JSON.stringify(result.content), /final job output/);
	assert.doesNotMatch(JSON.stringify(result), /仍在执行|quietMs/);
	const updateCount = events.filter((event) => event.type === "tool_execution_update").length;
	context.mock.timers.tick(180_000);
	assert.equal(events.filter((event) => event.type === "tool_execution_update").length, updateCount);
});
