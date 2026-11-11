import assert from "node:assert/strict";
import test from "node:test";
import { hydrateHostRuntime, parseHostRuntimeDefinition } from "../src/config.ts";

test("host image budgets reject invalid bytes before accepting configuration", () => {
	for (const maxHistoryImageBytes of [0, -1, 1.5, "128", null, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(
			() =>
				parseHostRuntimeDefinition(
					{
						assistantId: "invalid",
						assistantRevision: "1",
						runtime: { systemPrompt: "", toolIds: [], skills: [], maxHistoryImageBytes },
					},
					[],
				),
			/maxHistoryImageBytes/,
		);
	}
});

test("subagents use their own image budget and can reset to the default", () => {
	const child = parseHostRuntimeDefinition(
		{
			assistantId: "child",
			assistantRevision: "1",
			runtime: { systemPrompt: "", toolIds: [], skills: [], maxHistoryImageBytes: 128 },
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
				maxHistoryImageBytes: 512,
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
	assert.equal(runtime.maxHistoryImageBytes, 512);
	assert.equal(runtime.subagents[0].runtime.maxHistoryImageBytes, 128);
	delete child.runtime.maxHistoryImageBytes;
	assert.equal(hydrateHostRuntime(parent, registry).subagents[0].runtime.maxHistoryImageBytes, undefined);
});
