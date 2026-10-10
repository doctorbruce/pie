import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, contentText, Type } from "@earendil-works/pi-ai";
import type { ExternalTool } from "./external-tools.ts";

const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "or", "the", "to", "with"]);

function tokenize(text: string): string[] {
	return (
		text
			.normalize("NFKC")
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []
	).flatMap((term) => {
		if (!/\p{Script=Han}/u.test(term)) return STOP_WORDS.has(term) ? [] : [term];
		const characters = Array.from(term);
		return characters.length === 1
			? characters
			: characters.slice(1).map((character, index) => characters[index] + character);
	});
}

export function createToolSearch(tools: ExternalTool[], defaultDeferredIds: readonly string[] = []) {
	const allowed = new Set(tools.map((tool) => tool.name));
	const deferred = new Set(
		tools
			.filter(
				(tool) =>
					tool.exposure === "deferred" || (tool.exposure !== "default" && defaultDeferredIds.includes(tool.name)),
			)
			.map((tool) => tool.name),
	);
	const loaded = new Set(tools.filter((tool) => !deferred.has(tool.name)).map((tool) => tool.name));
	const documents = tools
		.filter((tool) => deferred.has(tool.name))
		.map((tool) => {
			const terms = tokenize(
				`${`${tool.name} ${tool.label} `.repeat(3)}${tool.description} ${JSON.stringify(tool.parameters)}`,
			);
			const frequencies = new Map<string, number>();
			for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
			return { tool, frequencies, length: terms.length };
		});
	const documentFrequency = new Map<string, number>();
	for (const document of documents)
		for (const term of document.frequencies.keys())
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	const averageLength = documents.reduce((total, document) => total + document.length, 0) / documents.length || 1;
	function activate(names: unknown) {
		if (Array.isArray(names))
			for (const name of names) if (typeof name === "string" && allowed.has(name)) loaded.add(name);
	}
	const parameters = Type.Object(
		{
			query: Type.String({
				minLength: 1,
				description: "Keywords describing the required tool, in Chinese or English, or an exact tool ID.",
			}),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to expose; defaults to 5." }),
			),
		},
		{ additionalProperties: false },
	);
	const search: AgentTool<typeof parameters, { loadedTools: string[] }> = {
		name: "tool_search",
		label: "搜索工具",
		description:
			"Discover business tools that are enabled but not yet exposed. Search by capability keywords (Chinese or English), parameter names, or an exact tool ID. Matching tools become callable with their full schemas on the next model request. This only discovers tools and does not execute them. Use it when the currently exposed tools cannot fulfill the user's request.",
		parameters,
		executionMode: "sequential",
		async execute(_callId, args) {
			const queryTerms = new Set(tokenize(args.query));
			const matches = documents
				.filter(({ tool }) => !loaded.has(tool.name))
				.map((document) => {
					let score = 0;
					for (const term of queryTerms) {
						const frequency = document.frequencies.get(term) ?? 0;
						if (!frequency) continue;
						const containing = documentFrequency.get(term) ?? 0;
						const inverseFrequency = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
						score +=
							(inverseFrequency * frequency * 2.5) /
							(frequency + 1.5 * (0.25 + (0.75 * document.length) / averageLength));
					}
					return { name: document.tool.name, score };
				})
				.filter((match) => match.score > 0)
				.sort((first, second) => second.score - first.score || first.name.localeCompare(second.name));
			const names = matches.slice(0, args.limit ?? 5).map((match) => match.name);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							loaded: names,
							message: names.length
								? "Full schemas are available on the next model request. Call the discovered tool to perform the operation."
								: "No additional tools matched. Try different keywords or an exact tool ID.",
						}),
					},
				],
				details: { loadedTools: names },
				addedToolNames: names,
			};
		},
	};
	return {
		tools: documents.length ? [...tools, search] : tools,
		restore(messages: AgentMessage[]) {
			for (const message of messages) {
				if (message.role === "assistant") {
					activate(message.content.filter((block) => block.type === "toolCall").map((block) => block.name));
				} else if (message.role === "toolResult" && !message.isError) {
					activate(message.addedToolNames);
					if (message.toolName !== "tool_search") continue;
					try {
						const result: unknown = JSON.parse(contentText(message.content));
						if (result && typeof result === "object" && "loaded" in result) activate(result.loaded);
					} catch {}
				}
			}
		},
		expose(context: Context): Context {
			return {
				...context,
				tools: context.tools?.filter((tool) => tool.name === "tool_search" || loaded.has(tool.name)),
			};
		},
	};
}
