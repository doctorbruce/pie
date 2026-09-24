import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTransfer, TransferContentPart, TransferMessage } from "./protocol.ts";
import type { SavedSession } from "./store.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function transferPart(value: unknown): TransferContentPart {
	const part = record(value);
	if (!part || !text(part.type)) throw new Error("transcript content 需要带 type 的对象");
	return structuredClone(part) as TransferContentPart;
}

function transferMessage(value: unknown): TransferMessage {
	const message = record(value);
	if (!message || !["user", "assistant", "system"].includes(String(message.role)))
		throw new Error("transcript message role 无效");
	if (!Array.isArray(message.content)) throw new Error("transcript message content 需要数组");
	const role = message.role as TransferMessage["role"];
	const metadata = record(message.metadata);
	return {
		id: text(message.id),
		role,
		content: message.content.map(transferPart),
		metadata: metadata ? structuredClone(metadata) : undefined,
		createdAt: timestamp(message.createdAt),
	};
}

export function parseSessionTransfer(value: Record<string, unknown>): SessionTransfer {
	if (value.schemaVersion !== 1) throw new Error("仅支持 session transfer schemaVersion 1");
	const source = record(value.source);
	const astronSessionId = text(source?.astronSessionId);
	const coreId = text(source?.coreId);
	const sessionId = text(source?.sessionId);
	if (!astronSessionId || !coreId || !sessionId) throw new Error("session transfer source 无效");
	if (!Array.isArray(value.transcript)) throw new Error("session transfer transcript 需要数组");
	return {
		schemaVersion: 1,
		source: { astronSessionId, coreId, sessionId },
		title: text(value.title),
		workspacePath: text(value.workspacePath),
		persona: text(value.persona),
		transcript: value.transcript.map(transferMessage),
		createdAt: timestamp(value.createdAt),
		updatedAt: timestamp(value.updatedAt),
	};
}

function renderedPart(part: TransferContentPart): string | undefined {
	if (part.type === "text") return text(part.text);
	if (part.type === "file") {
		const label = text(part.name) ?? "文件";
		const location = text(part.uri);
		return location ? `[${label}](${location})` : `[${label}]`;
	}
	return undefined;
}

function toolResultText(state: Record<string, unknown> | undefined): string {
	const value = state?.output ?? state?.error;
	if (typeof value === "string") return value;
	if (value === undefined) return "导入的工具调用没有保存输出。";
	return JSON.stringify(value);
}

export function transferToAgentMessages(transfer: SessionTransfer): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const source of transfer.transcript) {
		const createdAt = source.createdAt ?? transfer.updatedAt ?? Date.now();
		if (source.role !== "assistant") {
			const content = source.content.flatMap((part) => {
				const rendered = renderedPart(part);
				return rendered ? [{ type: "text" as const, text: rendered }] : [];
			});
			const prefix = source.role === "system" ? "[系统消息]\n" : "";
			if (content.length === 0) content.push({ type: "text", text: prefix || "[空消息]" });
			else if (prefix) content[0] = { ...content[0], text: prefix + content[0].text };
			messages.push({ role: "user", content, timestamp: createdAt });
			continue;
		}
		const content: Extract<AgentMessage, { role: "assistant" }>["content"] = [];
		const toolResults: Extract<AgentMessage, { role: "toolResult" }>[] = [];
		for (const [partIndex, part] of source.content.entries()) {
			if (part.type === "text" && typeof part.text === "string") {
				content.push({ type: "text", text: part.text });
				continue;
			}
			if (part.type === "thought" && typeof part.text === "string") {
				content.push({ type: "thinking", thinking: part.text });
				continue;
			}
			if (part.type !== "tool") continue;
			const state = record(part.state);
			const callId = text(part.callID) ?? text(part.id) ?? `imported-tool-${messages.length}-${partIndex}`;
			const name = text(part.tool) ?? "imported_tool";
			const input = record(state?.input) ?? {};
			content.push({ type: "toolCall", id: callId, name, arguments: structuredClone(input) });
			toolResults.push({
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: [{ type: "text", text: toolResultText(state) }],
				isError: state?.status === "error",
				timestamp: createdAt,
			});
		}
		if (content.length === 0) content.push({ type: "text", text: "[空助手消息]" });
		messages.push({
			role: "assistant",
			content,
			api: "pie-transfer",
			provider: "pie-transfer",
			model: "imported",
			usage: structuredClone(EMPTY_USAGE),
			stopReason: toolResults.length ? "toolUse" : "stop",
			timestamp: createdAt,
		});
		messages.push(...toolResults);
	}
	return messages;
}

function canonicalContent(message: AgentMessage): TransferContentPart[] {
	if (message.role === "user") {
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return content.map((part) =>
			part.type === "image"
				? { type: "file", mimeType: part.mimeType, uri: `data:${part.mimeType};base64,${part.data}` }
				: { type: "text", text: part.text },
		);
	}
	if (message.role === "assistant") {
		return message.content.map((part) => {
			if (part.type === "thinking") return { type: "thought", text: part.thinking };
			if (part.type === "toolCall") {
				return {
					type: "tool",
					tool: part.name,
					callID: part.id,
					state: { status: "pending", input: structuredClone(part.arguments) },
				};
			}
			return { type: "text", text: part.text };
		});
	}
	return [];
}

export function agentMessagesToTransfer(messages: AgentMessage[], sessionId: string): TransferMessage[] {
	const transcript: TransferMessage[] = [];
	const tools = new Map<string, TransferContentPart>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			if (tool) {
				tool.state = {
					status: message.isError ? "error" : "completed",
					input: record(record(tool.state)?.input) ?? {},
					output: message.content
						.map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`))
						.join("\n"),
				};
			}
			continue;
		}
		const content = canonicalContent(message);
		const canonical: TransferMessage = {
			id: `pie:${sessionId}:${index}`,
			role: message.role,
			content,
			createdAt: message.timestamp,
		};
		transcript.push(canonical);
		for (const part of content) {
			if (part.type === "tool" && typeof part.callID === "string") tools.set(part.callID, part);
		}
	}
	return transcript;
}

export function exportSession(session: SavedSession): SessionTransfer {
	const prefix = session.transferBase ?? [];
	const prefixMessageCount = session.transferBaseMessageCount ?? 0;
	const suffix = agentMessagesToTransfer(session.messages.slice(prefixMessageCount), session.id);
	return {
		schemaVersion: 1,
		source: { astronSessionId: session.astronSessionId ?? session.id, coreId: "pie", sessionId: session.id },
		title: session.title,
		workspacePath: session.workspacePath,
		transcript: [...structuredClone(prefix), ...suffix],
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
	};
}
