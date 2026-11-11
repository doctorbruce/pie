import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { isCapabilityCatalog } from "./capability-catalog.ts";

export const DEFAULT_HISTORY_IMAGE_BYTES = 16 * 1024 * 1024;

export function latestRealUserMessage(messages: AgentMessage[]): UserMessage | undefined {
	return [...messages].reverse().find((message): message is UserMessage => {
		const transferred: unknown = Reflect.get(message, "transferMessage");
		return (
			message.role === "user" &&
			Reflect.get(message, "contextCheckpoint") !== true &&
			typeof Reflect.get(message, "workerMessageId") !== "string" &&
			!(transferred && typeof transferred === "object" && Reflect.get(transferred, "role") === "system") &&
			!isCapabilityCatalog(message) &&
			(typeof message.content === "string" ||
				message.content.some((part) => Reflect.get(part, "synthetic") !== true))
		);
	});
}

export function projectImageHistory(
	messages: AgentMessage[],
	maxBytes = DEFAULT_HISTORY_IMAGE_BYTES,
	protectedUser?: UserMessage,
): AgentMessage[] {
	// A supplied original user outside this slice must not protect an older user inside it.
	const current = protectedUser ?? latestRealUserMessage(messages);
	const tools: { key: string; bytes: number }[] = [];
	const users: { key: string; bytes: number }[] = [];
	let total = 0;
	for (const [messageIndex, message] of messages.entries()) {
		if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") continue;
		for (const [contentIndex, part] of message.content.entries()) {
			if (part.type !== "image") continue;
			const bytes = Buffer.byteLength(JSON.stringify(part.data), "utf8");
			total += bytes;
			const candidate = { key: `${messageIndex}:${contentIndex}`, bytes };
			if (message.role === "toolResult") tools.push(candidate);
			else if (message !== current) users.push(candidate);
		}
	}
	const omitted = new Set<string>();
	// Count each encoded image occurrence; this target does not limit the complete HTTP body.
	for (const candidate of [...tools, ...users]) {
		if (total <= maxBytes) break;
		omitted.add(candidate.key);
		total -= candidate.bytes;
	}
	if (omitted.size === 0) return messages;
	return messages.map((message, messageIndex) => {
		if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string")
			return message;
		if (!message.content.some((_, contentIndex) => omitted.has(`${messageIndex}:${contentIndex}`))) return message;
		return {
			...message,
			content: message.content.map((part, contentIndex) =>
				part.type === "image" && omitted.has(`${messageIndex}:${contentIndex}`)
					? { type: "text" as const, text: `[Historical image omitted from this request: ${part.mimeType}]` }
					: part,
			),
		};
	});
}
