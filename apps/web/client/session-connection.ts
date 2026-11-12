import type { SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { applySessionEvent } from "@pie/runtime/session-events";
import { request } from "./request.ts";

export type SessionStreamHandlers = {
	onMessage: (data: string) => void;
	onError: (terminal?: boolean) => void;
};

export type SessionConnectionOptions = {
	createEventSource?: (url: string, handlers: SessionStreamHandlers) => { close: () => void };
	loadSnapshot?: (sessionId: string) => Promise<SessionSnapshot>;
	schedule?: (callback: () => void, delayMs: number) => () => void;
};

export type SessionConnectionCallbacks = {
	/** Return the currently selected session; late results for another selection are ignored. */
	getSnapshot: () => SessionSnapshot | undefined;
	onSnapshot: (snapshot: SessionSnapshot) => void;
	onEvent?: (packet: SessionEvent, snapshot: SessionSnapshot) => void;
	onConnection: (connected: boolean) => void;
	onError: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSnapshot(value: unknown, sessionId: string): value is SessionSnapshot {
	return (
		isRecord(value) &&
		value.id === sessionId &&
		typeof value.instanceId === "string" &&
		Number.isSafeInteger(value.revision) &&
		Number(value.revision) >= 0 &&
		Array.isArray(value.messages) &&
		Array.isArray(value.interactions) &&
		isRecord(value.execution)
	);
}

function parsePacket(data: string): SessionEvent {
	const value: unknown = JSON.parse(data);
	if (
		!isRecord(value) ||
		typeof value.type !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.instanceId !== "string" ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		(value.snapshot !== undefined &&
			(!validSnapshot(value.snapshot, value.sessionId) ||
				value.snapshot.instanceId !== value.instanceId ||
				value.snapshot.revision !== value.revision))
	)
		throw new Error("Core 返回了无效的会话事件，正在重新同步");
	return value as SessionEvent;
}

/** Own one selected session's stream. A successful HTTP resync always starts a fresh SSE baseline. */
export function connectSession(
	sessionId: string,
	callbacks: SessionConnectionCallbacks,
	options: SessionConnectionOptions = {},
): () => void {
	const createEventSource =
		options.createEventSource ??
		((url: string, handlers: SessionStreamHandlers) => {
			const source = new EventSource(url);
			source.onmessage = (event) => handlers.onMessage(event.data);
			source.onerror = () => handlers.onError(source.readyState === EventSource.CLOSED);
			return source;
		});
	const loadSnapshot =
		options.loadSnapshot ??
		((id: string) => request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}?limit=50`));
	const schedule =
		options.schedule ??
		((callback: () => void, delayMs: number) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		});
	let disposed = false;
	let generation = 0;
	let source: { close: () => void } | undefined;
	let cancelRetry: (() => void) | undefined;
	let syncing = false;
	let baselineReceived = false;
	let connected: boolean | undefined;
	let retryAttempt = 0;

	function isCurrent() {
		return !disposed && callbacks.getSnapshot()?.id === sessionId;
	}

	function connection(next: boolean) {
		if (!isCurrent() || connected === next) return;
		connected = next;
		callbacks.onConnection(next);
	}

	function closeSource() {
		generation += 1;
		baselineReceived = false;
		source?.close();
		source = undefined;
	}

	function retry(action: () => void) {
		cancelRetry?.();
		const delay = Math.min(1000 * 2 ** retryAttempt++, 15000);
		cancelRetry = schedule(() => {
			cancelRetry = undefined;
			if (isCurrent()) action();
		}, delay);
	}

	async function synchronize() {
		if (!isCurrent() || syncing) return;
		syncing = true;
		const previousInstance = callbacks.getSnapshot()?.instanceId;
		connection(false);
		closeSource();
		try {
			const next = await loadSnapshot(sessionId);
			if (!isCurrent()) return;
			if (!validSnapshot(next, sessionId)) throw new Error("Core 返回了无效的会话快照");
			const current = callbacks.getSnapshot();
			if (
				current &&
				(current.instanceId === previousInstance || next.instanceId === current.instanceId) &&
				(current.instanceId !== next.instanceId || next.revision >= current.revision)
			)
				callbacks.onSnapshot(next);
			syncing = false;
			open();
		} catch (reason) {
			if (!isCurrent()) return;
			syncing = false;
			callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
			retry(() => void synchronize());
		}
	}

	function open() {
		if (!isCurrent()) return;
		cancelRetry?.();
		cancelRetry = undefined;
		closeSource();
		connection(false);
		const streamGeneration = generation;
		try {
			source = createEventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
				onMessage(data) {
					if (!isCurrent() || streamGeneration !== generation) return;
					try {
						const packet = parsePacket(data);
						if (packet.sessionId !== sessionId) return;
						const current = callbacks.getSnapshot();
						if (!current) return;
						if (
							packet.instanceId !== current.instanceId ||
							packet.event?.type === "history.reset" ||
							(!baselineReceived && !packet.snapshot)
						) {
							void synchronize();
							return;
						}
						if (packet.revision < current.revision || (!packet.snapshot && packet.revision === current.revision))
							return;
						// Keep already loaded older pages when a reconnect baseline has the same revision.
						const next =
							packet.snapshot && packet.revision === current.revision
								? current
								: applySessionEvent(current, packet);
						if (!next || !validSnapshot(next, sessionId)) {
							void synchronize();
							return;
						}
						if (packet.snapshot) baselineReceived = true;
						callbacks.onSnapshot(next);
						callbacks.onEvent?.(packet, next);
						retryAttempt = 0;
						connection(true);
					} catch (reason) {
						callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
						void synchronize();
					}
				},
				onError(terminal) {
					if (!isCurrent() || streamGeneration !== generation) return;
					baselineReceived = false;
					connection(false);
					if (terminal) {
						closeSource();
						retry(() => void synchronize());
					}
					// Nonterminal errors reconnect automatically; each connection receives a fresh snapshot.
				},
			});
		} catch (reason) {
			callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
			retry(open);
		}
	}

	open();
	return () => {
		connection(false);
		disposed = true;
		cancelRetry?.();
		cancelRetry = undefined;
		closeSource();
	};
}
