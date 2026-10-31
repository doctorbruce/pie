import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelRequestRecorder } from "../../local/src/model-requests.ts";
import { createLocalHost } from "../../local/src/runtime.ts";
import { openStore } from "../../local/src/store.ts";

const model: Model<Api> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pie-request-retention-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	return {
		directory,
		env: { PI_DATA_DIR: directory },
		sessionDirectory: (id: string) =>
			join(directory, "model-requests", createHash("sha256").update(id).digest("hex")),
		async files() {
			const root = join(directory, "model-requests");
			const sessions = await readdir(root).catch(() => []);
			const paths = await Promise.all(
				sessions.map(async (session) =>
					(await readdir(join(root, session)))
						.filter((name) => name.endsWith(".json"))
						.map((name) => join(root, session, name)),
				),
			);
			return paths.flat();
		},
	};
}

test("disabled recording preserves payload hooks without creating new files", async (context) => {
	const data = await fixture(context);
	const recorder = createModelRequestRecorder({ ...data.env, PI_MODEL_REQUEST_RECORDING: "0" });
	const replacement = { messages: ["replacement"] };
	assert.equal(
		await recorder("session", "turn", async () => replacement)({ messages: ["original"] }, model),
		replacement,
	);
	assert.deepEqual(await data.files(), []);
});

test("recording configuration rejects invalid limits before serving model calls", () => {
	for (const value of ["-1", "0", "1.5", "NaN", "", "9007199254740992"]) {
		for (const key of [
			"PI_MODEL_REQUEST_MAX_BYTES",
			"PI_MODEL_REQUEST_MAX_FILES",
			"PI_MODEL_REQUEST_MAX_AGE_MS",
			"PI_MODEL_REQUEST_MAX_RECORD_BYTES",
		]) {
			assert.throws(() => createModelRequestRecorder({ [key]: value }), new RegExp(key));
		}
	}
	assert.throws(
		() => createModelRequestRecorder({ PI_MODEL_REQUEST_RECORDING: "false" }),
		/PI_MODEL_REQUEST_RECORDING/,
	);
});

test("concurrent sessions share byte and file budgets and retain complete records", async (context) => {
	const data = await fixture(context);
	const recorder = createModelRequestRecorder({
		...data.env,
		PI_MODEL_REQUEST_MAX_BYTES: "1600",
		PI_MODEL_REQUEST_MAX_FILES: "3",
	});
	await Promise.all(
		Array.from({ length: 24 }, (_, index) =>
			recorder(`session-${index % 8}`, "turn")({ text: "x".repeat(180), index }, model),
		),
	);
	const files = await data.files();
	assert(files.length > 0 && files.length <= 3);
	const bodies = await Promise.all(files.map((file) => readFile(file)));
	assert(bodies.reduce((sum, body) => sum + body.length, 0) <= 1600);
	for (const body of bodies) assert.equal(JSON.parse(body.toString()).payload.text, "x".repeat(180));
});

test("oversized and unserializable payloads never evict good records or block payload replacements", async (context) => {
	const data = await fixture(context);
	const recorder = createModelRequestRecorder({
		...data.env,
		PI_MODEL_REQUEST_MAX_RECORD_BYTES: "800",
		PI_MODEL_REQUEST_MAX_FILES: "1",
	});
	await recorder("session", "turn")({ text: "keep" }, model);
	const before = await data.files();
	const replacement = { text: "x".repeat(1000) };
	assert.equal(await recorder("session", "turn", async () => replacement)({}, model), replacement);
	context.mock.method(console, "warn", () => {});
	assert.equal(await recorder("session", "turn")({ cannotSerialize: 1n }, model), undefined);
	assert.deepEqual(await data.files(), before);
	assert.equal(JSON.parse(await readFile(before[0], "utf8")).payload.text, "keep");
});

test("maintenance expires records on startup and removes stale temporary files even when recording is disabled", async (context) => {
	const data = await fixture(context);
	let now = 1000;
	context.mock.method(Date, "now", () => now);
	const first = createModelRequestRecorder(data.env);
	await first("session", "turn")({ text: "old" }, model);
	const [file] = await data.files();
	await writeFile(`${file}.tmp`, "incomplete");
	now = 3000;
	const restarted = createModelRequestRecorder({
		...data.env,
		PI_MODEL_REQUEST_RECORDING: "0",
		PI_MODEL_REQUEST_MAX_AGE_MS: "1000",
	});
	await restarted.ready();
	assert.deepEqual(await data.files(), []);
	assert.deepEqual(await readdir(data.sessionDirectory("session")).catch(() => []), []);
});

test("write maintenance evicts the oldest record across sessions and enforces expiry", async (context) => {
	const data = await fixture(context);
	let now = 1000;
	context.mock.method(Date, "now", () => now);
	const recorder = createModelRequestRecorder({
		...data.env,
		PI_MODEL_REQUEST_MAX_FILES: "1",
		PI_MODEL_REQUEST_MAX_AGE_MS: "1000",
	});
	await recorder("old", "turn")({ text: "old" }, model);
	now = 1500;
	await recorder("new", "turn")({ text: "new" }, model);
	assert.deepEqual(await readdir(data.sessionDirectory("old")).catch(() => []), []);
	assert.equal((await data.files()).length, 1);
	now = 3000;
	await recorder.ready();
	assert.deepEqual(await data.files(), []);
});

test("deletion cannot be undone by a record still awaiting the previous payload hook", async (context) => {
	const data = await fixture(context);
	const recorder = createModelRequestRecorder(data.env);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = recorder("session", "turn", async () => {
		await held;
	})({ text: "late" }, model);
	await recorder.deleteSession("session");
	release();
	await pending;
	assert.deepEqual(await data.files(), []);
});

test("local deletion removes parent and cold child request records while retaining siblings", async (context) => {
	const data = await fixture(context);
	const store = openStore(data.env);
	for (const id of ["parent", "child", "sibling"]) {
		store.saveSession({
			id,
			kind: id === "child" ? "subagent" : "root",
			parentSessionId: id === "child" ? "parent" : undefined,
			assistantId: store.assistants[0].id,
			runtimeSource: "local",
			title: id,
			mode: "faux",
			model: "faux",
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			messages: [],
		});
	}
	store.close();
	const recorder = createModelRequestRecorder(data.env);
	for (const id of ["parent", "child", "sibling"]) await recorder(id, "turn")({ text: id }, model);
	const host = createLocalHost({ ...data.env, PI_MODEL_REQUEST_RECORDING: "0", PI_TOOL_STREAM_TRACE: "0" });
	const runtime = await host.ready;
	context.after(() => runtime.close());
	assert.deepEqual(await runtime.deleteSession("parent"), { deleted: true });
	assert.deepEqual(await readdir(data.sessionDirectory("parent")).catch(() => []), []);
	assert.deepEqual(await readdir(data.sessionDirectory("child")).catch(() => []), []);
	assert.equal((await readdir(data.sessionDirectory("sibling"))).length, 1);
});

for (const target of ["root", "session"]) {
	test(`recording does not follow a symlink at its ${target} directory`, async (context) => {
		const data = await fixture(context);
		const outside = join(data.directory, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep.json"), "keep");
		if (target === "session") await mkdir(join(data.directory, "model-requests"));
		await symlink(
			outside,
			target === "root" ? join(data.directory, "model-requests") : data.sessionDirectory("session"),
			process.platform === "win32" ? "junction" : "dir",
		);
		context.mock.method(console, "warn", () => {});
		const recorder = createModelRequestRecorder(data.env);
		await recorder.ready();
		await recorder("session", "turn")({ text: "private" }, model);
		assert.deepEqual(await readdir(outside), ["keep.json"]);
		assert.equal(await readFile(join(outside, "keep.json"), "utf8"), "keep");
	});
}

test("closing recording invalidates delayed hooks before a new host initializes the same directory", async (context) => {
	const data = await fixture(context);
	const recorder = createModelRequestRecorder(data.env);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const replacement = { text: "late" };
	const pending = recorder("session", "turn", async () => {
		await held;
		return replacement;
	})({}, model);
	await recorder.close();
	const next = createModelRequestRecorder(data.env);
	await next.ready();
	release();
	assert.equal(await pending, replacement);
	await recorder("other", "turn")({ text: "after close" }, model);
	assert.deepEqual(await data.files(), []);
	await next("new", "turn")({ text: "current host" }, model);
	assert.equal((await data.files()).length, 1);
});

test("startup applies lowered host budgets to records written by an earlier instance", async (context) => {
	const data = await fixture(context);
	let now = 1000;
	context.mock.method(Date, "now", () => now);
	const first = createModelRequestRecorder(data.env);
	for (let index = 0; index < 5; index++) {
		now = 1000 + index;
		await first(`session-${index}`, "turn")({ text: "x".repeat(80), index }, model);
	}
	await first.close();
	const restarted = createModelRequestRecorder({
		...data.env,
		PI_MODEL_REQUEST_MAX_FILES: "2",
		PI_MODEL_REQUEST_MAX_BYTES: "1200",
	});
	await restarted.ready();
	const files = await data.files();
	assert.equal(files.length, 2);
	const contents = await Promise.all(files.map((file) => readFile(file)));
	assert(contents.reduce((sum, body) => sum + body.length, 0) <= 1200);
	assert.deepEqual(contents.map((body) => JSON.parse(body.toString()).payload.index).sort(), [3, 4]);
});

test("recording resumes after a filesystem failure without rejecting model payloads", async (context) => {
	const data = await fixture(context);
	const root = join(data.directory, "model-requests");
	await writeFile(root, "blocked");
	context.mock.method(console, "warn", () => {});
	const recorder = createModelRequestRecorder(data.env);
	assert.equal(await recorder("session", "turn")({ text: "first" }, model), undefined);
	await rm(root);
	assert.equal(await recorder("session", "turn")({ text: "second" }, model), undefined);
	const [file] = await data.files();
	assert.equal(JSON.parse(await readFile(file, "utf8")).payload.text, "second");
});
