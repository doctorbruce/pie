import type {
	MaterializedSessionEvent,
	SessionEvent,
	SessionHistoryPage,
	SessionSnapshot,
	WireMessage,
} from "./protocol.ts";

export function messageIdentity(message: WireMessage): string {
	const id: unknown = Reflect.get(message, "id");
	return typeof id === "string" && id ? id : `pie:${message.role}:${message.timestamp}`;
}

export function applySessionEvent(
	current: SessionSnapshot | undefined,
	packet: SessionEvent,
): SessionSnapshot | undefined {
	if (packet.snapshot) {
		if (
			current?.id === packet.sessionId &&
			current.instanceId === packet.instanceId &&
			current.revision > packet.revision
		)
			return current;
		return packet.snapshot;
	}
	if (!current || current.id !== packet.sessionId) return current;
	if (current.instanceId !== packet.instanceId) return;
	if (packet.revision <= current.revision) return current;
	if (packet.revision !== current.revision + 1 || packet.event?.type === "history.reset") return;
	const next: SessionSnapshot = { ...current, ...packet.state, revision: packet.revision, turn: packet.turn };
	const event = packet.event;
	if (event?.type === "message_start" && event.message)
		next.streamingMessage = structuredClone(event.message) as WireMessage;
	if (event?.type === "message_end" && event.message) {
		const message = structuredClone(event.message) as WireMessage;
		const identity = messageIdentity(message);
		const existing = current.messages.findIndex((value) => messageIdentity(value) === identity);
		next.messages = [...current.messages];
		if (existing < 0) next.messages.push(message);
		else next.messages[existing] = message;
		if (next.streamingMessage && messageIdentity(next.streamingMessage) === identity)
			next.streamingMessage = undefined;
	}
	if (event?.type === "message_update" && next.streamingMessage?.role === "assistant") {
		const update = event.assistantMessageEvent as {
			type: string;
			contentIndex?: number;
			delta?: string;
			content?: string;
			toolCall?: Extract<WireMessage, { role: "assistant" }>["content"][number];
		};
		if (update && typeof update.contentIndex === "number") {
			const message = structuredClone(next.streamingMessage);
			const index = update.contentIndex;
			if (update.type === "text_start") message.content[index] = { type: "text", text: "" };
			if (update.type === "thinking_start") message.content[index] = { type: "thinking", thinking: "" };
			if (update.type === "toolcall_start" && update.toolCall)
				message.content[index] = structuredClone(update.toolCall);
			const block = message.content[index];
			if (block?.type === "text") {
				if (update.type === "text_delta") block.text += update.delta ?? "";
				if (update.type === "text_end") block.text = update.content ?? block.text;
			}
			if (block?.type === "thinking") {
				if (update.type === "thinking_delta") block.thinking += update.delta ?? "";
				if (update.type === "thinking_end") block.thinking = update.content ?? block.thinking;
			}
			if (block?.type === "toolCall") {
				if (update.type === "toolcall_delta")
					block.argumentsText = (block.argumentsText ?? "") + (update.delta ?? "");
				if (update.type === "toolcall_end" && update.toolCall)
					message.content[index] = structuredClone(update.toolCall);
			}
			next.streamingMessage = message;
		}
	}
	if (packet.type === "turn.settled") next.streamingMessage = undefined;
	return next;
}

export function materializeSessionEvent(
	current: SessionSnapshot | undefined,
	packet: SessionEvent,
): MaterializedSessionEvent | undefined {
	const snapshot = applySessionEvent(current, packet);
	return snapshot ? { ...packet, snapshot } : undefined;
}

export function prependHistoryPage(
	current: SessionSnapshot,
	page: SessionHistoryPage,
	beforeSeq: number,
): SessionSnapshot {
	if (
		current.instanceId !== page.instanceId ||
		!current.history ||
		current.history.leafId !== page.leafId ||
		current.history.nextBeforeSeq !== beforeSeq
	)
		return current;
	const known = new Set(current.messages.map(messageIdentity));
	return {
		...current,
		messages: [
			...page.entries.map((entry) => entry.message).filter((message) => !known.has(messageIdentity(message))),
			...current.messages,
		],
		history: { leafId: page.leafId, nextBeforeSeq: page.nextBeforeSeq },
	};
}
