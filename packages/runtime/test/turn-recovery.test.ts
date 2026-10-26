import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { recoverInterruptedTurn, type SessionMetadata } from "@pie/runtime";
import type { MessageTree } from "@pie/runtime/session-tree";

const input: AgentMessage = { role: "user", content: "original input", timestamp: 1 };
const call = fauxAssistantMessage([fauxToolCall("effect", {}, { id: "call-1" })], { stopReason: "toolUse" });
const result: AgentMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "effect",
	content: [{ type: "text", text: "committed result" }],
	isError: false,
	timestamp: 3,
};

function fixture(messages: AgentMessage[] = [input]) {
	const tree: MessageTree = {
		leafId: `entry-${messages.length - 1}`,
		nodes: messages.map((message, index) => ({
			id: `entry-${index}`,
			parentId: index ? `entry-${index - 1}` : null,
			seq: index + 1,
			message: structuredClone(message),
		})),
	};
	const session: SessionMetadata = {
		id: "session",
		kind: "root",
		assistantId: "assistant",
		runtimeSource: "host",
		title: "Recovery",
		mode: "faux",
		model: "faux",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		leafId: tree.leafId,
		turn: { id: "turn", requestId: "request", status: "running" },
		runtime: { systemPrompt: "original", toolIds: ["effect"], skills: [], subagents: [] },
		turnCheckpoint: { version: 1, turnId: "turn", inputEntryId: "entry-0", systemPrompt: "dynamic\noriginal" },
	};
	return { session, tree };
}

test("recovery preserves Turn identity at committed input and complete tool-result boundaries", () => {
	for (const messages of [[input], [input, call, result]]) {
		const { session, tree } = fixture(messages);
		const before = structuredClone({ session, tree });
		assert.deepEqual(recoverInterruptedTurn(session, tree), {
			id: "turn",
			requestId: "request",
			status: "interrupted",
			error: undefined,
		});
		assert.deepEqual({ session, tree }, before);
	}
});

test("recovery accepts a standalone suffix that starts at the Turn input", () => {
	const { session, tree } = fixture([{ role: "user", content: "older input", timestamp: 0 }, input, call, result]);
	session.turnCheckpoint!.inputEntryId = "entry-1";
	const suffix = {
		leafId: tree.leafId,
		nodes: tree.nodes.slice(1).map((node, index) => (index === 0 ? { ...node, parentId: null } : node)),
	};
	assert.equal(recoverInterruptedTurn(session, suffix)?.status, "interrupted");
});

test("recovery classifies empty, missing and cyclic paths as failed without throwing", () => {
	const mutations: ((tree: MessageTree) => void)[] = [
		(tree) => {
			tree.nodes = [];
		},
		(tree) => {
			tree.leafId = "missing";
		},
		(tree) => {
			tree.nodes.at(-1)!.parentId = "missing";
		},
		(tree) => {
			tree.nodes.at(-1)!.parentId = tree.leafId;
		},
	];
	for (const mutate of mutations) {
		const { session, tree } = fixture([input, call, result]);
		mutate(tree);
		const before = structuredClone({ session, tree });
		const recovered = recoverInterruptedTurn(session, tree);
		assert.equal(recovered?.status, "failed");
		assert.match(recovered?.error ?? "", /路径/);
		assert.deepEqual({ session, tree }, before);
	}
});

test("recovery settles committed final answers and never retries recorded errors or aborts", () => {
	for (const stopReason of ["stop", "error", "aborted"] as const) {
		const { session, tree } = fixture([input, fauxAssistantMessage("final", { stopReason })]);
		assert.equal(
			recoverInterruptedTurn(session, tree)?.status,
			stopReason === "stop" ? "completed" : stopReason === "error" ? "failed" : "cancelled",
		);
	}
});

test("recovery blocks missing tool results, including a partially completed parallel batch", () => {
	const parallel = fauxAssistantMessage(
		[fauxToolCall("effect", {}, { id: "call-1" }), fauxToolCall("effect", {}, { id: "call-2" })],
		{ stopReason: "toolUse" },
	);
	for (const messages of [
		[input, call],
		[input, parallel, result],
	]) {
		const { session, tree } = fixture(messages);
		const recovered = recoverInterruptedTurn(session, tree);
		assert.equal(recovered?.status, "failed");
		assert.match(recovered?.error ?? "", /结果未知/);
	}
});

test("recovery rejects missing checkpoints, mismatched Turns, invalid input paths and unsupported queues", () => {
	const mutations: ((session: SessionMetadata) => void)[] = [
		(session) => {
			session.turnCheckpoint = undefined;
		},
		(session) => {
			session.turnCheckpoint!.turnId = "other";
		},
		(session) => {
			session.turnCheckpoint!.inputEntryId = "missing";
		},
		(session) => {
			session.turnCheckpoint!.blockedReason = "存在未提交的队列";
		},
		(session) => {
			session.runtime = undefined;
		},
		(session) => {
			session.kind = "subagent";
		},
	];
	for (const mutate of mutations) {
		const { session, tree } = fixture();
		mutate(session);
		assert.equal(recoverInterruptedTurn(session, tree)?.status, "failed");
	}
});

test("recovery does not resurrect terminal Turns", () => {
	for (const status of ["completed", "failed", "cancelled"] as const) {
		const { session, tree } = fixture();
		session.turn = { ...session.turn!, status, error: "original" };
		assert.deepEqual(recoverInterruptedTurn(session, tree), session.turn);
	}
});

test("a background result stays non-resumable even if its in-memory job already finished", () => {
	const { session, tree } = fixture([input, call, { ...result, details: { background: true } }]);
	assert.equal(recoverInterruptedTurn(session, tree)?.status, "failed");
});

test("recovery honors durable cancellation and rejects ambiguous duplicate tool identities", () => {
	const cancelled = fixture([input, call]);
	cancelled.session.turnCheckpoint!.cancelRequested = true;
	assert.equal(recoverInterruptedTurn(cancelled.session, cancelled.tree)?.status, "cancelled");
	const duplicate = fauxAssistantMessage(
		[fauxToolCall("effect", {}, { id: "call-1" }), fauxToolCall("effect", {}, { id: "call-1" })],
		{ stopReason: "toolUse" },
	);
	const ambiguous = fixture([input, duplicate, result]);
	assert.equal(recoverInterruptedTurn(ambiguous.session, ambiguous.tree)?.status, "failed");
});
