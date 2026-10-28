/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// Stop waiting even when a provider, tool, or hook ignores its AbortSignal.
async function waitWithSignal<T>(operation: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	if (!signal) return await operation();
	let onAbort!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return operation();
			}),
			cancelled,
		]);
		signal.throwIfAborted();
		return result;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function* eventsWithSignal<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = await waitWithSignal(() => iterator.next(), signal);
			if (next.done) return;
			yield next.value;
		}
	} finally {
		const closing = iterator.return?.();
		// A stuck next() can also stall return(); cancellation must not await it.
		if (closing) {
			await waitWithSignal(() => closing, signal).catch((error: unknown) => {
				if (!signal?.aborted) throw error;
				void closing.catch(() => {});
			});
		}
	}
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};
	if (config.onContextReady) context.messages = currentContext.messages;

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await waitWithSignal(() => config.getSteeringMessages?.(), signal)) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				const completedTurn = lastCompletedTurn;
				const nextTurnSnapshot = await waitWithSignal(() => config.prepareNextTurn?.(completedTurn), signal);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await waitWithSignal(() => config.getSteeringMessages?.(), signal)) || [];
				}
				await emit({ type: "turn_start" });
				lastCompletedTurn = undefined;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			if (config.onContextReady) initialContext.messages = currentContext.messages;
			config.onContextReady?.(currentContext, newMessages);
			const streamed: StreamedToolCalls = {
				confirmed: new Map(),
				started: new Map(),
				tail: Promise.resolve(),
				active: true,
				controller: new AbortController(),
			};
			const toolSignal = signal ? AbortSignal.any([signal, streamed.controller.signal]) : streamed.controller.signal;
			let message: AssistantMessage;
			try {
				message = await streamAssistantResponse(currentContext, config, toolSignal, emit, streamFunction, streamed);
			} catch (error) {
				streamed.active = false;
				streamed.controller.abort(error);
				await streamed.tail.catch(() => {});
				throw streamed.failure ?? error;
			}
			newMessages.push(message);

			if ((message.stopReason === "error" || message.stopReason === "aborted") && streamed.started.size === 0) {
				await streamed.tail;
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			try {
				if (toolCalls.length > 0) {
					const executedToolBatch =
						message.stopReason === "length" && streamed.confirmed.size === 0
							? await failToolCallsFromTruncatedMessage(toolCalls, emit)
							: await executeToolCalls(currentContext, message, config, toolSignal, emit, streamed);
					toolResults.push(...executedToolBatch.messages);
					hasMoreToolCalls = !executedToolBatch.terminate;

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await streamed.tail;
				if (streamed.failure !== undefined) throw streamed.failure;
			} catch (error) {
				streamed.controller.abort(error);
				await streamed.tail.catch(() => {});
				throw streamed.failure ?? error;
			}
			await emit({ type: "turn_end", message, toolResults });
			if (signal?.aborted || message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			const completedTurn = lastCompletedTurn;
			if (await waitWithSignal(() => config.shouldStopAfterTurn?.(completedTurn), signal)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await waitWithSignal(() => config.getSteeringMessages?.(), signal)) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await waitWithSignal(() => config.getFollowUpMessages?.(), signal)) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
type StreamedToolCalls = {
	confirmed: Map<string, AgentToolCall>;
	started: Map<string, Promise<FinalizedToolCallOutcome>>;
	tail: Promise<void>;
	active: boolean;
	controller: AbortController;
	failure?: unknown;
};

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	streamed: StreamedToolCalls,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await waitWithSignal(() => config.transformContext!(messages, signal), signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await waitWithSignal(() => config.convertToLlm(messages), signal);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await waitWithSignal(() => config.getApiKey!(config.model.provider), signal) : undefined) ||
		config.apiKey;

	const response = await waitWithSignal(
		() =>
			streamFunction(config.model, llmContext, {
				...config,
				apiKey: resolvedApiKey,
				signal,
			}),
		signal,
	);

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	const argumentsByIndex = new Map<number, string>();
	const queued = new Set<string>();
	const finishResponse = async (cancelledMessage?: AssistantMessage) => {
		const finalMessage = cancelledMessage ?? (await waitWithSignal(() => response.result(), signal));
		streamed.active = false;
		if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted")
			streamed.controller.abort(new Error(finalMessage.errorMessage || "Model response did not complete"));
		for (const [callId, call] of streamed.confirmed) {
			if (cancelledMessage && !streamed.started.has(callId)) continue;
			const finalCalls = finalMessage.content.filter(
				(block): block is AgentToolCall => block.type === "toolCall" && block.id === callId,
			);
			if (
				finalCalls.length !== 1 ||
				finalCalls[0].name !== call.name ||
				JSON.stringify(finalCalls[0].arguments) !== JSON.stringify(call.arguments)
			)
				throw new Error("Provider changed a completed tool call");
		}
		if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
		else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	};

	try {
		for await (const event of eventsWithSignal(response, signal)) {
			if (event.type === "toolcall_delta")
				argumentsByIndex.set(event.contentIndex, (argumentsByIndex.get(event.contentIndex) ?? "") + event.delta);
			const completed = event.type === "toolcall_end" ? structuredClone(event) : undefined;
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error":
					return await finishResponse();
			}
			if (!completed || ["length", "error", "aborted"].includes(completed.partial.stopReason)) continue;
			let args: unknown;
			try {
				args = JSON.parse(argumentsByIndex.get(completed.contentIndex) ?? "");
			} catch {
				continue;
			}
			if (!args || typeof args !== "object" || Array.isArray(args)) continue;
			const call: AgentToolCall = { ...completed.toolCall, arguments: args as Record<string, unknown> };
			const previous = streamed.confirmed.get(call.id);
			if (previous && JSON.stringify(previous) !== JSON.stringify(call))
				throw new Error("Provider reused a completed tool call ID");
			streamed.confirmed.set(call.id, call);
			for (const block of completed.partial.content) {
				if (block.type !== "toolCall") continue;
				const confirmed = streamed.confirmed.get(block.id);
				if (!confirmed) break;
				if (queued.has(block.id)) continue;
				queued.add(block.id);
				const assistantMessage = structuredClone({
					...completed.partial,
					content: completed.partial.content
						.slice(0, completed.partial.content.indexOf(block) + 1)
						.map((part) => (part.type === "toolCall" ? streamed.confirmed.get(part.id)! : part)),
					stopReason: "toolUse" as const,
				});
				const toolCall = assistantMessage.content.find(
					(part): part is AgentToolCall => part.type === "toolCall" && part.id === confirmed.id,
				)!;
				streamed.tail = streamed.tail.then(async () => {
					if (!streamed.active || signal?.aborted) return;
					const outcome = (async () => {
						await emit({
							type: "tool_execution_start",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: toolCall.arguments,
							assistantMessage,
						});
						const toolContext = { ...context, messages: [...context.messages.slice(0, -1), assistantMessage] };
						const preparation = await prepareToolCall(toolContext, assistantMessage, toolCall, config, signal);
						let finalized: FinalizedToolCallOutcome;
						if (preparation.kind === "immediate")
							finalized = { toolCall, result: preparation.result, isError: preparation.isError };
						else {
							const executed = await executePreparedToolCall(preparation, signal, emit);
							finalized = await finalizeExecutedToolCall(
								toolContext,
								assistantMessage,
								preparation,
								executed,
								config,
								signal,
							);
						}
						await emitToolExecutionEnd(finalized, emit);
						return finalized;
					})();
					streamed.started.set(toolCall.id, outcome);
					await outcome;
				});
				void streamed.tail.catch((error: unknown) => {
					streamed.failure ??= error;
					streamed.controller.abort(error);
				});
			}
		}

		return await finishResponse();
	} catch (error) {
		if (!signal?.aborted || !partialMessage) throw error;
		const cancelledMessage = structuredClone(partialMessage);
		cancelledMessage.content = cancelledMessage.content.filter(
			(part) => part.type !== "toolCall" || streamed.started.has(part.id),
		);
		cancelledMessage.stopReason = "aborted";
		cancelledMessage.errorMessage = signal.reason instanceof Error ? signal.reason.message : "Operation aborted";
		return finishResponse(cancelledMessage);
	}
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamed: StreamedToolCalls,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, streamed);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, streamed);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamed: StreamedToolCalls,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		const started = streamed.started.get(toolCall.id);
		if (started) {
			const finalized = await started;
			const message = createToolResultMessage(finalized);
			await emitToolResultMessage(message, emit);
			finalizedCalls.push(finalized);
			messages.push(message);
			continue;
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			config,
			signal,
			streamed.confirmed,
		);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted && streamed.started.size === 0) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamed: StreamedToolCalls,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		const started = streamed.started.get(toolCall.id);
		if (started) {
			finalizedCalls.push(() => started);
			continue;
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			config,
			signal,
			streamed.confirmed,
		);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	confirmed?: ReadonlyMap<string, AgentToolCall>,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (
		assistantMessage.stopReason === "error" ||
		assistantMessage.stopReason === "aborted" ||
		(assistantMessage.stopReason === "length" && !confirmed?.has(toolCall.id))
	)
		return {
			kind: "immediate",
			result: createErrorToolResult(
				"Tool call was not executed: the model response was interrupted or its arguments may be truncated.",
			),
			isError: true,
		};
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await waitWithSignal(
				() =>
					config.beforeToolCall!(
						{
							assistantMessage,
							toolCall,
							args: validatedArgs,
							context: currentContext,
						},
						signal,
					),
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await waitWithSignal(
			() =>
				prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
					if (!acceptingUpdates || signal?.aborted) return;
					updateEvents.push(
						Promise.resolve(
							emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				}),
			signal,
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall && !signal?.aborted) {
		try {
			const afterResult = await waitWithSignal(
				() =>
					config.afterToolCall!(
						{
							assistantMessage,
							toolCall: prepared.toolCall,
							args: prepared.args,
							result,
							isError,
							context: currentContext,
						},
						signal,
					),
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
