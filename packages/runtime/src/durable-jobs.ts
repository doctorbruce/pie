import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";

export type DurableJobReference = {
	id: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	toolName: string;
};

export type DurableJobSnapshot = DurableJobReference & {
	status: "running" | "completed" | "failed" | "cancelled" | "unknown";
	result?: Pick<AgentToolResult<unknown>, "content" | "details" | "usage">;
	error?: string;
};

export type DurableJobExecutor = {
	submit(request: DurableJobReference & { arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<void>;
	get(reference: DurableJobReference, signal?: AbortSignal): Promise<DurableJobSnapshot | undefined>;
	cancel(reference: DurableJobReference): Promise<void>;
	pollIntervalMs?: number;
};

export class DurableJobError extends Error {}

export function pendingDurableJobs(
	sessionId: string,
	turnId: string,
	references: readonly DurableJobReference[],
	messages: readonly AgentMessage[],
): DurableJobReference[] {
	const calls = new Map<string, string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (calls.has(part.id)) throw new Error("工具调用身份重复");
				calls.set(part.id, part.name);
			}
		} else if (message.role === "toolResult") {
			if (calls.get(message.toolCallId) !== message.toolName || results.has(message.toolCallId))
				throw new Error("工具结果与调用不匹配");
			results.add(message.toolCallId);
		}
	}
	const jobs = new Map<string, DurableJobReference>();
	const identities = new Set<string>();
	for (const reference of references) {
		if (
			!reference.id ||
			reference.sessionId !== sessionId ||
			reference.turnId !== turnId ||
			calls.get(reference.toolCallId) !== reference.toolName ||
			jobs.has(reference.toolCallId) ||
			identities.has(reference.id)
		)
			throw new Error("外部任务关联与当前 Turn 不匹配");
		jobs.set(reference.toolCallId, reference);
		identities.add(reference.id);
	}
	return [...calls.keys()].flatMap((toolCallId) => {
		if (results.has(toolCallId)) return [];
		const reference = jobs.get(toolCallId);
		if (!reference) throw new Error("工具执行结果未知且没有外部任务关联");
		return [structuredClone(reference)];
	});
}

export function durableJobResult(
	reference: DurableJobReference,
	snapshot: DurableJobSnapshot | undefined,
): Extract<AgentMessage, { role: "toolResult" }> | undefined {
	if (!snapshot) throw new DurableJobError("外部任务不存在，未重新提交，请核对执行器");
	for (const key of ["id", "sessionId", "turnId", "toolCallId", "toolName"] as const)
		if (snapshot[key] !== reference[key]) throw new DurableJobError("外部任务结果身份不匹配");
	if (snapshot.status === "running") return undefined;
	if (snapshot.status === "unknown") throw new DurableJobError("外部任务结果未知，未重新提交，请核对执行器");
	if (!["completed", "failed", "cancelled"].includes(snapshot.status)) throw new DurableJobError("外部任务状态无效");
	if (snapshot.status === "completed" && !snapshot.result) throw new DurableJobError("外部任务缺少已提交结果");
	if (snapshot.result && !Array.isArray(snapshot.result.content)) throw new DurableJobError("外部任务结果格式无效");
	const result = structuredClone(snapshot.result);
	return {
		role: "toolResult",
		toolCallId: reference.toolCallId,
		toolName: reference.toolName,
		content: result?.content ?? [
			{ type: "text", text: snapshot.error ?? `外部任务已${snapshot.status === "cancelled" ? "取消" : "失败"}` },
		],
		details: {
			...(result?.details && typeof result.details === "object" && !Array.isArray(result.details)
				? result.details
				: { resultDetails: result?.details }),
			durableJob: { ...reference, status: snapshot.status },
		},
		usage: result?.usage,
		isError: snapshot.status !== "completed",
		timestamp: Date.now(),
	};
}
