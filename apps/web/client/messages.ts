import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { messageIdentity } from "@pie/runtime/session-events";

export function updateToolProgress(
	current: ReadonlyMap<string, string>,
	packet: SessionEvent,
): ReadonlyMap<string, string> {
	if ((packet.turn ?? packet.snapshot?.turn)?.status !== "running") return current.size ? new Map() : current;
	const event = packet.event;
	if (typeof event?.toolCallId !== "string") return current;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		if (!current.has(event.toolCallId)) return current;
		const next = new Map(current);
		next.delete(event.toolCallId);
		return next;
	}
	if (event.type !== "tool_execution_update") return current;
	const result = event.partialResult;
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
		return current;
	const text = result.content
		.flatMap((part: unknown) =>
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
	return text ? new Map(current).set(event.toolCallId, text) : current;
}

export function toThreadMessages(
	snapshot?: SessionSnapshot,
	toolProgress?: ReadonlyMap<string, string>,
): ThreadMessageLike[] {
	if (!snapshot) return [];
	const messages = snapshot.streamingMessage ? [...snapshot.messages, snapshot.streamingMessage] : snapshot.messages;
	const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
	return messages.flatMap((message): ThreadMessageLike[] => {
		if (message.role === "toolResult") return [];
		const id = `${snapshot.id}:${messageIdentity(message)}`;
		if (message.role === "user") {
			return [
				{
					id,
					role: "user",
					content:
						typeof message.content === "string"
							? message.content
							: message.content.flatMap((part) => (part.type === "text" ? [part] : [])),
				},
			];
		}
		const content: Exclude<ThreadMessageLike["content"], string>[number][] = message.content.map((part) => {
			if (part.type === "text") return { type: "text", text: part.text };
			if (part.type === "thinking") return { type: "reasoning", text: part.thinking };
			const result = results.get(part.id);
			return {
				type: "tool-call",
				toolCallId: part.id,
				toolName: part.name,
				argsText: part.argumentsText ?? JSON.stringify(part.arguments),
				result: result?.content.map((c) => (c.type === "text" ? c.text : "[图片结果]")).join("\n"),
				isError: result?.isError,
				artifact: !result && snapshot.turn?.status === "running" ? toolProgress?.get(part.id) : undefined,
			};
		});
		const pending =
			message.stopReason === "pending" || message.content.some((p) => p.type === "toolCall" && !results.has(p.id));
		const status: ThreadMessageLike["status"] =
			message.stopReason === "aborted"
				? { type: "incomplete", reason: "cancelled" }
				: message.stopReason === "error"
					? { type: "incomplete", reason: "error", error: message.errorMessage }
					: pending && snapshot.turn?.status === "running"
						? { type: "running" }
						: pending
							? { type: "incomplete", reason: "tool-calls" }
							: { type: "complete", reason: "stop" };
		return [{ id, role: "assistant", content, status }];
	});
}
