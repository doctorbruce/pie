import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAgentFactory, createSqliteRuntimeStore, openStore } from "@pie/local";
import { createRuntime } from "@pie/runtime";
import type { BackgroundJobs } from "@pie/runtime/jobs";

async function until(read: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (await read()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for background work");
}

function call(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-background-cancel-"));
	const script = join(directory, "work.cjs");
	await writeFile(
		script,
		'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);',
	);
	const command = (pidPath: string) =>
		`${process.platform === "win32" ? "& " : ""}'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${pidPath.replaceAll("'", "'\\''")}'`;
	const plans = new Map<string, AssistantMessage[]>();
	const waiting = new Set<string>();
	const requests = new Map<string, number>();
	let jobs: BackgroundJobs | undefined;
	const factory = createAgentFactory({ PI_DATA_DIR: directory, PI_TOOL_STREAM_TRACE: "0" });
	const store = createSqliteRuntimeStore(openStore({ PI_DATA_DIR: directory }));
	const runtime = await createRuntime({
		store,
		agents: {
			...factory,
			create(...args: Parameters<typeof factory.create>) {
				const agent = factory.create(...args);
				const id = args[1];
				jobs = args[8]?.jobs;
				agent.streamFunction = (_model, _context, options) => {
					requests.set(id, (requests.get(id) ?? 0) + 1);
					const stream = createAssistantMessageEventStream();
					const message = plans.get(id)?.shift();
					if (message) {
						assert(message.stopReason === "toolUse" || message.stopReason === "stop");
						stream.push({ type: "done", reason: message.stopReason, message });
					} else {
						waiting.add(id);
						const abort = () =>
							stream.push({
								type: "error",
								reason: "aborted",
								error: fauxAssistantMessage("", { stopReason: "aborted" }),
							});
						if (options?.signal?.aborted) abort();
						else options?.signal?.addEventListener("abort", abort, { once: true });
					}
					return stream;
				};
				return agent;
			},
		},
		hostRuntimes: [
			{
				assistantId: "parent",
				assistantRevision: "1",
				runtime: {
					systemPrompt: "parent",
					toolIds: ["bash"],
					skills: [],
					subagents: [],
					permissions: { "*": "allow" },
				},
			},
		],
	});
	context.after(async () => {
		await runtime.close();
		await Promise.all(jobs?.list().map((job) => jobs!.wait(job.id)) ?? []);
		await rm(directory, { recursive: true, force: true });
	});
	async function pid(path: string) {
		await until(async () =>
			readFile(path, "utf8").then(
				() => true,
				() => false,
			),
		);
		return Number(await readFile(path, "utf8"));
	}
	return { runtime, directory, command, plans, waiting, requests, pid };
}

test(
	"cancelling an active Turn stops its detached shell before settlement without waking the model",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const pidPath = join(host.directory, "shell.pid");
		host.plans.set(session.id, [call("bash", { command: host.command(pidPath), yieldMs: 1 })]);
		const turn = await host.runtime.submitTurn(session.id, { text: "start shell" });
		await until(async () => host.waiting.has(session.id));
		const processId = await host.pid(pidPath);
		await host.runtime.cancelTurn(session.id, { turnId: turn.turnId });
		const settled = await host.runtime.waitForTurn(session.id);
		assert.equal(settled.turn?.status, "cancelled");
		assert.equal((await host.runtime.listBackgroundJobs(session.id)).jobs[0].status, "cancelled");
		assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
		assert.equal((await host.runtime.getSession(session.id)).turn?.id, turn.turnId);
		assert.equal(host.requests.get(session.id), 2);
		assert.equal((await host.runtime.cancelTurn(session.id, { turnId: turn.turnId })).accepted, false);
	},
);

test(
	"normal completion preserves jobs and cancelling a later Turn leaves earlier and other-session jobs alive",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const oldPidPath = join(host.directory, "old.pid");
		host.plans.set(session.id, [
			call("bash", { command: host.command(oldPidPath), yieldMs: 0 }),
			fauxAssistantMessage("done"),
		]);
		const oldTurn = await host.runtime.submitTurn(session.id, { text: "old shell" });
		assert.equal((await host.runtime.waitForTurn(session.id)).turn?.status, "completed");
		const oldPid = await host.pid(oldPidPath);
		assert.equal((await host.runtime.listBackgroundJobs(session.id)).jobs[0].status, "running");
		const other = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const otherPidPath = join(host.directory, "other.pid");
		host.plans.set(other.id, [
			call("bash", { command: host.command(otherPidPath), yieldMs: 0 }),
			fauxAssistantMessage("done"),
		]);
		await host.runtime.submitTurn(other.id, { text: "other shell" });
		await host.runtime.waitForTurn(other.id);
		const otherPid = await host.pid(otherPidPath);
		const newPidPath = join(host.directory, "new.pid");
		host.plans.set(session.id, [call("bash", { command: host.command(newPidPath), yieldMs: 0 })]);
		const current = await host.runtime.submitTurn(session.id, { text: "new shell" });
		await until(async () => host.waiting.has(session.id));
		const newPid = await host.pid(newPidPath);
		await assert.rejects(host.runtime.cancelTurn(session.id, { turnId: oldTurn.turnId }), { status: 409 });
		assert.doesNotThrow(() => process.kill(newPid, 0));
		await host.runtime.cancelTurn(session.id, { turnId: current.turnId });
		await host.runtime.waitForTurn(session.id);
		const jobs = (await host.runtime.listBackgroundJobs(session.id)).jobs;
		assert.deepEqual(
			jobs.map((job) => job.status),
			["running", "cancelled"],
		);
		assert.throws(() => process.kill(newPid, 0), { code: "ESRCH" });
		assert.doesNotThrow(() => process.kill(oldPid, 0));
		assert.doesNotThrow(() => process.kill(otherPid, 0));
	},
);

test(
	"host stop cleans up a completed Turn's shell without cancelling another session or waking the model",
	{ timeout: 15000 },
	async (context) => {
		const host = await fixture(context);
		const session = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const other = await host.runtime.createSession({ assistantId: "parent", workspacePath: host.directory });
		const pidPath = join(host.directory, "stopped.pid");
		const otherPidPath = join(host.directory, "preserved.pid");
		for (const [owner, path] of [
			[session, pidPath],
			[other, otherPidPath],
		] as const) {
			host.plans.set(owner.id, [
				call("bash", { command: host.command(path), yieldMs: 0 }),
				fauxAssistantMessage("done"),
			]);
			await host.runtime.submitTurn(owner.id, { text: "start shell" });
			assert.equal((await host.runtime.waitForTurn(owner.id)).turn?.status, "completed");
		}
		const processId = await host.pid(pidPath);
		const otherPid = await host.pid(otherPidPath);
		const observed = await host.runtime.listBackgroundJobs(session.id);
		const receipt = await host.runtime.cancelBackgroundJob(session.id, {
			instanceId: observed.instanceId,
			jobId: observed.jobs[0].id,
			executionId: observed.jobs[0].executionId,
		});
		assert.equal(receipt.job.status, "cancelled");
		assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
		assert.doesNotThrow(() => process.kill(otherPid, 0));
		assert.equal((await host.runtime.getSession(session.id)).turn?.status, "completed");
		assert.equal(host.requests.get(session.id), 2);
	},
);
