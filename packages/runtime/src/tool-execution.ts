export type ToolExecutionMode = "inline" | "delegated" | "durable";

export type ToolExecutionPhase =
	| "started"
	| "submission_intent"
	| "submitted"
	| "completed"
	| "failed"
	| "recovery_required";

export type ToolExecutionRecord = {
	id: string;
	executionId: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	toolName: string;
	mode: ToolExecutionMode;
	phase: ToolExecutionPhase;
	timestamp: number;
	externalId?: string;
	error?: string;
};

export type ToolExecutionReadOptions = { turnId: string; limit: number; afterSeq?: number };
export type ToolExecutionPage = {
	entries: (ToolExecutionRecord & { seq: number })[];
	nextAfterSeq: number | null;
};

export function createToolExecutionRecord(
	input: Omit<ToolExecutionRecord, "id" | "executionId" | "timestamp">,
): ToolExecutionRecord {
	return {
		...input,
		executionId: JSON.stringify([input.sessionId, input.turnId, input.toolCallId]),
		id: JSON.stringify([input.sessionId, input.turnId, input.toolCallId, input.phase]),
		timestamp: Date.now(),
	};
}

export function validateToolExecutionRead(options: ToolExecutionReadOptions): void {
	if (
		typeof options.turnId !== "string" ||
		!options.turnId.trim() ||
		!Number.isSafeInteger(options.limit) ||
		options.limit < 1 ||
		options.limit > 200 ||
		(options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0))
	)
		throw new Error("工具执行账本需要 Turn ID、1–200 条及有效 seq 游标");
}

export function validateToolExecutionRecord(record: ToolExecutionRecord, sessionId: string, turnId?: string): void {
	if (
		[record.sessionId, record.turnId, record.toolCallId, record.toolName].some(
			(value) => typeof value !== "string" || !value,
		) ||
		record.sessionId !== sessionId ||
		record.turnId !== turnId ||
		record.executionId !== JSON.stringify([record.sessionId, record.turnId, record.toolCallId]) ||
		record.id !== JSON.stringify([record.sessionId, record.turnId, record.toolCallId, record.phase]) ||
		!["inline", "delegated", "durable"].includes(record.mode) ||
		!["started", "submission_intent", "submitted", "completed", "failed", "recovery_required"].includes(
			record.phase,
		) ||
		!Number.isSafeInteger(record.timestamp) ||
		record.timestamp < 0 ||
		(record.externalId !== undefined && (typeof record.externalId !== "string" || !record.externalId)) ||
		(record.error !== undefined && (typeof record.error !== "string" || record.error.length > 4000)) ||
		((record.phase === "submission_intent" || record.phase === "submitted") &&
			(record.mode !== "durable" || !record.externalId))
	)
		throw new Error("工具执行账本身份或边界无效");
}
