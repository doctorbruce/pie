import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { isContextOverflow, isRecoverableLength } from "./compaction/overflow.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "./compaction/utils.ts";
import type { ContextCompaction } from "./protocol.ts";

export type CompactionSettings = {
	enabled?: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	thresholdTokens?: number;
};

export type CompactionSummaryRequest = { prompt: string; maxTokens: number };
export type CompactionEvent = {
	type: "compaction.started" | "compaction.finished" | "compaction.retry";
	reason?: "threshold" | "overflow";
	status?: "completed" | "failed" | "cancelled";
	error?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
};

type CompactionOptions = {
	contextWindow: number;
	initial?: ContextCompaction;
	settings?: CompactionSettings;
	summarize: (
		request: CompactionSummaryRequest,
		signal?: AbortSignal,
	) => Promise<string | { summary: string; usage?: Usage }>;
	onCompacted: (compaction: ContextCompaction) => void;
	report?: (event: CompactionEvent) => void;
};

type RequestBudget = Pick<Context, "systemPrompt" | "tools"> & { force?: boolean };

const ESTIMATED_IMAGE_CHARS = 4800;

const SUMMARY_INSTRUCTIONS = `The conversation above needs a context checkpoint for another LLM that will continue the work.

Use this exact structure:

## Goal
[The user's current goal]

## Constraints & Preferences
- [Requirements and preferences]

## Progress
### Done
- [Completed work]

### In Progress
- [Current work]

### Blocked
- [Current blockers, or "None"]

## Key Decisions
- [Decision and reason]

## Next Steps
1. [Next action]

## Critical Context
- [Exact paths, function names, errors, data, and other facts needed to continue]

Keep it concise. Preserve exact technical identifiers. Do not continue the conversation or answer its questions.`;

const UPDATE_INSTRUCTIONS = `Update the existing checkpoint with the new conversation above. Preserve relevant facts, add new progress and decisions, move completed work to Done, and refresh Next Steps. Use the same exact structure as the existing checkpoint. Do not continue the conversation or answer its questions.`;

function settingsForContextWindow(contextWindow: number): CompactionSettings {
	const reserveTokens = Math.min(16384, Math.max(1, Math.floor(contextWindow / 4)));
	return {
		reserveTokens,
		keepRecentTokens: Math.min(20000, Math.max(1, Math.floor((contextWindow - reserveTokens) / 2))),
	};
}

export function estimateMessageTokens(message: AgentMessage): number {
	if (typeof message.content === "string") return Math.ceil(message.content.length / 4);
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
	}
	return Math.ceil(chars / 4);
}

export function estimateContextTokens(messages: AgentMessage[], firstUsageIndex = 0): number {
	for (let index = messages.length - 1; index >= firstUsageIndex; index--) {
		const message = messages[index];
		if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (tokens > 0)
			return (
				tokens + messages.slice(index + 1).reduce((total, trailing) => total + estimateMessageTokens(trailing), 0)
			);
	}
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function findFirstKeptMessage(messages: AgentMessage[], start: number, keepRecentTokens: number): number | undefined {
	const cuts = messages.flatMap((message, index) => (index > start && message.role !== "toolResult" ? [index] : []));
	if (!cuts.length) return undefined;
	let accumulated = 0;
	for (let index = messages.length - 1; index >= start; index--) {
		accumulated += estimateMessageTokens(messages[index]);
		if (accumulated >= keepRecentTokens) return cuts.find((candidate) => candidate >= index) ?? cuts.at(-1);
	}
	return cuts.at(-1);
}

function buildSummaryPrompt(messages: AgentMessage[], previousSummary?: string): string {
	const conversation = `<conversation>\n${serializeConversation(messages)}\n</conversation>`;
	if (!previousSummary) return `${conversation}\n\n${SUMMARY_INSTRUCTIONS}`;
	return `${conversation}\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${UPDATE_INSTRUCTIONS}`;
}

function compactedContext(messages: AgentMessage[], compaction: ContextCompaction): AgentMessage[] {
	return [
		{
			role: "user",
			content: `<context-checkpoint>\n${compaction.summary}\n</context-checkpoint>\nContinue from this checkpoint and the recent messages below.`,
			timestamp: compaction.compactedAt,
		},
		...(compaction.turnStartIndex === undefined ? [] : [messages[compaction.turnStartIndex]]),
		...messages.slice(compaction.firstKeptMessage),
	];
}

function requestTokens(messages: AgentMessage[], budget: RequestBudget): number {
	return (
		Math.ceil(
			((budget.systemPrompt?.length ?? 0) + (budget.tools?.length ? JSON.stringify(budget.tools).length : 0)) / 4,
		) + messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
	);
}

export function createCompactionTransform(options: CompactionOptions) {
	let current = options.initial;
	const settings = options.settings ?? settingsForContextWindow(options.contextWindow);
	const threshold = Math.min(
		settings.thresholdTokens ?? Number.POSITIVE_INFINITY,
		Math.floor(options.contextWindow * 0.9),
		options.contextWindow - settings.reserveTokens,
	);
	return async (
		messages: AgentMessage[],
		signal?: AbortSignal,
		budget: RequestBudget = {},
	): Promise<AgentMessage[]> => {
		signal?.throwIfAborted();
		const active = current ? compactedContext(messages, current) : messages;
		const firstUsageIndex = current
			? current.messageCount === undefined
				? active.findIndex((message) => message.timestamp > current!.compactedAt)
				: (current.turnStartIndex === undefined ? 1 : 2) +
					Math.max(0, current.messageCount - current.firstKeptMessage)
			: 0;
		const tokensBefore = Math.max(
			estimateContextTokens(active, firstUsageIndex < 0 ? active.length : firstUsageIndex),
			requestTokens(active, budget),
		);
		if (settings.enabled === false || (!budget.force && tokensBefore <= threshold)) return active;
		const reason = budget.force ? "overflow" : "threshold";
		options.report?.({ type: "compaction.started", reason });
		try {
			const boundary = current?.firstKeptMessage ?? 0;
			let firstKeptMessage = findFirstKeptMessage(messages, boundary, settings.keepRecentTokens);
			if (budget.force && firstKeptMessage === undefined) {
				for (let index = messages.length - 1; index > boundary; index--) {
					if (messages[index].role === "user") {
						firstKeptMessage = index;
						break;
					}
				}
			}
			if (firstKeptMessage === undefined)
				throw new Error("上下文超限且没有可压缩的历史；请缩短当前输入、工具输出或附件。");
			let turnStartIndex: number | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				if (messages[index].role === "user") {
					if (index < firstKeptMessage) turnStartIndex = index;
					break;
				}
			}
			const fileOps = createFileOps();
			for (const path of current?.details?.readFiles ?? []) fileOps.read.add(path);
			for (const path of current?.details?.modifiedFiles ?? []) fileOps.written.add(path);
			for (const message of messages.slice(boundary, firstKeptMessage)) extractFileOpsFromMessage(message, fileOps);
			const details = computeFileLists(fileOps);
			const result = await options.summarize(
				{
					prompt: buildSummaryPrompt(messages.slice(boundary, firstKeptMessage), current?.summary),
					maxTokens: Math.max(1, Math.floor(settings.reserveTokens * 0.8)),
				},
				signal,
			);
			signal?.throwIfAborted();
			const text = (typeof result === "string" ? result : result.summary).trim();
			if (!text) throw new Error("上下文摘要为空");
			const next: ContextCompaction = {
				summary: text + formatFileOperations(details.readFiles, details.modifiedFiles),
				firstKeptMessage,
				turnStartIndex,
				messageCount: messages.length,
				tokensBefore,
				estimatedTokensAfter: 0,
				compactedAt: Date.now(),
				generation: (current?.generation ?? 0) + 1,
				details,
				usage: typeof result === "string" ? undefined : result.usage,
			};
			const projected = compactedContext(messages, next);
			next.estimatedTokensAfter = requestTokens(projected, budget);
			if (next.estimatedTokensAfter > threshold)
				throw new Error("压缩后上下文仍超出预算；当前输入、工具输出或附件过大。");
			options.onCompacted(next);
			current = next;
			options.report?.({ type: "compaction.finished", reason, status: "completed" });
			return projected;
		} catch (error) {
			options.report?.({
				type: "compaction.finished",
				reason,
				status: signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};
}

export function createCompactionStream(
	stream: StreamFn,
	transform: ReturnType<typeof createCompactionTransform>,
	options: { enabled?: boolean } = {},
): StreamFn {
	return (model, context, request) => {
		const output = createAssistantMessageEventStream();
		let lastMessage: AssistantMessage | undefined;
		void (async () => {
			let messages = await transform(context.messages, request?.signal, context);
			for (let attempt = 0; attempt < 2; attempt++) {
				const pending: AssistantMessageEvent[] = [];
				let visible = false;
				let recover = false;
				const source = await stream(model, { ...context, messages }, request);
				for await (const event of source) {
					if (event.type === "start") {
						lastMessage = event.partial;
						pending.push(event);
						continue;
					}
					const terminal = event.type === "done" || event.type === "error";
					lastMessage =
						event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
					if (
						terminal &&
						attempt === 0 &&
						!visible &&
						options.enabled !== false &&
						!request?.signal?.aborted &&
						lastMessage.content.every((block) =>
							block.type === "text" ? !block.text : block.type === "thinking" ? !block.thinking : false,
						) &&
						(isContextOverflow(lastMessage, model.contextWindow) ||
							isRecoverableLength(lastMessage, request?.maxTokens ?? model.maxTokens))
					) {
						messages = await transform(context.messages, request?.signal, { ...context, force: true });
						recover = true;
						break;
					}
					for (const buffered of pending) output.push(buffered);
					pending.length = 0;
					output.push(event);
					visible = true;
					if (terminal) return;
				}
				if (!recover) throw new Error("模型流在结束事件之前中断");
			}
		})().catch((error) => {
			const aborted = request?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
			const response: AssistantMessage = {
				...(lastMessage ?? fauxAssistantMessage("")),
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			output.push({ type: "error", reason: aborted ? "aborted" : "error", error: response });
		});
		return output;
	};
}
