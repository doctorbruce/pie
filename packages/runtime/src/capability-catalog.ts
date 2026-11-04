import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

export function isCapabilityCatalog(message: AgentMessage): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some(
			(part) => part.type === "text" && Reflect.get(part, "metadata")?.kind === "capability_catalog",
		)
	);
}

export function nextCapabilityCatalog(
	messages: AgentMessage[],
	catalog: string,
	language?: string,
): UserMessage | undefined {
	const digest = createHash("sha256").update(catalog).digest("hex");
	const previous = [...messages].reverse().find(isCapabilityCatalog);
	const part =
		previous?.role === "user" && Array.isArray(previous.content)
			? previous.content.find(
					(part) => part.type === "text" && Reflect.get(part, "metadata")?.kind === "capability_catalog",
				)
			: undefined;
	if (part && Reflect.get(part, "metadata")?.digest === digest) return;
	const chinese = language?.toLowerCase().startsWith("zh") ?? false;
	const notice = chinese
		? previous
			? "能力清单已变化。以下完整清单替代历史中的所有技能和插件清单。"
			: "以下是当前助手的技能和插件清单。"
		: previous
			? "Capabilities changed. This complete list replaces all earlier skill and plugin lists."
			: "These are the current assistant's skills and plugins.";
	return {
		role: "user",
		content: [
			Object.assign(
				{ type: "text" as const, text: `<system-reminder>\n${notice}\n\n${catalog}\n</system-reminder>` },
				{
					synthetic: true,
					metadata: { kind: "capability_catalog", digest },
				},
			),
		],
		timestamp: Date.now(),
	};
}
