import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

type RetainedRecord = { path: string; bytes: number; createdAt: number };

function positiveLimit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const value = env[key];
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
		throw new Error(`${key} must be a positive safe integer`);
	return Number(value);
}

async function ensureDirectory(path: string) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (!(await lstat(path)).isDirectory()) throw new Error("Model request directory must not be a symbolic link");
}

export function createModelRequestRecorder(env: NodeJS.ProcessEnv) {
	const directory = resolve(env.PI_DATA_DIR || ".pie", "model-requests");
	if (env.PI_MODEL_REQUEST_RECORDING !== undefined && !["0", "1"].includes(env.PI_MODEL_REQUEST_RECORDING))
		throw new Error("PI_MODEL_REQUEST_RECORDING must be 0 or 1");
	const enabled = env.PI_MODEL_REQUEST_RECORDING !== "0";
	const maxBytes = positiveLimit(env, "PI_MODEL_REQUEST_MAX_BYTES", 100 * 1024 * 1024);
	const maxFiles = positiveLimit(env, "PI_MODEL_REQUEST_MAX_FILES", 1000);
	const maxAgeMs = positiveLimit(env, "PI_MODEL_REQUEST_MAX_AGE_MS", 7 * 24 * 60 * 60 * 1000);
	const maxRecordBytes = Math.min(positiveLimit(env, "PI_MODEL_REQUEST_MAX_RECORD_BYTES", 16 * 1024 * 1024), maxBytes);
	const entries = new Map<string, RetainedRecord>();
	const pending = new Map<string, Set<{ deleted: boolean }>>();
	const sessionDirectory = (id: string) => join(directory, createHash("sha256").update(id).digest("hex"));
	let commands = Promise.resolve();
	let closed = false;
	let initialized = false;
	let bytes = 0;
	let warned = false;
	function enqueue(operation: () => Promise<void>) {
		if (closed) return commands;
		commands = commands.then(operation).catch(() => {
			initialized = false;
			if (!warned) {
				warned = true;
				console.warn(
					"Model request recording or cleanup failed; model calls continue, but payloads may be missing or retained.",
				);
			}
		});
		return commands;
	}

	async function initialize() {
		if (initialized) return;
		entries.clear();
		bytes = 0;
		const root = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (root && !root.isDirectory()) throw new Error("Model request directory must be a directory");
		const sessions = root ? await readdir(directory, { withFileTypes: true }) : [];
		for (const session of sessions) {
			if (!session.isDirectory() || !/^[a-f0-9]{64}$/.test(session.name)) continue;
			const path = join(directory, session.name);
			for (const file of await readdir(path, { withFileTypes: true })) {
				if (!file.isFile()) continue;
				const match = /^(\d+)-[a-f0-9-]+\.json(\.tmp)?$/.exec(file.name);
				if (!match) continue;
				const destination = join(path, file.name);
				if (match[2]) {
					await rm(destination, { force: true });
					continue;
				}
				const size = (await lstat(destination)).size;
				entries.set(destination, { path: destination, bytes: size, createdAt: Number(match[1]) });
				bytes += size;
			}
		}
		initialized = true;
	}

	async function prune(reservedBytes = 0, reservedFiles = 0) {
		const cutoff = Date.now() - maxAgeMs;
		const oldest = [...entries.values()].sort((left, right) => left.createdAt - right.createdAt);
		for (const entry of oldest) {
			if (
				entry.createdAt > cutoff &&
				entries.size + reservedFiles <= maxFiles &&
				bytes + reservedBytes <= maxBytes &&
				entry.bytes <= maxRecordBytes
			)
				continue;
			await rm(entry.path, { force: true });
			entries.delete(entry.path);
			bytes -= entry.bytes;
			await rmdir(dirname(entry.path)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
			});
		}
	}

	const record =
		(sessionId: string, purpose: ModelRequestRecord["purpose"], previous?: PayloadHook): PayloadHook =>
		async (payload, model) => {
			if (!enabled || closed) return previous?.(payload, model);
			const token = { deleted: false };
			const active = pending.get(sessionId) ?? new Set<{ deleted: boolean }>();
			active.add(token);
			pending.set(sessionId, active);
			try {
				const replacement = await previous?.(payload, model);
				if (enabled)
					await enqueue(async () => {
						if (token.deleted) return;
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
						const body = JSON.stringify(record);
						const size = Buffer.byteLength(body);
						if (size > maxRecordBytes) return;
						await initialize();
						await prune(size, 1);
						const path = sessionDirectory(sessionId);
						await ensureDirectory(directory);
						await ensureDirectory(path);
						const destination = join(path, `${id}.json`);
						try {
							await writeFile(`${destination}.tmp`, body, { flag: "wx", mode: 0o600 });
							await rename(`${destination}.tmp`, destination);
						} catch (error) {
							await rm(`${destination}.tmp`, { force: true });
							throw error;
						}
						entries.set(destination, { path: destination, bytes: size, createdAt });
						bytes += size;
					});
				return replacement;
			} finally {
				active.delete(token);
				if (active.size === 0) pending.delete(sessionId);
			}
		};
	return Object.assign(record, {
		ready: () =>
			enqueue(async () => {
				await initialize();
				await prune();
			}),
		close() {
			closed = true;
			for (const tokens of pending.values()) for (const token of tokens) token.deleted = true;
			return commands;
		},
		deleteSession: (id: string) =>
			enqueue(async () => {
				for (const token of pending.get(id) ?? []) token.deleted = true;
				await initialize();
				const path = sessionDirectory(id);
				await rm(path, { recursive: true, force: true });
				for (const [key, entry] of entries)
					if (dirname(entry.path) === path) {
						entries.delete(key);
						bytes -= entry.bytes;
					}
			}),
	});
}
