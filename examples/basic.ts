import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";

// Exercise the real Agent and model runtime without a network request.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("time", {}), { stopReason: "toolUse" }),
	(context) => {
		const result = context.messages.at(-1);
		if (result?.role !== "toolResult") throw new Error("Expected a tool result");
		return fauxAssistantMessage(`Current UTC time: ${contentText(result.content)}`);
	},
]);

const timeTool: AgentTool<ReturnType<typeof Type.Object>, undefined> = {
	name: "time",
	label: "Time",
	description: "Get the current UTC time",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: new Date().toISOString() }], details: undefined };
	},
};

const agent = new Agent({
	initialState: { model: faux.getModel(), tools: [timeTool] },
	streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await agent.prompt("What time is it?");
if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
console.log();
