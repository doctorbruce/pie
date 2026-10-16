import assert from "node:assert/strict";
import type { SessionEvent, SessionSnapshot } from "@pie/runtime/protocol";
import { materializeSessionEvent } from "@pie/runtime/session-events";

export function createSessionEventReader() {
	let current: SessionSnapshot | undefined;
	return (packet: SessionEvent) => {
		const result = materializeSessionEvent(current, packet);
		assert(result, "session stream requires a fresh snapshot");
		current = result.snapshot;
		return result;
	};
}
