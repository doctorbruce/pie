import { createRuntime } from "@pie/runtime";
import { createSqliteRuntimeStore, openStore } from "../../../local/src/store.ts";
import { jobAgents, jobDefinition, persistentJobs } from "./durable-job-host.ts";

const [directory, boundary] = process.argv.slice(2);
const local = openStore({ PI_DATA_DIR: directory, PI_TURN_RECOVERY: "manual" });
const store = createSqliteRuntimeStore(local);
const jobs = persistentJobs(directory);
const save = store.saveSession;
store.saveSession = async (...args) => {
	const metadata = await save(...args);
	const reference = metadata.turnCheckpoint?.jobs?.[0];
	if (boundary === "before-submit" && reference) {
		await new Promise<never>(() => process.stdout.write(`${JSON.stringify(reference)}\n`, () => process.exit(0)));
	}
	return metadata;
};
const submit = jobs.executor.submit;
jobs.executor.submit = async (...args) => {
	await submit(...args);
	await new Promise<never>(() => process.stdout.write(`${JSON.stringify(args[0])}\n`, () => process.exit(0)));
};
const runtime = await createRuntime({ store, agents: jobAgents(), jobs: jobs.executor, hostRuntimes: [jobDefinition] });
const session = await runtime.createSession({ assistantId: "assistant" });
await runtime.submitTurn(session.id, {
	text: '调用工具 remote {"value":"effect"}',
	requestId: "request",
	systemPrompt: "original dynamic prompt",
});
await runtime.waitForTurn(session.id);
throw new Error("Expected a process exit at the durable job boundary");
