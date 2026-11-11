import assert from "node:assert/strict";
import test from "node:test";
import { hydrateHostRuntime, parseHostRuntimeDefinition } from "../src/config.ts";

const target = { assistantId: "reviewer", name: "Reviewer", description: "Review independently" };

function definition(workerTargets?: unknown) {
	return {
		assistantId: "coordinator",
		assistantRevision: "1",
		runtime: {
			systemPrompt: "",
			toolIds: [],
			skills: [],
			subagents: [],
			...(workerTargets !== undefined ? { workerTargets } : {}),
		},
	};
}

test("Worker targets preserve omission and explicit empty directories without adding task bindings", () => {
	const omitted = parseHostRuntimeDefinition(definition(), []);
	assert.equal(omitted.runtime.workerTargets, undefined);
	assert.equal(Object.hasOwn(omitted.runtime, "workerTargets"), false);
	assert.deepEqual(parseHostRuntimeDefinition(definition([]), []).runtime.workerTargets, []);
	const parsed = parseHostRuntimeDefinition(
		definition([{ assistantId: " reviewer ", name: " Reviewer ", description: " Review independently " }]),
		[],
	);
	assert.deepEqual(parsed.runtime.workerTargets, [target]);
	const runtime = hydrateHostRuntime(parsed, new Map([[parsed.assistantId, parsed]]));
	assert.deepEqual(runtime.workerTargets, [target]);
	assert.deepEqual(runtime.subagents, []);
	parsed.runtime.workerTargets![0].name = "Changed";
	assert.equal(runtime.workerTargets?.[0].name, target.name);
});

test("Worker target validation uses bounded fields and unique normalized assistant identities", () => {
	for (const workerTargets of [
		null,
		{},
		[target, { ...target, assistantId: " reviewer " }],
		...["", " ", "a\0b", "a".repeat(257)].map((assistantId) => [{ ...target, assistantId }]),
		...["", " ", "a\0b", "a".repeat(201)].map((name) => [{ ...target, name }]),
		...["", " ", "a\0b", "a".repeat(4097)].map((description) => [{ ...target, description }]),
	]) {
		assert.throws(() => parseHostRuntimeDefinition(definition(workerTargets), []), /workerTargets|Worker/);
	}
	const maximum = Array.from({ length: 33 }, (_, index) => ({
		assistantId: `${index}`.padEnd(256, "a"),
		name: "n".repeat(200),
		description: "d".repeat(4096),
	}));
	assert.deepEqual(parseHostRuntimeDefinition(definition(maximum), []).runtime.workerTargets, maximum);
});

test("Worker wait mode defaults by omission and preserves a validated host preference", () => {
	assert.equal(parseHostRuntimeDefinition(definition(), []).runtime.workerWaitMode, undefined);
	for (const mode of ["sync", "async"] as const) {
		const input = definition();
		const parsed = parseHostRuntimeDefinition({ ...input, runtime: { ...input.runtime, workerWaitMode: mode } }, []);
		assert.equal(parsed.runtime.workerWaitMode, mode);
		assert.equal(hydrateHostRuntime(parsed, new Map([[parsed.assistantId, parsed]])).workerWaitMode, mode);
	}
	for (const mode of [null, 0, "", "SYNC", {}]) {
		const input = definition();
		assert.throws(
			() => parseHostRuntimeDefinition({ ...input, runtime: { ...input.runtime, workerWaitMode: mode } }, []),
			/workerWaitMode/,
		);
	}
});
