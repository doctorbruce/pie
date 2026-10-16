import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SessionEvent } from "./protocol.ts";
import { displayAgentMessages } from "./session-transfer.ts";
import { historyMessageId } from "./session-tree.ts";

export function projectSessionAgentEvent(event: SessionEvent["event"]): SessionEvent["event"] {
	if (!event) return;
	if (event.type === "message_start" || event.type === "message_end") {
		const message = event.message as AgentMessage;
		if (event.type === "message_start" && message.role !== "assistant") return;
		const displayed = displayAgentMessages([message])[0];
		return displayed ? { type: event.type, messageId: historyMessageId(message), message: displayed } : undefined;
	}
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent as AssistantMessageEvent;
		if (!("partial" in update)) return;
		const { partial, ...delta } = update;
		return {
			type: event.type,
			messageId: historyMessageId(event.message as AgentMessage),
			assistantMessageEvent: {
				...delta,
				...(update.type === "toolcall_start" ? { toolCall: partial.content[update.contentIndex] } : {}),
			},
		};
	}
	if (event.type === "agent_end" || event.type === "turn_end") return { type: event.type };
	return event;
}
