import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CompactionModel, resolveCompactionSettings } from "@pie/runtime/compaction-settings";
import { stripJsonComments } from "./models/json.ts";

export function readCompactionSettings(env: NodeJS.ProcessEnv, model: CompactionModel) {
	const path = resolve(env.PI_DATA_DIR ?? ".pie", "settings.json");
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveCompactionSettings({}, model);
		throw error;
	}
	return resolveCompactionSettings(JSON.parse(stripJsonComments(content)), model);
}
