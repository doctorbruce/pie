import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSnapshot } from "@pie/runtime/protocol";
import { createCoreServer } from "../src/server.ts";

test(
	"HTTP always approval remembers native command classes only in the current conversation",
	{ timeout: 30000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "pie-permission-memory-"));
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const script = join(workspace, "report.js");
		await writeFile(script, "console.log(process.argv[2]);\n");
		const env = { PI_DATA_DIR: join(root, "data"), PI_TOOL_STREAM_TRACE: "0" };
		let core = createCoreServer(env);
		context.after(async () => {
			await core.close();
			await rm(root, { recursive: true, force: true });
		});
		let base = "";
		const start = async () => {
			await core.ready;
			await new Promise<void>((resolve) => core.server.listen(0, "127.0.0.1", resolve));
			const address = core.server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
		};
		const request = async (path: string, body: unknown, method = "POST") => {
			const response = await fetch(`${base}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(15000),
			});
			assert(response.ok, JSON.stringify(await response.clone().json()));
			return response.json();
		};
		await start();
		await request(
			"/host-runtimes",
			{
				runtimes: [
					{
						assistantId: "helper",
						assistantRevision: "1",
						runtime: {
							systemPrompt: "",
							toolIds: ["bash"],
							skills: [],
							subagents: [],
							permissions: { "*": "allow", bash: "ask", external_directory: "ask" },
						},
					},
				],
			},
			"PUT",
		);
		const session = (await request("/sessions", {
			assistantId: "helper",
			workspacePath: workspace,
		})) as SessionSnapshot;
		const run = async (id: string, value: string, remember: boolean, entry = script) => {
			const runtime = await core.ready;
			const approvals: Promise<unknown>[] = [];
			let prompts = 0;
			const unsubscribe = await runtime.subscribe(id, (packet) => {
				if (packet.type !== "interaction.requested" || !packet.interaction) return;
				prompts++;
				assert(packet.interaction.remember);
				approvals.push(
					request(`/sessions/${id}/interactions/${packet.interaction.id}`, { approved: true, remember }),
				);
			});
			try {
				const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${entry}" ${value}`;
				await request(`/sessions/${id}/turns`, { text: `调用工具 bash ${JSON.stringify({ command })}` });
				const snapshot = await runtime.waitForTurn(id);
				await Promise.all(approvals);
				const result = snapshot.messages.filter((message) => message.role === "toolResult").at(-1);
				assert(result && !result.isError);
				assert.match(JSON.stringify(result), new RegExp(value));
				return prompts;
			} finally {
				unsubscribe();
			}
		};
		assert.equal(await run(session.id, "first", false), 1);
		assert.equal(await run(session.id, "second", true), 1);
		assert.equal(await run(session.id, "third", false), 0);
		await core.close();
		core = createCoreServer(env);
		await start();
		assert.equal(await run(session.id, "restarted", false), 0);
		const otherScript = join(workspace, "cleanup.js");
		await writeFile(otherScript, "console.log(process.argv[2]);\n");
		assert.equal(await run(session.id, "otherentry", false, otherScript), 1);
		const other = (await request("/sessions", {
			assistantId: "helper",
			workspacePath: workspace,
		})) as SessionSnapshot;
		assert.equal(await run(other.id, "otherconversation", false), 1);
	},
);
