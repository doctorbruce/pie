import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { connectSession, type SessionStreamHandlers } from "../client/session-connection.ts";

const snapshot: SessionSnapshot = {
	instanceId: "server-1",
	id: "session-1",
	kind: "root",
	assistantId: "assistant-1",
	runtimeSource: "local",
	title: "测试会话",
	createdAt: 0,
	updatedAt: 0,
	mode: "faux",
	model: "faux",
	revision: 1,
	messages: [],
	interactions: [],
	execution: {
		modelStreaming: false,
		activeTools: [],
		waitingForInteraction: false,
		cancellationRequested: false,
		actions: {
			submit: { available: true },
			steer: { available: false, reason: "no_turn" },
			cancel: { available: false, reason: "no_turn" },
			resume: { available: false, reason: "no_turn" },
		},
	},
};

class FakeStream {
	closed = false;
	readonly url: string;
	readonly handlers: SessionStreamHandlers;
	constructor(url: string, handlers: SessionStreamHandlers) {
		this.url = url;
		this.handlers = handlers;
	}
	close() {
		this.closed = true;
	}
	message(packet: SessionEvent) {
		this.handlers.onMessage(JSON.stringify(packet));
	}
}

function packet(next: SessionSnapshot): SessionEvent {
	return {
		type: "snapshot",
		sessionId: next.id,
		instanceId: next.instanceId,
		revision: next.revision,
		snapshot: next,
	};
}

function harness(load: () => Promise<SessionSnapshot> = async () => snapshot) {
	let current = snapshot;
	const streams: FakeStream[] = [];
	const snapshots: SessionSnapshot[] = [];
	const events: SessionEvent[] = [];
	const connections: boolean[] = [];
	const errors: Error[] = [];
	const retries: { run: () => void; delay: number; cancelled: boolean }[] = [];
	let loads = 0;
	const dispose = connectSession(
		snapshot.id,
		{
			getSnapshot: () => current,
			onSnapshot: (next) => {
				snapshots.push(next);
				current = next;
			},
			onEvent: (event) => events.push(event),
			onConnection: (connected) => connections.push(connected),
			onError: (error) => errors.push(error),
		},
		{
			createEventSource: (url, handlers) => {
				const stream = new FakeStream(url, handlers);
				streams.push(stream);
				return stream;
			},
			loadSnapshot: async () => {
				loads += 1;
				return load();
			},
			schedule: (run, delay) => {
				const retry = { run, delay, cancelled: false };
				retries.push(retry);
				return () => {
					retry.cancelled = true;
				};
			},
		},
	);
	return {
		streams,
		snapshots,
		events,
		connections,
		errors,
		retries,
		dispose,
		get current() {
			return current;
		},
		set current(next: SessionSnapshot) {
			current = next;
		},
		get loads() {
			return loads;
		},
	};
}

test("valid SSE snapshots establish connection and automatic reconnect retains loaded history", () => {
	const state = harness();
	assert.deepEqual(state.connections, [false]);
	assert.equal(state.streams[0].url, "/api/sessions/session-1/events");
	state.current = { ...snapshot, messages: [{ role: "user", content: "older page", timestamp: 0 }] };
	state.streams[0].message(packet(snapshot));
	assert.equal(state.current.messages.length, 1);
	assert.deepEqual(state.connections, [false, true]);
	state.streams[0].handlers.onError();
	assert.equal(state.streams.length, 1);
	assert.equal(state.streams[0].closed, false);
	state.streams[0].message(packet({ ...snapshot, revision: 3 }));
	assert.equal(state.current.revision, 3);
	assert.deepEqual(state.connections, [false, true, false, true]);
	state.dispose();
	assert.equal(state.streams[0].closed, true);
});

test("a terminal SSE error reloads the session and opens a new stream after a delay", async () => {
	const reloaded = { ...snapshot, revision: 3 };
	const state = harness(async () => reloaded);
	state.streams[0].message(packet(snapshot));
	state.streams[0].handlers.onError(true);
	assert.equal(state.streams[0].closed, true);
	assert.equal(state.connections.at(-1), false);
	assert.equal(state.loads, 0);
	assert.equal(state.retries[0].delay, 1000);
	state.streams[0].handlers.onError(true);
	state.streams[0].message(packet({ ...snapshot, revision: 99 }));
	assert.equal(state.retries.length, 1);
	assert.equal(state.current.revision, 1);
	state.retries[0].run();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.loads, 1);
	assert.equal(state.streams.length, 2);
	assert.equal(state.current, reloaded);
	assert.equal(state.connections.at(-1), false);
	state.streams[1].message(packet(reloaded));
	state.streams[1].message({ ...packet(reloaded), type: "agent.event", snapshot: undefined, revision: 4 });
	assert.equal(state.connections.at(-1), true);
	assert.equal(state.current.revision, 4);
	state.dispose();
});

test("terminal stream recovery backs off failed HTTP loads and resets after a valid SSE baseline", async () => {
	let failures = 5;
	const state = harness(async () => {
		if (failures-- > 0) throw new Error("Session temporarily unavailable");
		return snapshot;
	});
	state.streams[0].handlers.onError(true);
	for (const [index, delay] of [1000, 2000, 4000, 8000, 15000, 15000].entries()) {
		assert.equal(state.retries[index].delay, delay);
		state.retries[index].run();
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(state.errors.length, 5);
	assert.match(state.errors[0].message, /Session temporarily unavailable/);
	assert.equal(state.loads, 6);
	assert.equal(state.streams.length, 2);
	state.streams[1].handlers.onError(true);
	assert.equal(state.retries.at(-1)?.delay, 15000);
	state.retries.at(-1)?.run();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.streams.length, 3);
	state.streams[2].message(packet(snapshot));
	assert.equal(state.connections.at(-1), true);
	state.streams[2].handlers.onError(true);
	assert.equal(state.retries.at(-1)?.delay, 1000);
	state.dispose();
	assert.equal(state.retries.at(-1)?.cancelled, true);
});

test("a revision gap reloads the session and explicitly reopens a stream that accepts subsequent deltas", async () => {
	const reloaded = { ...snapshot, revision: 5 };
	const state = harness(async () => reloaded);
	state.streams[0].message(packet(snapshot));
	state.streams[0].message({ ...packet(snapshot), type: "agent.event", snapshot: undefined, revision: 3 });
	assert.equal(state.streams[0].closed, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.loads, 1);
	assert.equal(state.streams.length, 2);
	assert.equal(state.current.revision, 5);
	assert.equal(state.connections.at(-1), false);
	state.streams[0].message(packet({ ...snapshot, revision: 99 }));
	assert.equal(state.current.revision, 5);
	state.streams[1].message(packet(reloaded));
	state.streams[1].message({ ...packet(reloaded), type: "agent.event", snapshot: undefined, revision: 6 });
	assert.equal(state.current.revision, 6);
	assert.equal(state.connections.at(-1), true);
	state.dispose();
});

test("malformed packets recover through a snapshot without throwing out of the event handler", async () => {
	for (const data of ["{", "null", "{}", JSON.stringify({ ...packet(snapshot), snapshot: {} })]) {
		const state = harness();
		assert.doesNotThrow(() => state.streams[0].handlers.onMessage(data));
		assert.equal(state.streams[0].closed, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.errors.length, 1);
		assert.equal(state.streams.length, 2);
		state.streams[1].message(packet(snapshot));
		assert.equal(state.connections.at(-1), true);
		state.dispose();
	}
});

test("history resets and changed Core instances resynchronize before receiving another baseline", async () => {
	for (const reset of [
		{ ...packet(snapshot), revision: 2, snapshot: undefined, event: { type: "history.reset" } },
		packet({ ...snapshot, instanceId: "server-2" }),
	]) {
		const next = { ...snapshot, instanceId: reset.instanceId, revision: 4 };
		const state = harness(async () => next);
		state.streams[0].message(packet(snapshot));
		state.streams[0].message(reset);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.loads, 1);
		assert.equal(state.current, next);
		state.streams[1].message(packet(next));
		assert.equal(state.connections.at(-1), true);
		state.dispose();
	}
});

test("stale and foreign packets cannot replace current state or produce UI events", () => {
	const state = harness();
	state.current = { ...snapshot, revision: 4 };
	state.streams[0].message(packet({ ...snapshot, revision: 3 }));
	state.streams[0].message(packet({ ...snapshot, id: "other-session", revision: 5 }));
	assert.equal(state.snapshots.length, 0);
	assert.equal(state.events.length, 0);
	state.streams[0].message(packet(state.current));
	state.streams[0].message({ ...packet(state.current), snapshot: undefined });
	assert.equal(state.events.length, 1);
	assert.equal(state.current.revision, 4);
	state.dispose();
});

test("dispose and switching away ignore late HTTP responses and event callbacks", async () => {
	for (const dispose of [true, false]) {
		let finish: ((value: SessionSnapshot) => void) | undefined;
		const state = harness(
			() =>
				new Promise<SessionSnapshot>((resolve) => {
					finish = resolve;
				}),
		);
		state.streams[0].handlers.onMessage("malformed");
		if (dispose) state.dispose();
		else state.current = { ...snapshot, id: "other-session" };
		const errorsBeforeLateResult = state.errors.length;
		assert(finish);
		finish({ ...snapshot, revision: 9 });
		await new Promise((resolve) => setImmediate(resolve));
		state.streams[0].message(packet({ ...snapshot, revision: 10 }));
		state.streams[0].handlers.onError();
		assert.equal(state.snapshots.length, 0);
		assert.equal(state.streams.length, 1);
		assert.equal(state.errors.length, errorsBeforeLateResult);
		state.dispose();
	}
});

test("failed resynchronization reports its error and retries until a new baseline can connect", async () => {
	let attempt = 0;
	const state = harness(async () => {
		if (++attempt === 1) throw new Error("Core offline");
		return snapshot;
	});
	state.streams[0].handlers.onMessage("malformed");
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(state.errors.at(-1)?.message ?? "", /Core offline/);
	assert.equal(state.retries.length, 1);
	assert.equal(state.retries[0].delay, 1000);
	state.retries[0].run();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.streams.length, 2);
	state.streams[1].message(packet(snapshot));
	assert.equal(state.connections.at(-1), true);
	state.dispose();
});

test("dispose cancels a scheduled retry", async () => {
	const state = harness(async () => {
		throw new Error("Core offline");
	});
	state.streams[0].handlers.onMessage("malformed");
	await new Promise((resolve) => setImmediate(resolve));
	state.dispose();
	assert.equal(state.retries[0].cancelled, true);
	state.retries[0].run();
	assert.equal(state.loads, 1);
});
