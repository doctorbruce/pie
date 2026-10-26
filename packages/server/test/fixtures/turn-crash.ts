import { createAgentFactory } from "@pie/local";
import { createRuntime } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../../local/src/store.ts";

const [directory, boundary] = process.argv.slice(2);
if (!directory || !boundary) throw new Error("directory and boundary are required");
const environment = { PI_DATA_DIR: directory, PI_TOOLS_DIR: directory, PI_TURN_RECOVERY: "manual" };
const local = openStore(environment);
const store = createSqliteRuntimeStore(local);
const save = store.saveSession;
store.saveSession = async (...args) => {
	const session = structuredClone(args[0]);
	const metadata = await save(...args);
	const last = session.messages.at(-1);
	if (session.turn?.status !== "running" || !last) return metadata;
	const toolCall = last.role === "assistant" && last.content.some((part) => part.type === "toolCall");
	const matched =
		boundary === "early-tool-call"
			? Boolean(session.turnCheckpoint?.pendingAssistant)
			: boundary === "cancel"
				? session.turnCheckpoint?.cancelRequested === true
				: boundary === "user"
					? last.role === "user"
					: boundary === "tool-call"
						? toolCall
						: boundary === "tool-result"
							? last.role === "toolResult"
							: last.role === "assistant" && !toolCall;
	if (matched) {
		await new Promise<never>(() => {
			process.stdout.write(
				`${JSON.stringify({ sessionId: session.id, turnId: session.turn!.id, requestId: session.turn!.requestId, checkpoint: session.turnCheckpoint })}\n`,
				() => process.exit(0),
			);
		});
	}
	return metadata;
};
const factory = createAgentFactory(environment);
const runtime = await createRuntime({
	agents: {
		...factory,
		create(...args: Parameters<typeof factory.create>) {
			const agent = factory.create(...args);
			if (boundary === "tool-call") agent.beforeToolCall = () => new Promise<never>(() => {});
			return agent;
		},
	},
	store,
	hostRuntimes: local.hostRuntimes,
	saveHostRuntimes: async (definitions) => local.replaceHostRuntimes(definitions),
});
await runtime.registerHostRuntimes([
	{
		assistantId: "assistant",
		assistantRevision: "original",
		runtime: {
			systemPrompt: "original prompt",
			toolIds: ["write"],
			skills: [],
			subagents: [],
			permissions: { "*": "allow" },
		},
	},
]);
const session = await runtime.createSession({ assistantId: "assistant", workspacePath: directory });
if (boundary === "cancel") {
	await runtime.subscribe(session.id, (event) => {
		if (event.event?.type === "message_update") void runtime.cancelTurn(session.id, { turnId: event.turnId! });
	});
}
await runtime.submitTurn(session.id, {
	text:
		boundary === "user" || boundary === "cancel"
			? "hello"
			: '调用工具 write {"path":"effect.txt","content":"original effect","artifactRole":"final"}',
	requestId: "original-request",
	systemPrompt: "original dynamic prompt",
});
await runtime.waitForTurn(session.id);
throw new Error("Expected a simulated crash before settlement");
