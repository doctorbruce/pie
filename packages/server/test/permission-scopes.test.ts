import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackgroundJobs } from "@pie/runtime/jobs";
import type { InteractionRequest } from "@pie/runtime/protocol";
import type { ToolRuntime } from "@pie/runtime/tools";
import { authorizeCommand, authorizePath } from "../../local/src/tools/runtime.ts";

test("native command grants follow command entry points and working directories", async (context) => {
	const directory = join(tmpdir(), "pie-permission-scopes");
	const jobs = new BackgroundJobs();
	context.after(() => jobs.close());
	const requests: Omit<InteractionRequest, "id">[] = [];
	const runtime: ToolRuntime = {
		sessionId: "scopes",
		directory,
		jobs,
		ask: async (request) => {
			requests.push(request);
		},
	};
	const grant = async (command: string, workdir = directory) => {
		requests.length = 0;
		await authorizeCommand(runtime, command, workdir);
		const request = requests.find((item) => item.metadata?.permission === "bash");
		assert(request?.remember);
		return request.remember;
	};
	assert.deepEqual(await grant("git status --short"), await grant("git status --branch"));
	assert.notDeepEqual(await grant("git status"), await grant("git reset --hard"));
	assert.notDeepEqual(await grant("git status"), await grant("git status", join(directory, "other")));
	assert.notDeepEqual(await grant("git status"), await grant("git status; git reset --hard"));
	assert.notDeepEqual(await grant("git status; echo a"), await grant("git status; echo b"));
	assert.deepEqual(await grant("python report.py first.docx"), await grant("python report.py second.docx"));
	assert.notDeepEqual(await grant("python report.py"), await grant("python cleanup.py"));
	assert.notDeepEqual(await grant('python -c "print(1)"'), await grant('python -c "print(2)"'));
	assert.notDeepEqual(await grant("bun run safe.ts"), await grant("bun run cleanup.ts"));
	assert.deepEqual(await grant("bun run safe.ts a"), await grant("bun run safe.ts b"));
	assert.notDeepEqual(await grant("pnpm dlx package-a"), await grant("pnpm dlx package-b"));
	assert.notDeepEqual(await grant("npm exec node report.js"), await grant("npm exec node cleanup.js"));
	assert.notDeepEqual(await grant('python "report.py"other a'), await grant("python report.py a"));
	assert.notDeepEqual(await grant("npm run build"), await grant("npm run build --workspace other"));
	assert.deepEqual(
		await grant(`& "${process.execPath}" report.js a`),
		await grant(`& "${process.execPath}" report.js b`),
	);
});

test("external grants retain the exact path, operation and command category", async (context) => {
	const directory = join(tmpdir(), "pie-permission-scopes");
	const outside = join(tmpdir(), "pie-private", "report.docx");
	const jobs = new BackgroundJobs();
	context.after(() => jobs.close());
	const requests: Omit<InteractionRequest, "id">[] = [];
	const runtime: ToolRuntime = {
		sessionId: "scopes",
		directory,
		jobs,
		ask: async (request) => {
			requests.push(request);
		},
	};
	await authorizePath(runtime, outside, "read");
	await authorizePath(runtime, outside, "read");
	await authorizePath(runtime, outside, "edit");
	assert(requests[0].remember);
	assert.deepEqual(requests[0].remember, requests[1].remember);
	assert.notDeepEqual(requests[0].remember, requests[2].remember);
	requests.length = 0;
	await authorizeCommand(runtime, `git status "${outside}"`, directory);
	const read = requests[0].remember;
	assert(read);
	requests.length = 0;
	await authorizeCommand(runtime, `git reset "${outside}"`, directory);
	assert.notDeepEqual(read, requests[0].remember);
});
