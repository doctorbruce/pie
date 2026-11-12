import { setTimeout as delay } from "node:timers/promises";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
import { transformMessages } from "../../ai/src/api/transform-messages.ts";
import { Agent, type AgentEvent, type AgentOptions, type AgentTool } from "../src/index.ts";

function gate<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function stopped(agent: Agent) {
	agent.abort();
	expect(await Promise.race([agent.waitForIdle().then(() => true), delay(500).then(() => false)])).toBe(true);
	expect(agent.state.isStreaming).toBe(false);
}

describe("non-cooperative cancellation", () => {
	it.each(["setup", "events", "result"] as const)(
		"steers past a stuck provider %s and isolates late output",
		async (phase) => {
			const entered = gate();
			const release = gate();
			const stream = createAssistantMessageEventStream();
			const partial = fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "unfinished signature" },
					{ type: "text", text: "partial text", textSignature: "unfinished signature" },
				],
				{ stopReason: "pending" },
			);
			if (phase === "result")
				stream.result = async () => {
					entered.resolve();
					await release.promise;
					return partial;
				};
			let requests = 0;
			let providerSignal: AbortSignal | undefined;
			const agent = new Agent({
				initialState: { model: fauxProvider().getModel() },
				async streamFn(_model, _context, options) {
					if (++requests > 1) {
						const next = createAssistantMessageEventStream();
						next.push({ type: "done", reason: "stop", message: fauxAssistantMessage("next") });
						return next;
					}
					providerSignal = options?.signal;
					if (phase === "setup") {
						entered.resolve();
						await release.promise;
					}
					return stream;
				},
			});
			agent.subscribe((event) => {
				if (phase === "events" && event.type === "message_start" && event.message.role === "assistant")
					entered.resolve();
			});
			const pending = agent.prompt("start");
			if (phase !== "setup") stream.push({ type: "start", partial });
			if (phase === "result") stream.push({ type: "done", reason: "stop", message: partial });
			try {
				await entered.promise;
				agent.steer({ role: "user", content: "change direction", timestamp: Date.now() });
				await expect.poll(() => requests, { timeout: 500 }).toBe(2);
				await pending;
				expect(providerSignal?.aborted).toBe(true);
				expect(agent.state.errorMessage).toBeUndefined();
				if (phase !== "setup") {
					expect(agent.state.messages[1]).toMatchObject({ stopReason: "stop" });
					expect(agent.state.messages[1].content).toEqual([
						{ type: "thinking", thinking: "partial reasoning" },
						{ type: "text", text: "partial text" },
					]);
				}
				const history = structuredClone(agent.state.messages);
				partial.content = [{ type: "text", text: "late mutation" }];
				release.resolve();
				stream.push({ type: "done", reason: "stop", message: partial });
				await delay(10);
				expect(agent.state.messages).toEqual(history);
			} finally {
				release.resolve();
				agent.abort();
				await pending;
			}
		},
	);

	it.each([false, true])(
		"lets context preparation settle before steering resumes model generation (failure=%s)",
		async (failure) => {
			const entered = gate();
			const release = gate();
			let prepared = false;
			let latePreparations = 0;
			let requests = 0;
			let preparationSignal: AbortSignal | undefined;
			const agent = new Agent({
				initialState: { model: fauxProvider().getModel() },
				async streamFn(_model, _context, options) {
					if (++requests === 1) {
						await options?.prepare?.(async (signal) => {
							preparationSignal = signal;
							entered.resolve();
							await release.promise;
							if (failure) throw new Error("preparation storage failed");
							prepared = true;
						});
						try {
							await options?.prepare?.(async () => {
								latePreparations++;
							});
						} catch (error) {
							if (!options?.signal?.aborted) throw error;
						}
					}
					const response = createAssistantMessageEventStream();
					response.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
					return response;
				},
			});
			const pending = agent.prompt("start");
			try {
				await entered.promise;
				agent.steer({ role: "user", content: "change direction", timestamp: Date.now() });
				expect(preparationSignal?.aborted).toBe(false);
				expect(prepared).toBe(false);
				expect(requests).toBe(1);
				release.resolve();
				await pending;
				expect(latePreparations).toBe(0);
				if (failure) {
					expect(prepared).toBe(false);
					expect(requests).toBe(1);
					expect(agent.state.errorMessage).toContain("preparation storage failed");
				} else {
					expect(prepared).toBe(true);
					expect(requests).toBe(2);
					expect(agent.state.errorMessage).toBeUndefined();
				}
			} finally {
				release.resolve();
				agent.abort();
				await pending;
			}
		},
	);

	it.each([false, true])(
		"replays completed reasoning only with a following retained item (text=%s)",
		async (followingText) => {
			const model = { ...fauxProvider().getModel(), api: "openai-responses" as const, provider: "openai" };
			const stream = createAssistantMessageEventStream();
			const entered = gate();
			const signature = JSON.stringify({ id: "rs_complete", type: "reasoning", summary: [], status: "completed" });
			const partial = fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: signature },
					...(followingText ? [{ type: "text" as const, text: "visible text" }] : []),
				],
				{ stopReason: "pending" },
			);
			Object.assign(partial, { api: model.api, provider: model.provider, model: model.id });
			let replay: ReturnType<typeof convertResponsesMessages> = [];
			let requests = 0;
			const agent = new Agent({
				initialState: { model },
				streamFn(_model, context) {
					if (++requests === 1) return stream;
					replay = convertResponsesMessages(
						model,
						{ ...context, messages: transformMessages(context.messages, model) },
						new Set(["openai"]),
					);
					const next = createAssistantMessageEventStream();
					next.push({ type: "done", reason: "stop", message: fauxAssistantMessage("next") });
					return next;
				},
			});
			agent.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end")
					entered.resolve();
			});
			const pending = agent.prompt("start");
			stream.push({ type: "start", partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "visible reasoning", partial });
			try {
				await entered.promise;
				agent.steer({ role: "user", content: "change direction", timestamp: Date.now() });
				await pending;
				expect(agent.state.errorMessage).toBeUndefined();
				expect(agent.state.messages[1].content).toEqual(
					expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking: "visible reasoning" })]),
				);
				expect(replay.filter((item) => "type" in item && item.type === "reasoning")).toHaveLength(
					followingText ? 1 : 0,
				);
			} finally {
				agent.abort();
				await pending;
			}
		},
	);

	it.each(["result", "return"] as const)("interrupts a stuck provider %s", async (phase) => {
		const entered = gate();
		const release = gate();
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage("partial");
		if (phase === "result")
			stream.result = async () => {
				entered.resolve();
				await release.promise;
				return message;
			};
		else {
			const iterator = stream[Symbol.asyncIterator]();
			iterator.return = async () => {
				entered.resolve();
				await release.promise;
				return { done: true, value: undefined };
			};
			stream[Symbol.asyncIterator] = () => iterator;
		}
		const agent = new Agent({ initialState: { model: fauxProvider().getModel() }, streamFn: () => stream });
		const pending = agent.prompt("start");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		try {
			await entered.promise;
			await stopped(agent);
			await pending;
		} finally {
			release.resolve();
			agent.abort();
			await pending;
		}
	});

	it("stops an unresponsive provider and isolates its late mutations from the next run", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("partial", { stopReason: "pending" });
		const entered = gate();
		const events: AgentEvent[] = [];
		let requests = 0;
		const agent = new Agent({
			initialState: { model: fauxProvider().getModel() },
			streamFn() {
				if (++requests === 1) return stream;
				const next = createAssistantMessageEventStream();
				const message = fauxAssistantMessage("next");
				next.push({ type: "done", reason: "stop", message });
				return next;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_start" && event.message.role === "assistant") entered.resolve();
		});
		const pending = agent.prompt("start");
		stream.push({ type: "start", partial });
		try {
			await entered.promise;
			await stopped(agent);
			await pending;
			expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "aborted", content: [{ text: "partial" }] });
			await agent.prompt("again");
			const history = structuredClone(agent.state.messages);
			const count = events.length;
			partial.content = [{ type: "text", text: "late" }];
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("late") });
			await delay(10);
			expect(agent.state.messages).toEqual(history);
			expect(events).toHaveLength(count);
			expect(requests).toBe(2);
		} finally {
			stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage([], { stopReason: "aborted" }) });
			agent.abort();
			await pending;
		}
	});

	it.each([false, true])(
		"stops a stuck tool (streamed=%s) and drops late progress and completion",
		async (streamed) => {
			const started = gate();
			const release = gate();
			const stream = createAssistantMessageEventStream();
			const call = fauxToolCall("action", {}, { id: "stuck" });
			const partial = fauxAssistantMessage([call], { stopReason: "pending" });
			let update: Parameters<AgentTool["execute"]>[3];
			let afterCalls = 0;
			let requests = 0;
			const events: AgentEvent[] = [];
			const agent = new Agent({
				initialState: {
					model: fauxProvider().getModel(),
					tools: [
						{
							name: "action",
							label: "action",
							description: "action",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, onUpdate) {
								update = onUpdate;
								started.resolve();
								await release.promise;
								return { content: [{ type: "text", text: "late" }], details: {} };
							},
						},
					],
				},
				async afterToolCall() {
					afterCalls++;
					return undefined;
				},
				streamFn() {
					if (++requests === 1) return stream;
					const next = createAssistantMessageEventStream();
					next.push({ type: "done", reason: "stop", message: fauxAssistantMessage("next") });
					return next;
				},
			});
			agent.subscribe((event) => {
				events.push(event);
			});
			const pending = agent.prompt("execute");
			stream.push({ type: "start", partial });
			if (streamed) {
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
			} else stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
			try {
				await started.promise;
				await stopped(agent);
				await pending;
				expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
					{ toolCallId: "stuck", isError: true },
				]);
				expect(requests).toBe(1);
				expect(afterCalls).toBe(0);
				await agent.prompt("again");
				const history = structuredClone(agent.state.messages);
				const count = events.length;
				update?.({ content: [{ type: "text", text: "late progress" }], details: {} });
				release.resolve();
				stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
				await delay(10);
				expect(agent.state.messages).toEqual(history);
				expect(events).toHaveLength(count);
				expect(afterCalls).toBe(0);
			} finally {
				release.resolve();
				stream.push({
					type: "error",
					reason: "aborted",
					error: fauxAssistantMessage([], { stopReason: "aborted" }),
				});
				agent.abort();
				await pending;
			}
		},
	);

	it.each([
		"transformContext",
		"convertToLlm",
		"getApiKey",
		"streamFn",
		"beforeToolCall",
		"afterToolCall",
		"prepareNextTurn",
		"shouldStopAfterTurn",
	] as const)("interrupts a stuck %s without starting more work", async (phase) => {
		const entered = gate();
		const release = gate();
		const block = async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		};
		let requests = 0;
		let executions = 0;
		const options: AgentOptions = {
			initialState: {
				model: fauxProvider().getModel(),
				tools: [
					{
						name: "action",
						label: "action",
						description: "action",
						parameters: Type.Object({}),
						async execute() {
							executions++;
							return { content: [], details: {} };
						},
					},
				],
			},
			streamFn() {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "toolUse",
					message: fauxAssistantMessage([fauxToolCall("action", {})], { stopReason: "toolUse" }),
				});
				return stream;
			},
		};
		switch (phase) {
			case "transformContext":
				options.transformContext = async (messages) => {
					await block();
					return messages;
				};
				break;
			case "convertToLlm":
				options.convertToLlm = async (messages) => {
					await block();
					return messages;
				};
				break;
			case "streamFn": {
				const streamFn = options.streamFn;
				options.streamFn = async (...args) => {
					await block();
					return streamFn(...args);
				};
				break;
			}
			case "shouldStopAfterTurn":
				options.shouldStopAfterTurn = async () => {
					await block();
					return false;
				};
				break;
			default:
				options[phase] = block;
		}
		const agent = new Agent(options);
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});
		const pending = agent.prompt("execute");
		try {
			await entered.promise;
			await stopped(agent);
			await pending;
			const history = structuredClone(agent.state.messages);
			const count = events.length;
			release.resolve();
			await delay(10);
			expect(agent.state.messages).toEqual(history);
			expect(events).toHaveLength(count);
			expect(executions).toBe(["afterToolCall", "prepareNextTurn", "shouldStopAfterTurn"].includes(phase) ? 1 : 0);
			expect(requests).toBeLessThanOrEqual(1);
		} finally {
			release.resolve();
			agent.abort();
			await pending;
		}
	});
});
