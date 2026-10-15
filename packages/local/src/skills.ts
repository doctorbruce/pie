import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AfterToolCallContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RuntimeConfig, ToolActivity } from "@pie/runtime/protocol";
import { readText } from "./tools/files.ts";

async function sampleSkillFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const pending = [directory];
	while (pending.length && files.length < 10) {
		const current = pending.shift()!;
		const entries = await readdir(current, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			signal?.throwIfAborted();
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && !(current === directory && entry.name.toLowerCase() === "skill.md"))
				files.push(path);
			if (files.length >= 10) break;
		}
	}
	return files;
}

export function createSkillTools(runtime: RuntimeConfig, record: (activity: ToolActivity) => unknown) {
	type SkillDetails = { activity: ToolActivity; files: string[]; directory: string };
	const completed = new Map<string, SkillDetails>();
	const loadParameters = Type.Object(
		{ id: Type.String({ description: "Exact binding ID from the available skills catalog" }) },
		{ additionalProperties: false },
	);
	const load: AgentTool<typeof loadParameters, SkillDetails> = {
		name: "skill",
		label: "加载技能",
		description:
			"Load a mounted skill by its exact binding ID and record its plugin source. Use read for references and bash for commands described in the loaded skill.",
		parameters: loadParameters,
		async execute(toolCallId, { id }, signal) {
			const binding = runtime.skills.find((skill) => skill.id === id);
			if (!binding) throw new Error("此 Skill 未挂载到当前会话");
			let activity: ToolActivity = {
				id: randomUUID(),
				toolCallId,
				kind: "skill_load",
				binding: structuredClone(binding),
				status: "running",
				startedAt: Date.now(),
			};
			try {
				signal?.throwIfAborted();
				// Persist admission before reading the skill.
				await record(structuredClone(activity));
				const body = await readText(join(binding.directory, "SKILL.md"), signal, false);
				const files = await sampleSkillFiles(binding.directory, signal);
				activity.contentHash = createHash("sha256").update(body).digest("hex");
				const output = [
					`<skill_content name="${binding.name}">`,
					body.trim(),
					"",
					...(binding.resourceRoot ? [`Resource root: ${binding.resourceRoot}`] : []),
					`Skill directory: ${binding.directory}`,
					"Relative paths in this skill are relative to the skill directory. File list is sampled.",
					"<skill_files>",
					...files.map((path) => `<file>${path}</file>`),
					"</skill_files>",
					"</skill_content>",
				].join("\n");
				activity = { ...activity, status: "succeeded", finishedAt: Date.now() };
				const details = { activity, files, directory: binding.directory };
				completed.set(toolCallId, details);
				await record(structuredClone(activity));
				return { content: [{ type: "text" as const, text: output }], details };
			} catch (error) {
				activity = {
					...activity,
					status: signal?.aborted ? "cancelled" : "failed",
					finishedAt: Date.now(),
					error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
				};
				completed.set(toolCallId, { activity, files: [], directory: binding.directory });
				await record(structuredClone(activity));
				throw error;
			}
		},
	};
	return {
		tools: runtime.skills.length ? [load] : [],
		async afterToolCall({ toolCall }: AfterToolCallContext) {
			const details = completed.get(toolCall.id);
			completed.delete(toolCall.id);
			return details ? { details } : undefined;
		},
	};
}
