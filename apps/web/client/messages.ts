import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionSnapshot } from "@pie/server/protocol";

export function toThreadMessages(snapshot?: SessionSnapshot): ThreadMessageLike[] {
	if (!snapshot) return [];
	const messages = snapshot.streamingMessage ? [...snapshot.messages, snapshot.streamingMessage] : snapshot.messages;
	const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
	return messages.flatMap((message, index): ThreadMessageLike[] => {
		if (message.role === "toolResult") return [];
		const id = `${snapshot.id}:${index}`;
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
				argsText: JSON.stringify(part.arguments),
				result: result?.content.map((c) => (c.type === "text" ? c.text : "[图片结果]")).join("\n"),
				isError: result?.isError,
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
