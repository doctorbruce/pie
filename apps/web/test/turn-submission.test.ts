import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@pie/runtime/protocol";
import { RequestError } from "../client/request.ts";
import { createTurnSender } from "../client/turn-submission.ts";

const session: SessionSnapshot = {
	instanceId: "instance-1",
	id: "session-1",
	kind: "root",
	assistantId: "assistant-1",
	runtimeSource: "local",
	title: "测试会话",
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
const draft = { text: "消息", images: [] };

test("lost POST response reconciles an accepted turn without sending the draft again", async () => {
	const calls: string[] = [];
	let canonicalTurnId: string | undefined;
	const sender = createTurnSender(async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
		calls.push(`${method ?? "GET"} ${path}`);
		if (method === "POST") {
			canonicalTurnId = (body as { canonicalTurnId: string }).canonicalTurnId;
			throw new TypeError("network response lost");
		}
		return { ...session, turn: { id: "turn-1", status: "running", canonicalTurnId } } as T;
	});
	const accepted = await sender.send(session, draft);
	assert.equal(accepted?.turn?.canonicalTurnId, canonicalTurnId);
	assert.deepEqual(calls, ["POST /sessions/session-1/turns", "GET /sessions/session-1"]);
});

test("unconfirmed retries retain canonical identity and initial endpoint, then clear identity on success", async () => {
	const posts: { path: string; canonicalTurnId: string }[] = [];
	let loseResponse = true;
	const sender = createTurnSender(async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
		if (method === "POST") {
			posts.push({ path, canonicalTurnId: (body as { canonicalTurnId: string }).canonicalTurnId });
			if (loseResponse) throw new TypeError("offline");
			return { accepted: true } as T;
		}
		return session as T;
	});
	await assert.rejects(sender.send(session, draft), /offline/);
	loseResponse = false;
	await sender.send({ ...session, turn: { id: "unrelated", status: "running" } }, draft);
	assert.equal(posts[0].canonicalTurnId, posts[1].canonicalTurnId);
	assert.equal(posts[1].path, "/sessions/session-1/turns");
	await sender.send(session, draft);
	assert.notEqual(posts[1].canonicalTurnId, posts[2].canonicalTurnId);
});

test("a queued steer receipt is recovered with its target turn ID", async () => {
	let canonicalTurnId = "";
	const running: SessionSnapshot = { ...session, turn: { id: "turn-running", status: "running" } };
	const sender = createTurnSender(async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
		if (method === "POST") {
			assert.equal(path, "/sessions/session-1/steer");
			const payload = body as { turnId: string; canonicalTurnId: string; text: string };
			assert.equal(payload.turnId, "turn-running");
			assert.equal(payload.text, draft.text);
			canonicalTurnId = payload.canonicalTurnId;
			throw new TypeError("response lost");
		}
		return {
			...running,
			turn: {
				...running.turn,
				steerAdmissions: [{ canonicalTurnId, status: "queued", applied: false, acceptedAtMs: 1 }],
			},
		} as T;
	});
	assert.equal((await sender.send(running, draft))?.turn?.steerAdmissions?.[0].canonicalTurnId, canonicalTurnId);
});

test("known HTTP rejections retain the draft failure and let a later retry choose its current endpoint", async () => {
	const rejection = new RequestError("turn is terminal", 409, "turn_terminal");
	const paths: string[] = [];
	const sender = createTurnSender(async <T>(path: string): Promise<T> => {
		paths.push(path);
		if (paths.length === 1) throw rejection;
		return { accepted: true } as T;
	});
	await assert.rejects(
		sender.send({ ...session, turn: { id: "turn-ended", status: "running" } }, draft),
		(error) => error === rejection,
	);
	assert.deepEqual(paths, ["/sessions/session-1/steer"]);
	await sender.send(session, draft);
	assert.deepEqual(paths, ["/sessions/session-1/steer", "/sessions/session-1/turns"]);
});

test("retry reconciles first when the original POST becomes visible after the first failed reconciliation", async () => {
	let canonicalTurnId = "";
	let posts = 0;
	let visible = false;
	const sender = createTurnSender(async <T>(_path: string, method?: string, body?: unknown): Promise<T> => {
		if (method === "POST") {
			posts++;
			canonicalTurnId = (body as { canonicalTurnId: string }).canonicalTurnId;
			throw new TypeError("response lost");
		}
		return (
			visible
				? { ...session, turn: { id: "turn-1", status: "completed", rootCanonicalTurnId: canonicalTurnId } }
				: session
		) as T;
	});
	await assert.rejects(sender.send(session, draft), /response lost/);
	visible = true;
	assert.equal((await sender.send(session, draft))?.turn?.rootCanonicalTurnId, canonicalTurnId);
	assert.equal(posts, 1);
});
