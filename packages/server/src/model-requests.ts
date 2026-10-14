import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProviderRequestOptions } from "@earendil-works/pi-ai";

export type ModelRequestRecord = {
	schemaVersion: 1;
	id: string;
	sessionId: string;
	createdAt: number;
	purpose: "turn" | "compaction";
	provider: string;
	model: string;
	api: string;
	payload: unknown;
};

type PayloadHook = NonNullable<ProviderRequestOptions["onPayload"]>;

export function createModelRequestRecorder(env: NodeJS.ProcessEnv) {
	const directory = resolve(env.PI_DATA_DIR || ".pie", "model-requests");
	let warned = false;
	return (sessionId: string, purpose: ModelRequestRecord["purpose"], previous?: PayloadHook): PayloadHook =>
		async (payload, model) => {
			const replacement = await previous?.(payload, model);
			const createdAt = Date.now();
			const id = `${createdAt}-${randomUUID()}`;
			const record: ModelRequestRecord = {
				schemaVersion: 1,
				id,
				sessionId,
				createdAt,
				purpose,
				provider: model.provider,
				model: model.id,
				api: model.api,
				payload: replacement === undefined ? payload : replacement,
			};
			try {
				const sessionDirectory = join(directory, createHash("sha256").update(sessionId).digest("hex"));
				await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
				const destination = join(sessionDirectory, `${id}.json`);
				await writeFile(`${destination}.tmp`, JSON.stringify(record), { flag: "wx", mode: 0o600 });
				await rename(`${destination}.tmp`, destination);
			} catch {
				if (!warned) {
					warned = true;
					console.warn(
						"Model request recording failed; model calls continue, but their complete payloads may not be saved.",
					);
				}
			}
			return replacement;
		};
}
