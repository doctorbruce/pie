import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { SessionTree } from "./protocol.ts";
import { displayAgentMessages } from "./session-transfer.ts";

export type MessageTree = {
	nodes: { id: string; parentId: string | null; message: AgentMessage; seq?: number }[];
	leafId: string | null;
};

export function historyMessageId(message: AgentMessage): string {
	const id: unknown = Reflect.get(message, "id");
	return typeof id === "string" && id ? id : `pie:${message.role}:${message.timestamp}`;
}

export function treePath(tree: MessageTree, leafId = tree.leafId): MessageTree["nodes"] {
	const byId = new Map(tree.nodes.map((node) => [node.id, node]));
	const path: MessageTree["nodes"] = [];
	const visited = new Set<string>();
	while (leafId !== null) {
		if (visited.has(leafId)) throw new Error("会话树存在循环");
		visited.add(leafId);
		const node = byId.get(leafId);
		if (!node) throw new Error("会话树节点不存在");
		path.push(node);
		leafId = node.parentId;
	}
	return path.reverse();
}

export function syncMessageTree(tree: MessageTree | undefined, messages: AgentMessage[]): MessageTree {
	const result = tree ?? { nodes: [], leafId: null };
	const path = treePath(result);
	let shared = 0;
	while (shared < path.length && shared < messages.length) {
		if (JSON.stringify(path[shared].message) !== JSON.stringify(messages[shared])) break;
		shared++;
	}
	result.leafId = path[shared - 1]?.id ?? null;
	for (const message of messages.slice(shared)) {
		const node: MessageTree["nodes"][number] = {
			id: randomUUID(),
			parentId: result.leafId,
			message: structuredClone(message),
		};
		result.nodes.push(node);
		result.leafId = node.id;
	}
	return result;
}

export function completeToolHistory(messages: AgentMessage[]): boolean {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) return false;
		}
	}
	return pending.size === 0;
}

export function sessionTree(tree: MessageTree): SessionTree {
	const active = new Set(treePath(tree).map((node) => node.id));
	return {
		leafId: tree.leafId,
		entries: tree.nodes.map((node) => {
			const displayed = displayAgentMessages([node.message])[0];
			const path = treePath(tree, node.message.role === "user" ? node.parentId : node.id);
			return {
				id: node.id,
				parentId: node.parentId,
				messageId: historyMessageId(node.message),
				role: node.message.role,
				text: displayed ? contentText(displayed.content) : "",
				active: active.has(node.id),
				selectable: Boolean(displayed) && completeToolHistory(path.map((entry) => entry.message)),
			};
		}),
	};
}
