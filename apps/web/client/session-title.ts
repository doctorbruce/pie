import type { SessionSnapshot } from "@pie/runtime/protocol";
import { request } from "./request.ts";
import { store, stored } from "./storage.ts";

export function createSessionTitles(transport = request, read = stored, write = store) {
	const applying = new Map<string, Promise<SessionSnapshot>>();
	return {
		remember(snapshot: SessionSnapshot, text: string) {
			const key = `pie.title.${snapshot.id}`;
			if (snapshot.title !== "新会话" || read(key)) return;
			const title = text.trim().replace(/\s+/g, " ").slice(0, 40);
			if (title) write(key, title);
		},
		async clear(sessionId: string) {
			write(`pie.title.${sessionId}`, "");
			// Let an earlier automatic rename finish before sending the explicit title.
			await applying.get(sessionId)?.catch(() => {});
		},
		async apply(snapshot: SessionSnapshot): Promise<SessionSnapshot | undefined> {
			const key = `pie.title.${snapshot.id}`;
			const title = read(key);
			if (!title) return;
			if (snapshot.title !== "新会话") {
				write(key, "");
				return;
			}
			// A successful POST receipt can arrive before SSE shows the accepted turn.
			if (!snapshot.turn || snapshot.turn.status === "running" || applying.has(snapshot.id)) return;
			const renaming = transport<SessionSnapshot>(`/sessions/${encodeURIComponent(snapshot.id)}`, "PATCH", {
				title,
			});
			applying.set(snapshot.id, renaming);
			try {
				const next = await renaming;
				if (read(key) === title) write(key, "");
				return next;
			} finally {
				// A rejected or lost response keeps the title available for the next snapshot.
				applying.delete(snapshot.id);
			}
		},
	};
}
