import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "./compaction/overflow.ts";
import { type RetryPolicy, retryAssistantCall } from "./compaction/retry.ts";
import type { ModelRetryEvent } from "./protocol.ts";

export function createRetryStream(
	stream: StreamFn,
	policy: RetryPolicy | undefined,
	report?: (event: ModelRetryEvent) => unknown,
): StreamFn {
	return (model, context, request) => {
		const output = createAssistantMessageEventStream();
		let visible = false;
		let lastMessage: AssistantMessage | undefined;
		let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
		let retry: ModelRetryEvent | undefined;
		void (async () => {
			const response = await retryAssistantCall(
				async () => {
					request?.signal?.throwIfAborted();
					let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
					const source = await stream(model, context, { ...request, maxRetries: 0 });
					for await (const event of source) {
						lastMessage =
							event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
						if (event.type === "start") {
							start = event;
							continue;
						}
						if (event.type === "error" || event.type === "done") {
							terminal = event;
							if (event.type === "done" && start) output.push(start);
							return lastMessage;
						}
						if (start) output.push(start);
						start = undefined;
						visible = true;
						output.push(event);
					}
					throw new Error("模型流在结束事件之前中断");
				},
				policy,
				request?.signal,
				{
					// Streamed tool calls may already have side effects once an update is forwarded.
					shouldRetry: (message) =>
						!visible &&
						!isContextOverflow(message, model.contextWindow) &&
						message.content.every((block) =>
							block.type === "text" ? !block.text : block.type === "thinking" ? !block.thinking : false,
						),
					onRetryScheduled: async (attempt, _maxAttempts, delayMs, message) => {
						retry = {
							type: "model.retry",
							retryId: retry?.retryId ?? randomUUID(),
							status: "started",
							attempt,
							message,
							next: Date.now() + delayMs,
						};
						await report?.(retry);
					},
					onRetryFinished: async (success, attempt, message) => {
						if (!retry) return;
						retry = {
							type: "model.retry",
							retryId: retry.retryId,
							status: success ? "completed" : "failed",
							attempt,
							message: message ?? retry.message,
						};
						await report?.(retry);
					},
				},
			);
			if (response.stopReason === "aborted") output.push({ type: "error", reason: "aborted", error: response });
			else if (terminal) output.push(terminal);
		})().catch(async (error: unknown) => {
			const aborted = request?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
			const response: AssistantMessage = {
				...(lastMessage ?? fauxAssistantMessage("")),
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			if (retry?.status === "started") {
				try {
					await report?.({
						type: "model.retry",
						retryId: retry.retryId,
						status: "failed",
						attempt: retry.attempt,
						message: response.errorMessage ?? retry.message,
					});
				} catch {}
			}
			output.push({ type: "error", reason: aborted ? "aborted" : "error", error: response });
		});
		return output;
	};
}
