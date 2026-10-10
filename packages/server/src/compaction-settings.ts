import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RetryPolicy } from "./compaction/retry.ts";
import type { CompactionSettings } from "./compaction.ts";
import { stripJsonComments } from "./models/json.ts";

type CompactionModel = { provider: string; id: string; contextWindow: number; maxTokens: number };

function object(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
	return value as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${field} 必须是非负整数`);
	return value;
}

function boolean(value: unknown, fallback: boolean, field: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值`);
	return value;
}

export function resolveCompactionSettings(
	value: unknown,
	model: CompactionModel,
): { compaction: CompactionSettings; retry: RetryPolicy } {
	const root = object(value, "settings");
	const compaction = object(root.compaction, "compaction");
	const overrides = object(compaction.modelOverrides, "compaction.modelOverrides");
	const selected = {
		...compaction,
		...object(overrides[`${model.provider}/${model.id}`], "compaction.modelOverrides"),
	};
	const window = model.contextWindow;
	const reserveTokens = integer(
		selected.reserveTokens,
		Math.min(16384, Math.max(1, Math.floor(window / 4))),
		"reserveTokens",
	);
	const usable = Math.min(Math.floor(window * 0.9), window - reserveTokens);
	if (usable <= 0) throw new Error("reserveTokens 必须小于模型上下文窗口");
	const thresholdTokens = Math.min(integer(selected.thresholdTokens, usable, "thresholdTokens"), usable);
	if (thresholdTokens === 0) throw new Error("thresholdTokens 必须大于 0");
	const retry = object(root.retry, "retry");
	return {
		compaction: {
			enabled: boolean(selected.enabled, true, "compaction.enabled"),
			reserveTokens,
			keepRecentTokens: Math.min(
				integer(selected.keepRecentTokens, 20000, "keepRecentTokens"),
				Math.max(1, Math.floor(thresholdTokens / 2)),
			),
			thresholdTokens,
		},
		retry: {
			enabled: boolean(retry.enabled, true, "retry.enabled"),
			maxRetries: integer(retry.maxRetries, 3, "retry.maxRetries"),
			baseDelayMs: integer(retry.baseDelayMs, 2000, "retry.baseDelayMs"),
			maxAgentDelayMs: integer(retry.maxAgentDelayMs, 60000, "retry.maxAgentDelayMs"),
		},
	};
}

export function readCompactionSettings(env: NodeJS.ProcessEnv, model: CompactionModel) {
	const path = resolve(env.PI_DATA_DIR ?? ".pie", "settings.json");
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveCompactionSettings({}, model);
		throw error;
	}
	return resolveCompactionSettings(JSON.parse(stripJsonComments(content)), model);
}
