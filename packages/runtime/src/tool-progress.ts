import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export function withToolProgress(tool: AgentTool): AgentTool {
	return {
		...tool,
		async execute(callId, args, signal, onUpdate) {
			signal?.throwIfAborted();
			if (!onUpdate) return tool.execute(callId, args, signal);
			const startedAt = Date.now();
			let lastActivityAt = startedAt;
			let latest: AgentToolResult<unknown> | undefined;
			let active = true;
			const timer = setInterval(() => {
				const elapsedMs = Date.now() - startedAt;
				const quietMs = Date.now() - lastActivityAt;
				const message = `仍在执行（已等待 ${Math.floor(elapsedMs / 1000)} 秒，最近活动距今 ${Math.floor(quietMs / 1000)} 秒）`;
				const details = latest?.details;
				onUpdate({
					content: [...(latest?.content ?? []), { type: "text", text: message }],
					details: {
						...(details !== null && typeof details === "object" && !Array.isArray(details) ? details : {}),
						progress: {
							message,
							elapsedMs,
							quietMs,
							lastActivityAt,
							health: quietMs >= 120_000 ? "quiet" : "ok",
						},
					},
				});
			}, 60_000);
			timer.unref?.();
			const stop = () => {
				active = false;
				clearInterval(timer);
			};
			signal?.addEventListener("abort", stop, { once: true });
			try {
				return await tool.execute(callId, args, signal, (update) => {
					if (!active) return;
					latest = update;
					lastActivityAt = Date.now();
					onUpdate(update);
				});
			} finally {
				stop();
				signal?.removeEventListener("abort", stop);
			}
		},
	};
}
