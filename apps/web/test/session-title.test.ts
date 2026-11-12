import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@pie/runtime/protocol";
import { RequestError } from "../client/request.ts";
import { createSessionTitles } from "../client/session-title.ts";

const session: SessionSnapshot = {
	instanceId: "instance-1",
	id: "session-1",
	kind: "root",
	assistantId: "assistant-1",
	runtimeSource: "local",
	title: "新会话",
	createdAt: 0,
	updatedAt: 0,
	mode: "faux",
	model: "faux",
	revision: 0,
	messages: [],
	interactions: [],
	execution: {
		modelStreaming: false,
		activeTools: [],
		waitingForInteraction: false,
		cancellationRequested: false,
		actions: {
			submit: { available: true },
			steer: { available: false },
			cancel: { available: false },
			resume: { available: false },
		},
	},
};
const completed: SessionSnapshot = { ...session, turn: { id: "turn-1", status: "completed" } };

test("a POST receipt before the first SSE turn cannot rename the session until the turn settles", async () => {
	const storage = new Map<string, string>();
	const calls: unknown[] = [];
	const titles = createSessionTitles(
		async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
			calls.push({ path, method, body });
			return { ...completed, title: "首条 图文消息" } as T;
		},
		(key) => storage.get(key) ?? "",
		(key, value) => storage.set(key, value),
	);
	titles.remember(session, "  首条\n图文消息  ");
	assert.equal(await titles.apply(session), undefined);
	assert.equal(await titles.apply({ ...session, turn: { id: "turn-1", status: "running" } }), undefined);
	assert.equal(calls.length, 0);
	assert.equal(storage.get("pie.title.session-1"), "首条 图文消息");
	assert.equal((await titles.apply(completed))?.title, "首条 图文消息");
	assert.deepEqual(calls, [{ path: "/sessions/session-1", method: "PATCH", body: { title: "首条 图文消息" } }]);
	assert.equal(storage.get("pie.title.session-1"), "");
});

test("a rejected rename survives a second message and a page reload without losing the first title", async () => {
	const storage = new Map<string, string>();
	const read = (key: string) => storage.get(key) ?? "";
	const write = (key: string, value: string) => storage.set(key, value);
	const titles = createSessionTitles(
		async () => {
			throw new RequestError("请在执行结束后重命名", 409);
		},
		read,
		write,
	);
	titles.remember(session, "首条消息");
	await assert.rejects(titles.apply(completed), /执行结束/);
	titles.remember(completed, "第二条消息");
	assert.equal(storage.get("pie.title.session-1"), "首条消息");
	const reloaded = createSessionTitles(
		async <T>(_path: string, _method?: string, body?: unknown): Promise<T> => {
			assert.deepEqual(body, { title: "首条消息" });
			return { ...completed, title: "首条消息" } as T;
		},
		read,
		write,
	);
	assert.equal((await reloaded.apply(completed))?.title, "首条消息");
	assert.equal(storage.get("pie.title.session-1"), "");
});

test("in-flight renames are coalesced and switching sessions keeps their titles independent", async () => {
	const storage = new Map<string, string>();
	const calls: string[] = [];
	let finishFirst: ((snapshot: SessionSnapshot) => void) | undefined;
	const titles = createSessionTitles(
		async <T>(path: string, _method?: string, body?: unknown): Promise<T> => {
			calls.push(path);
			if (path === "/sessions/session-1") {
				return new Promise<SessionSnapshot>((resolve) => {
					finishFirst = resolve;
				}) as Promise<T>;
			}
			assert.deepEqual(body, { title: "另一个会话" });
			return { ...completed, id: "session-2", title: "另一个会话" } as T;
		},
		(key) => storage.get(key) ?? "",
		(key, value) => storage.set(key, value),
	);
	titles.remember(session, "第一个会话");
	const first = titles.apply(completed);
	assert.equal(await titles.apply({ ...completed, revision: 2 }), undefined);
	assert.equal(storage.get("pie.title.session-1"), "第一个会话");
	const other = { ...completed, id: "session-2" };
	titles.remember(other, "另一个会话");
	assert.equal((await titles.apply(other))?.id, other.id);
	assert(finishFirst);
	finishFirst({ ...completed, title: "第一个会话" });
	assert.equal((await first)?.id, session.id);
	assert.deepEqual(calls, ["/sessions/session-1", "/sessions/session-2"]);
	assert.equal(storage.get("pie.title.session-1"), "");
	assert.equal(storage.get("pie.title.session-2"), "");
});

test("an explicit title supersedes a pending automatic title without issuing another PATCH", async () => {
	const storage = new Map<string, string>();
	const titles = createSessionTitles(
		async () => {
			assert.fail("an explicit title must be preserved");
		},
		(key) => storage.get(key) ?? "",
		(key, value) => storage.set(key, value),
	);
	titles.remember(session, "自动标题");
	const renamed = { ...completed, title: "手动标题" };
	assert.equal(await titles.apply(renamed), undefined);
	titles.remember(renamed, "后续消息");
	assert.equal(storage.get("pie.title.session-1"), "");
});

test("an explicit rename waits for an in-flight automatic rename so the explicit title wins", async () => {
	for (const fail of [false, true]) {
		const storage = new Map<string, string>();
		let finishAutomatic: ((value: SessionSnapshot) => void) | undefined;
		let failAutomatic: ((error: Error) => void) | undefined;
		const titles = createSessionTitles(
			async <T>(): Promise<T> =>
				new Promise<SessionSnapshot>((resolve, reject) => {
					finishAutomatic = resolve;
					failAutomatic = reject;
				}) as Promise<T>,
			(key) => storage.get(key) ?? "",
			(key, value) => storage.set(key, value),
		);
		titles.remember(session, "自动标题");
		const automatic = titles.apply(completed).catch(() => undefined);
		let manualStarted = false;
		const manual = titles.clear(session.id).then(() => {
			manualStarted = true;
		});
		await Promise.resolve();
		assert.equal(manualStarted, false);
		assert.equal(storage.get("pie.title.session-1"), "");
		assert(finishAutomatic && failAutomatic);
		if (fail) failAutomatic(new RequestError("请在执行结束后重命名", 409));
		else finishAutomatic({ ...completed, title: "自动标题" });
		await automatic;
		await manual;
		assert.equal(manualStarted, true);
		assert.equal(storage.get("pie.title.session-1"), "");
		assert.equal(await titles.apply({ ...completed, title: "手动标题" }), undefined);
	}
});
