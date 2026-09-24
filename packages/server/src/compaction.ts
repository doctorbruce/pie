import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { ContextCompaction } from "./protocol.ts";

export type CompactionSettings = {
	reserveTokens: number;
	keepRecentTokens: number;
};

export type CompactionSummaryRequest = {
	prompt: string;
	maxTokens: number;
};

type CompactionOptions = {
	contextWindow: number;
	initial?: ContextCompaction;
	settings?: CompactionSettings;
	summarize: (request: CompactionSummaryRequest, signal?: AbortSignal) => Promise<string>;
	onCompacted: (compaction: ContextCompaction) => void;
};

const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const ESTIMATED_IMAGE_CHARS = 4800;
const TOOL_RESULT_MAX_CHARS = 2000;

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
	const reserveTokens = Math.min(DEFAULT_RESERVE_TOKENS, Math.max(1, Math.floor(contextWindow / 4)));
	return {
		reserveTokens,
		keepRecentTokens: Math.min(
			DEFAULT_KEEP_RECENT_TOKENS,
			Math.max(1, Math.floor((contextWindow - reserveTokens) / 2)),
		),
	};
}

function contentChars(content: AgentMessage["content"]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
	}
	return chars;
}

export function estimateMessageTokens(message: AgentMessage): number {
	return Math.ceil(contentChars(message.content) / 4);
}

export function estimateContextTokens(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			message.usage.totalTokens > 0
		) {
			return (
				message.usage.totalTokens +
				messages.slice(index + 1).reduce((total, trailing) => total + estimateMessageTokens(trailing), 0)
			);
		}
	}
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function findFirstKeptMessage(messages: AgentMessage[], start: number, keepRecentTokens: number): number | undefined {
	let accumulated = 0;
	for (let index = messages.length - 1; index >= start; index--) {
		accumulated += estimateMessageTokens(messages[index]);
		if (accumulated < keepRecentTokens || messages[index].role === "toolResult") continue;
		return index > start ? index : undefined;
	}
	return undefined;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} characters truncated]`;
}

function serializeConversation(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[User]: ${text}`);
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[Tool ${message.toolName} result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`);
			continue;
		}
		const thinking = message.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n");
		const text = contentText(message.content, "");
		const calls = message.content
			.filter((block) => block.type === "toolCall")
			.map((block) => `${block.name}(${JSON.stringify(block.arguments)})`)
			.join("; ");
		if (thinking) parts.push(`[Assistant thinking]: ${thinking}`);
		if (text) parts.push(`[Assistant]: ${text}`);
		if (calls) parts.push(`[Assistant tool calls]: ${calls}`);
	}
	return parts.join("\n\n");
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
		...messages.slice(compaction.firstKeptMessage),
	];
}

export function createCompactionTransform(options: CompactionOptions) {
	let current = options.initial;
	const settings = options.settings ?? settingsForContextWindow(options.contextWindow);
	return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
		const activeContext = current ? compactedContext(messages, current) : messages;
		const tokensBefore = estimateContextTokens(activeContext);
		if (tokensBefore <= options.contextWindow - settings.reserveTokens) return activeContext;

		const boundary = current?.firstKeptMessage ?? 0;
		const firstKeptMessage = findFirstKeptMessage(messages, boundary, settings.keepRecentTokens);
		if (firstKeptMessage === undefined) return activeContext;

		try {
			const summary = (
				await options.summarize(
					{
						prompt: buildSummaryPrompt(messages.slice(boundary, firstKeptMessage), current?.summary),
						maxTokens: Math.max(1, Math.floor(settings.reserveTokens * 0.8)),
					},
					signal,
				)
			).trim();
			if (!summary) return activeContext;
			const next: ContextCompaction = {
				summary,
				firstKeptMessage,
				tokensBefore,
				estimatedTokensAfter:
					Math.ceil(summary.length / 4) +
					messages.slice(firstKeptMessage).reduce((total, message) => total + estimateMessageTokens(message), 0),
				compactedAt: Date.now(),
				generation: (current?.generation ?? 0) + 1,
			};
			options.onCompacted(next);
			current = next;
			return compactedContext(messages, next);
		} catch {
			return activeContext;
		}
	};
}
