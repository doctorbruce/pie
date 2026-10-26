import { pendingDurableJobs } from "./durable-jobs.ts";
import type { Turn } from "./protocol.ts";
import type { SessionMetadata } from "./runtime-store.ts";
import { completeToolHistory, type MessageTree, treePath } from "./session-tree.ts";

export function recoverInterruptedTurn(session: SessionMetadata, tree: MessageTree): Turn | undefined {
	const turn = session.turn;
	if (!turn || (turn.status !== "running" && turn.status !== "interrupted")) return structuredClone(turn);
	const failed = (error: string): Turn => ({ ...turn, status: "failed", error });
	const checkpoint = session.turnCheckpoint;
	if (
		!checkpoint ||
		checkpoint.version !== 1 ||
		checkpoint.turnId !== turn.id ||
		typeof checkpoint.systemPrompt !== "string" ||
		!session.runtime ||
		session.kind !== "root"
	)
		return failed("服务中断，缺少有效 Turn checkpoint；未自动续跑。");
	if (checkpoint.cancelRequested) return { ...turn, status: "cancelled", error: undefined };
	if (checkpoint.blockedReason) return failed(`服务中断，${checkpoint.blockedReason}；未自动续跑。`);
	if (
		session.activities?.some(
			(activity) => activity.turnId === turn.id && (activity.status === "running" || activity.status === "unknown"),
		)
	)
		return failed("服务中断，存在结果未知的技能活动；未自动续跑。");
	let path: MessageTree["nodes"];
	try {
		path = treePath(tree);
	} catch {
		return failed("服务中断，Turn 历史路径不完整或存在循环；未自动续跑。");
	}
	const start = path.findIndex((node) => node.id === checkpoint.inputEntryId);
	if (start < 0 || path[start].message.role !== "user")
		return failed("服务中断，Turn 输入节点不在当前历史路径；未自动续跑。");
	if (checkpoint.pendingAssistant)
		return failed("服务中断，模型响应尚未完成且工具已提前启动，执行结果未知、需核对；未自动重试或续跑。");
	const messages = path.slice(start).map((node) => node.message);
	if (
		messages.some(
			(message) =>
				message.role === "toolResult" &&
				message.details !== null &&
				typeof message.details === "object" &&
				Reflect.get(message.details, "background") === true,
		)
	)
		return failed("服务中断，包含后台工具执行，尚不支持接管；未自动续跑。");
	const toolIds = messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
			: [],
	);
	if (new Set(toolIds).size !== toolIds.length) return failed("服务中断，工具调用身份重复；未自动续跑。");
	if (!completeToolHistory(messages)) {
		try {
			const pending = pendingDurableJobs(session.id, turn.id, checkpoint.jobs ?? [], messages);
			if (pending.length) return { ...turn, status: "interrupted", error: undefined };
		} catch {
			return failed("服务中断，工具执行结果未知或外部任务关联无效；未自动重试或续跑。");
		}
		return failed("服务中断，工具执行结果未知；未自动重试或续跑。");
	}
	const last = messages.at(-1)!;
	if (last.role === "assistant") {
		if (last.stopReason === "error" || last.stopReason === "aborted")
			return { ...turn, status: last.stopReason === "aborted" ? "cancelled" : "failed", error: last.errorMessage };
		return { ...turn, status: "completed", error: undefined };
	}
	if (last.role !== "user" && last.role !== "toolResult")
		return failed("服务中断，历史不在可恢复的消息边界；未自动续跑。");
	return { ...turn, status: "interrupted", error: undefined };
}
