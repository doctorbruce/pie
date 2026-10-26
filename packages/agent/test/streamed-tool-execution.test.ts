import { setTimeout as delay } from "node:timers/promises";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	cleanups.push(resolve);
	return { promise, resolve };
}

function tool(execute: AgentTool["execute"], name = "action", sequential = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ text: Type.String() }),
		execute,
		...(sequential ? { executionMode: "sequential" as const } : {}),
	};
}

function run(tools: AgentTool[], hooks: Pick<Agent, "beforeToolCall" | "afterToolCall"> = {}) {
	const stream = createAssistantMessageEventStream();
	const message = fauxAssistantMessage([], { stopReason: "pending" });
	const events: AgentEvent[] = [];
	const requests: Context[] = [];
	let finished = false;
	const finish = (stopReason: AssistantMessage["stopReason"] = "toolUse") => {
		if (finished) return;
		finished = true;
		message.stopReason = stopReason;
		if (stopReason === "error" || stopReason === "aborted")
			stream.push({ type: "error", reason: stopReason, error: structuredClone(message) });
		else if (stopReason !== "pending")
			stream.push({ type: "done", reason: stopReason, message: structuredClone(message) });
	};
	const agent = new Agent({
		...hooks,
		initialState: { model: fauxProvider().getModel(), tools },
		streamFn(_model, context, options) {
			requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
			if (requests.length === 1) {
				options?.signal?.addEventListener("abort", () => finish("aborted"), { once: true });
				return stream;
			}
			const next = createAssistantMessageEventStream();
			const result = fauxAssistantMessage("done");
			next.push({ type: "start", partial: result });
			next.push({ type: "done", reason: "stop", message: result });
			return next;
		},
	});
	agent.subscribe((event) => {
		events.push(event);
	});
	const pending = agent.prompt("execute");
	stream.push({ type: "start", partial: structuredClone(message) });
	const call = (id: string, raw: string, name = "action", args?: Record<string, unknown>, end = true) => {
		const toolCall = fauxToolCall(name, args ?? JSON.parse(raw), { id });
		const index = message.content.length;
		message.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: index, partial: structuredClone(message) });
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: raw, partial: structuredClone(message) });
		if (end) stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: structuredClone(message) });
	};
	cleanups.push(async () => {
		agent.abort();
		finish("aborted");
		await pending;
	});
	return { agent, message, events, requests, pending, call, finish };
}

describe("streamed tool execution", () => {
	it("starts before response completion but waits for both response and tool before the next request", async () => {
		const started = gate();
		const release = gate();
		let executions = 0;
		const current = run([
			tool(async () => {
				executions++;
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "result" }], details: {} };
			}),
		]);
		current.call("first", '{"text":"first"}');
		await started.promise;
		expect(current.requests).toHaveLength(1);
		expect(current.events.some((event) => event.type === "message_end" && event.message.role === "assistant")).toBe(
			false,
		);
		current.finish();
		await expect.poll(() => current.agent.state.streamingMessage).toBeUndefined();
		expect(current.requests).toHaveLength(1);
		release.resolve();
		await current.pending;
		expect(executions).toBe(1);
		expect(current.requests).toHaveLength(2);
		expect(current.requests[1].messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("does not execute repaired JSON or argument fragments after a length cutoff", async () => {
		let executions = 0;
		const current = run([
			tool(async () => {
				executions++;
				return { content: [], details: {} };
			}),
		]);
		current.call("repaired", '{"text":"unfinished', "action", { text: "unfinished" });
		current.call("fragment", '{"text":"complete JSON"}', "action", undefined, false);
		current.finish("length");
		await current.pending;
		expect(executions).toBe(0);
		const results = current.requests[1].messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every((message) => message.isError)).toBe(true);
	});

	it("keeps a completed call's result when later arguments are truncated", async () => {
		const started = gate();
		const release = gate();
		const effects: string[] = [];
		const current = run([
			tool(async (id) => {
				effects.push(id);
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: id }], details: {} };
			}),
		]);
		current.call("first", '{"text":"first"}');
		await started.promise;
		current.call("broken", '{"text":"broken', "action", { text: "broken" });
		current.finish("length");
		release.resolve();
		await current.pending;
		expect(effects).toEqual(["first"]);
		const results = current.requests[1].messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => [message.toolCallId, message.isError])).toEqual([
			["first", false],
			["broken", true],
		]);
	});

	it("preserves source result order while remaining parallel tools finish out of order", async () => {
		const firstStarted = gate();
		const release = gate();
		const secondFinished = gate();
		const calls: string[] = [];
		const current = run([
			tool(async (id) => {
				calls.push(id);
				if (id === "first") {
					firstStarted.resolve();
					await release.promise;
				} else secondFinished.resolve();
				return { content: [{ type: "text", text: id }], details: {} };
			}),
		]);
		current.call("first", '{"text":"first"}');
		await firstStarted.promise;
		current.call("second", '{"text":"second"}');
		current.finish();
		await secondFinished.promise;
		expect(current.requests).toHaveLength(1);
		release.resolve();
		await current.pending;
		expect(calls).toEqual(["first", "second"]);
		expect(
			current.requests[1].messages
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual(["first", "second"]);
	});

	it("keeps the entire batch sequential when a later tool requires it", async () => {
		const firstStarted = gate();
		const release = gate();
		const calls: string[] = [];
		const execute: AgentTool["execute"] = async (id) => {
			calls.push(id);
			if (id === "first") {
				firstStarted.resolve();
				await release.promise;
			}
			return { content: [], details: {} };
		};
		const current = run([tool(execute), tool(execute, "serial", true)]);
		current.call("first", '{"text":"first"}');
		await firstStarted.promise;
		current.call("second", '{"text":"second"}', "serial");
		current.finish();
		await expect.poll(() => current.agent.state.streamingMessage).toBeUndefined();
		expect(calls).toEqual(["first"]);
		release.resolve();
		await current.pending;
		expect(calls).toEqual(["first", "second"]);
	});

	it("starts the next complete call while the response is still open", async () => {
		const started = gate();
		const current = run([
			tool(async (id) => {
				if (id === "second") started.resolve();
				return { content: [], details: {} };
			}),
		]);
		current.call("first", '{"text":"first"}');
		current.call("second", '{"text":"second"}');
		await started.promise;
		expect(current.requests).toHaveLength(1);
		expect(
			current.events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toHaveLength(0);
		current.finish();
		await current.pending;
	});

	it.each(["cancel", "error"] as const)("settles started tools and starts no new request on %s", async (reason) => {
		const started = gate();
		const current = run([
			tool(async (_id, _args, signal) => {
				started.resolve();
				await delay(60000, undefined, { signal });
				return { content: [], details: {} };
			}),
		]);
		current.call("first", '{"text":"first"}');
		await started.promise;
		if (reason === "cancel") current.agent.abort();
		else current.finish("error");
		await current.pending;
		expect(current.requests).toHaveLength(1);
		expect(current.agent.state.pendingToolCalls.size).toBe(0);
		expect(current.agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("keeps hook message and tool-call identities in a stable completed-prefix context", async () => {
		const finalized = gate();
		let snapshot: AssistantMessage | undefined;
		const current = run([tool(async () => ({ content: [], details: {} }))], {
			async beforeToolCall({ assistantMessage, toolCall, context }) {
				expect(context.messages.at(-1)).toBe(assistantMessage);
				expect(assistantMessage.content).toContain(toolCall);
				return undefined;
			},
			async afterToolCall({ assistantMessage, toolCall, context }) {
				expect(context.messages.at(-1)).toBe(assistantMessage);
				expect(assistantMessage.content).toContain(toolCall);
				snapshot ??= assistantMessage;
				finalized.resolve();
				return undefined;
			},
		});
		current.call("first", '{"text":"first"}');
		await finalized.promise;
		current.call("second", '{"text":"second"}');
		expect(snapshot?.content).toHaveLength(1);
		current.finish();
		await current.pending;
	});

	it("returns an early execution failure once without replaying its side effect", async () => {
		const started = gate();
		let executions = 0;
		const current = run([
			tool(async () => {
				executions++;
				started.resolve();
				throw new Error("tool failed");
			}),
		]);
		current.call("first", '{"text":"first"}');
		await started.promise;
		current.finish();
		await current.pending;
		expect(executions).toBe(1);
		const results = current.requests[1].messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].content).toEqual([{ type: "text", text: "tool failed" }]);
	});

	it("settles an early tool when another start listener fails after response completion", async () => {
		const started = gate();
		let settled = false;
		const current = run([
			tool(async (_id, _args, signal) => {
				started.resolve();
				try {
					await delay(60000, undefined, { signal });
				} finally {
					settled = true;
				}
				return { content: [], details: {} };
			}),
		]);
		current.agent.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "second") throw new Error("listener failed");
		});
		current.call("first", '{"text":"first"}');
		await started.promise;
		current.call("second", '{"text":"second"}');
		current.finish();
		await current.pending;
		expect(settled).toBe(true);
		expect(current.requests).toHaveLength(1);
		expect(current.agent.state.errorMessage).toContain("listener failed");
	});

	it("awaits the start listener before executing and refuses side effects on persistence failure", async () => {
		let executions = 0;
		const current = run([
			tool(async () => {
				executions++;
				return { content: [], details: {} };
			}),
		]);
		current.agent.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				expect(event.assistantMessage?.content).toHaveLength(1);
				throw new Error("persist failed");
			}
		});
		current.call("first", '{"text":"first"}');
		await current.pending;
		expect(executions).toBe(0);
		expect(current.agent.state.errorMessage).toContain("persist failed");
	});
});
