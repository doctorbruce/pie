import assert from "node:assert/strict";
import test from "node:test";
import { hydrateHostRuntime, parseHostRuntimeDefinition } from "../src/config.ts";

test("host compaction rejects invalid thresholds before accepting the runtime", () => {
	for (const thresholdTokens of [0, -1, 1.5, "200000", null, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(
			() =>
				parseHostRuntimeDefinition(
					{
						assistantId: "invalid",
						assistantRevision: "1",
						runtime: { systemPrompt: "", toolIds: [], skills: [], compaction: { thresholdTokens } },
					},
					[],
				),
			/compaction.thresholdTokens/,
		);
	}
});

test("subagents receive their own host compaction policy, including a default reset", () => {
	const child = parseHostRuntimeDefinition(
		{
			assistantId: "child",
			assistantRevision: "1",
			runtime: { systemPrompt: "", toolIds: [], skills: [], compaction: { thresholdTokens: 120000 } },
		},
		[],
	);
	const parent = parseHostRuntimeDefinition(
		{
			assistantId: "parent",
			assistantRevision: "1",
			runtime: {
				systemPrompt: "",
				toolIds: [],
				skills: [],
				compaction: { thresholdTokens: 200000 },
				subagents: [{ id: "child", name: "Child", description: "Test child", assistantId: "child" }],
			},
		},
		[],
	);
	const registry = new Map([
		[parent.assistantId, parent],
		[child.assistantId, child],
	]);
	const runtime = hydrateHostRuntime(parent, registry);
	assert.deepEqual(runtime.compaction, { thresholdTokens: 200000 });
	assert.deepEqual(runtime.subagents[0].runtime.compaction, { thresholdTokens: 120000 });
	child.runtime.compaction = {};
	assert.deepEqual(hydrateHostRuntime(parent, registry).subagents[0].runtime.compaction, {});
});
