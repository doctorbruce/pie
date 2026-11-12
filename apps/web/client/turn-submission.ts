import type { ImagePart, SessionSnapshot, TurnReceipt } from "@pie/runtime/protocol";
import { RequestError, request } from "./request.ts";

type TurnDraft = { text: string; images: readonly ImagePart[] };
type PendingTurn = { canonicalTurnId: string; action: "turns" | "steer"; turnId?: string };

export function createTurnSender(transport: typeof request = request) {
	const pending = new Map<string, PendingTurn>();
	return {
		async send(snapshot: SessionSnapshot, draft: TurnDraft): Promise<SessionSnapshot | undefined> {
			const images = draft.images.map((image) => ({
				type: "image" as const,
				mimeType: image.mimeType,
				data: image.data,
			}));
			const key = JSON.stringify([snapshot.id, draft.text, images]);
			const previous = pending.get(key);
			const attempt: PendingTurn = previous ?? {
				canonicalTurnId: crypto.randomUUID(),
				action: snapshot.turn?.status === "running" ? "steer" : "turns",
				turnId: snapshot.turn?.status === "running" ? snapshot.turn.id : undefined,
			};
			pending.set(key, attempt);
			const path = `/sessions/${encodeURIComponent(snapshot.id)}`;
			async function reconcile() {
				try {
					const current = await transport<SessionSnapshot>(path);
					const turn = current.turn;
					if (
						turn?.canonicalTurnId === attempt.canonicalTurnId ||
						turn?.rootCanonicalTurnId === attempt.canonicalTurnId ||
						turn?.steerAdmissions?.some((admission) => admission.canonicalTurnId === attempt.canonicalTurnId)
					) {
						pending.delete(key);
						return current;
					}
				} catch {
					// An unavailable snapshot cannot prove whether the POST was accepted.
				}
				return undefined;
			}
			if (previous) {
				const accepted = await reconcile();
				if (accepted) return accepted;
			}
			try {
				await transport<TurnReceipt>(`${path}/${attempt.action}`, "POST", {
					text: draft.text,
					images,
					canonicalTurnId: attempt.canonicalTurnId,
					...(attempt.action === "steer" ? { turnId: attempt.turnId } : {}),
				});
				pending.delete(key);
				return undefined;
			} catch (error) {
				if (error instanceof RequestError && error.status >= 400 && error.status < 500) {
					pending.delete(key);
					throw error;
				}
				const accepted = await reconcile();
				if (accepted) return accepted;
				throw error;
			}
		},
	};
}
