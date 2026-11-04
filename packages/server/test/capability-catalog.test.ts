import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { nextCapabilityCatalog } from "../../runtime/src/capability-catalog.ts";

test("catalog publication preserves history and replaces changed or empty lists", () => {
	const messages: AgentMessage[] = [{ role: "user", content: "Help", timestamp: 1 }];
	const first = nextCapabilityCatalog(messages, "- skill: Summary\n- plugin: Installable", "zh");
	assert(first);
	assert.equal(first.role, "user");
	messages.push(first);
	const prefix = structuredClone(messages);
	assert.equal(nextCapabilityCatalog(messages, "- skill: Summary\n- plugin: Installable", "zh"), undefined);
	const changed = nextCapabilityCatalog(messages, "- skill: New summary", "zh");
	assert(changed);
	assert.match(contentText(changed.content), /替代历史[\s\S]*New summary/);
	assert.doesNotMatch(contentText(changed.content), /Installable/);
	assert.deepEqual(messages, prefix);
	messages.push(changed);
	const empty = nextCapabilityCatalog(messages, "No specialized skills are currently available.");
	assert(empty);
	assert.match(contentText(empty.content), /replaces all earlier[\s\S]*No specialized skills/);
});

test("restored history suppresses duplicates and compacted history republishes the catalog", () => {
	const catalog = "- skill: Summary";
	const first = nextCapabilityCatalog([], catalog)!;
	const restored: AgentMessage[] = JSON.parse(JSON.stringify([first]));
	assert.equal(nextCapabilityCatalog(restored, catalog), undefined);
	assert(nextCapabilityCatalog([{ role: "user", content: "Compacted summary", timestamp: 2 }], catalog));
});
