import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig, SessionSnapshot } from "../packages/server/src/protocol.ts";

const base = process.env.PI_SERVER_URL ?? "http://127.0.0.1:4318";
const directory = fileURLToPath(new URL("./plugins/hello-skill/skills/hello/", import.meta.url));
const runtime: RuntimeConfig = {
	systemPrompt: "Use the requested skill binding. This is a local attribution test.",
	toolIds: [],
	subagents: [],
	skills: ["demo-a", "demo-b"].map((pluginId) => ({
		id: `${pluginId}/hello`,
		name: "hello",
		description: `Local hello skill via ${pluginId}`,
		directory,
		source: {
			pluginId,
			pluginName: pluginId,
			pluginVersion: "1",
		},
	})),
};
async function request(path: string, body?: unknown) {
	const response = await fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"Content-Type": "application/json",
			...(process.env.PI_SERVER_TOKEN ? { Authorization: `Bearer ${process.env.PI_SERVER_TOKEN}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert(response.ok, await response.clone().text());
	return response.json();
}
let session = (await request("/sessions", { title: "Skill 加载来源演示", mode: "faux", runtime })) as SessionSnapshot;
for (const text of ["加载技能 demo-a/hello", "加载技能 demo-b/hello"]) {
	await request(`/sessions/${session.id}/turns`, { text });
	const deadline = Date.now() + 30000;
	do {
		assert(Date.now() < deadline, "Turn did not settle within 30s");
		await setTimeout(100);
		session = (await request(`/sessions/${session.id}`)) as SessionSnapshot;
	} while (session.turn?.status === "running");
	assert.equal(session.turn?.status, "completed");
	assert.equal(session.activities?.at(-1)?.status, "succeeded");
}
assert.deepEqual(
	session.activities?.map((activity) => [activity.kind, activity.binding.source?.pluginId]),
	[
		["skill_load", "demo-a"],
		["skill_load", "demo-b"],
	],
);
console.log(JSON.stringify({ sessionId: session.id, title: session.title, activities: session.activities?.length }));
