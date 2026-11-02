import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RuntimeConfig, SkillBinding } from "./protocol.ts";

// Keep discovery results and the prompt index in the same host language.
export function skillDescription(binding: SkillBinding, language: string | undefined) {
	if (!language) return binding.description;
	const requested = language.trim().toLowerCase();
	const locale = requested.startsWith("zh") ? "zh-CN" : requested.startsWith("en") ? "en-US" : requested;
	return binding.descriptions?.[locale] ?? binding.description;
}

export function createSkillSearch(runtime: RuntimeConfig) {
	const parameters = Type.Object(
		{
			query: Type.String({
				description:
					"Skill ID, name or keywords in Chinese or English. Use an empty string or list to list available skills.",
			}),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 100,
					description: "Maximum results; defaults to 20 for search or 100 for a list.",
				}),
			),
		},
		{ additionalProperties: false },
	);
	const search: AgentTool<typeof parameters> = {
		name: "skill_search",
		label: "搜索技能",
		description:
			"Search or list skills mounted in the current session without reading their files or loading instructions. Search by exact binding ID, name or description keywords; an empty query or list returns the inventory. Use this instead of scanning plugin or skill directories to discover capabilities. Call skill with a returned exact id to load its instructions; skill_search does not execute skills.",
		parameters,
		async execute(_callId, { query, limit }, signal) {
			signal?.throwIfAborted();
			const normalized = query.normalize("NFKC").trim().toLowerCase();
			const inventory = ["", "list", "all", "skills", "技能", "技能清单"].includes(normalized);
			const exact = runtime.skills.find((binding) => binding.id === query.trim());
			const terms = normalized.split(/\s+/u);
			const matches = (exact && !inventory ? [exact] : runtime.skills)
				.filter((binding) => {
					if (inventory || binding === exact) return true;
					const text = [
						binding.id,
						binding.name,
						binding.description,
						...Object.values(binding.descriptions ?? {}),
					]
						.join("\n")
						.normalize("NFKC")
						.toLowerCase();
					return terms.some((term) => text.includes(term));
				})
				.sort((first, second) => first.id.localeCompare(second.id));
			const skills = matches.slice(0, limit ?? (inventory ? 100 : 20)).map((binding) => ({
				id: binding.id,
				name: binding.name,
				description: skillDescription(binding, runtime.language),
			}));
			const result = {
				skills,
				total: matches.length,
				shown: skills.length,
				truncated: skills.length < matches.length,
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
	return search;
}
