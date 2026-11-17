import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import { createAgentFactory } from "../src/agent.ts";
import { checkpointMessage } from "../src/compaction.ts";
import type { ContextCompaction } from "../src/protocol.ts";
import type { ExternalTool } from "../src/tools.ts";

test("manual checkpoints preserve discovered native and MCP tools without connecting MCP during summarization", async (context) => {
	for (const restored of [false, true]) {
		await context.test(restored ? "update an existing checkpoint" : "first checkpoint", async () => {
			const provider = fauxProvider({ models: [{ id: "test", contextWindow: 10000, maxTokens: 100 }] });
			const models = createModels();
			models.setProvider(provider.provider);
			const tool = (name: string): ExternalTool => ({
				name,
				label: name,
				description: name,
				exposure: "deferred",
				parameters: Type.Object({}),
				async execute() {
					assert.fail("compaction must not execute tools");
				},
			});
			let connections = 0;
			const factory = createAgentFactory({
				models: { current: { models, selected: { provider: provider.getModel().provider, id: "test" } } },
				tools: { catalog: [{ id: "mail", label: "mail" }], create: () => [tool("mail")] },
				skills: () => ({ tools: [], afterToolCall: async () => undefined }),
				compactionSettings: () => ({
					compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
					retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
				}),
				recordModelRequest: () => async () => undefined,
				mcp: {
					configure() {},
					status: () => ({ servers: {} }),
					async acquire() {
						connections++;
						return {
							tools: [tool("mcp__new"), tool("mcp__added"), tool("mcp__old")],
							instructions: [],
							release() {},
						};
					},
					async close() {},
				},
			});
			const initial: ContextCompaction | undefined = restored
				? {
						summary: "old checkpoint",
						firstKeptMessage: 10,
						tokensBefore: 100,
						estimatedTokensAfter: 10,
						compactedAt: 1,
						generation: 1,
						loadedToolNames: ["mcp__old"],
					}
				: undefined;
			const messages: AgentMessage[] = [
				...(initial ? [checkpointMessage(initial)] : []),
				{ role: "user", content: "old question", timestamp: 2 },
				fauxAssistantMessage([
					{ type: "toolCall", id: "search", name: "tool_search", arguments: { query: "tools" } },
				]),
				{
					role: "toolResult",
					toolCallId: "search",
					toolName: "tool_search",
					content: [{ type: "text", text: JSON.stringify({ loaded: ["mail", "mcp__new", "mcp__disabled"] }) }],
					addedToolNames: ["mcp__added"],
					isError: false,
					timestamp: 4,
				},
				{ role: "user", content: "latest question", timestamp: 5 },
				fauxAssistantMessage("latest answer"),
			];
			const runtime = { systemPrompt: "", toolIds: ["mail"], skills: [], subagents: [] };
			let projected: AgentMessage[] = [];
			const agent = factory.create("real", "manual", runtime, undefined, messages, undefined, undefined, {
				current: initial,
				update: (_next, _source, nextMessages) => {
					projected = nextMessages;
				},
			});
			provider.setResponses([fauxAssistantMessage("new checkpoint")]);
			const result = await agent.compact();
			assert.equal(connections, 0);
			assert.equal(result.compacted, true);
			assert(result.compaction);
			assert(result.compaction.loadedToolNames?.includes("mail"));
			assert(result.compaction.loadedToolNames?.includes("mcp__new"));
			assert(result.compaction.loadedToolNames?.includes("mcp__added"));
			assert.equal(result.compaction.loadedToolNames?.includes("mcp__old"), restored);
			assert(!projected.some((message) => message.role === "toolResult"));
			const next = factory.create("real", "manual", runtime, undefined, projected, undefined, undefined, {
				current: result.compaction,
				update: () => assert.fail("disabled automatic compaction must not run"),
			});
			const release = await next.prepareMcp();
			try {
				provider.setResponses([
					(request) => {
						const names = request.tools?.map((tool) => tool.name) ?? [];
						assert(names.includes("mail"));
						assert(names.includes("mcp__new"));
						assert(names.includes("mcp__added"));
						assert.equal(names.includes("mcp__old"), restored);
						assert(!names.includes("mcp__disabled"));
						return fauxAssistantMessage("continued");
					},
				]);
				await next.prompt("continue");
				assert.equal(next.state.errorMessage, undefined);
				assert.equal(connections, 1);
			} finally {
				release();
			}
		});
	}
});
