import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentMessage } from "../src/index.ts";

it("replaces state, live loop context and accumulated messages between provider requests", async () => {
	const old: AgentMessage = { role: "user", content: "old history", timestamp: 1 };
	const current: AgentMessage = { role: "user", content: "current input", timestamp: 2 };
	let calls = 0;
	let lastBatch: AgentMessage[] = [];
	const agent = new Agent({
		initialState: {
			messages: [old, current],
			tools: [
				{
					name: "read",
					label: "read",
					description: "read",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "large result" }], details: {} };
					},
				},
			],
		},
		streamFn: (_model, context) => {
			const stream = createAssistantMessageEventStream();
			calls++;
			if (calls === 2) {
				agent.replaceMessages([current]);
				context.messages = [current];
			}
			if (calls === 3) {
				expect(context.messages).toHaveLength(3);
				expect(context.messages[0]).toBe(current);
			}
			const message =
				calls < 3
					? fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			return stream;
		},
	});
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "agent_end") lastBatch = event.messages;
	});
	await agent.continue();
	expect(calls).toBe(3);
	expect(agent.state.messages).toHaveLength(4);
	expect(agent.state.messages[0]).toBe(current);
	expect(lastBatch).toHaveLength(3);
	expect(lastBatch[0]).toBe(agent.state.messages[1]);
	agent.replaceMessages(agent.state.messages);
	expect(agent.state.messages).toHaveLength(4);
});
