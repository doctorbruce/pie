import type { AfterToolCallContext, AgentToolCall } from "@earendil-works/pi-agent-core";

const REPETITION_THRESHOLD = 3;

function toolCallKey(toolCall: AgentToolCall) {
	return JSON.stringify([toolCall.name, toolCall.arguments], (_key, value: unknown) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		return Object.fromEntries(
			Object.entries(value).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0)),
		);
	});
}

export function toolRepetitionReminder(
	{ assistantMessage, toolCall, context }: AfterToolCallContext,
	language?: string,
): string | undefined {
	const key = toolCallKey(toolCall);
	let foundCurrent = false;
	let count = 0;
	for (let messageIndex = context.messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = context.messages[messageIndex];
		if (message.role === "user") return;
		if (message.role !== "assistant") continue;
		for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
			const block = message.content[contentIndex];
			if (block.type !== "toolCall") continue;
			if (!foundCurrent) {
				if (message !== assistantMessage || block.id !== toolCall.id) continue;
				foundCurrent = true;
			}
			if (toolCallKey(block) !== key) return;
			if (++count < REPETITION_THRESHOLD) continue;
			return language?.trim().toLowerCase().startsWith("zh")
				? `<tool-repetition-reminder>你已连续至少 ${REPETITION_THRESHOLD} 次使用完全相同的参数调用同一工具。再次调用前，请检查已有结果是否足够，以及重复调用能获得什么新信息。若这是有必要的轮询或重试，可以继续；否则请调整方法或根据已有结果回答。此提醒不表示工具失败，也不表示任务完成。</tool-repetition-reminder>`
				: `<tool-repetition-reminder>You have called the same tool with identical arguments at least ${REPETITION_THRESHOLD} consecutive times. Before repeating it, check whether existing results are sufficient and what new information another call would provide. Continue if polling or retrying is justified; otherwise change approach or answer from the available results. This reminder does not mean the tool failed or the task is complete.</tool-repetition-reminder>`;
		}
	}
	return;
}
