import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { BackgroundJobs } from "@pie/runtime/jobs";
import { applyPermissionPolicy, type ToolRuntime } from "@pie/runtime/tools";
import { systemTools } from "../../local/src/tools.ts";

test("host permission policy allows configured operations but preserves explicit confirmations", async () => {
	const requested: string[] = [];
	const ask = applyPermissionPolicy({ "*": "allow", "credential.request": "ask" }, async (request) => {
		requested.push(request.title);
	});
	await ask({ type: "confirmation", title: "shell", message: "run", metadata: { permission: "shell" } });
	await ask({
		type: "confirmation",
		title: "credential",
		message: "input",
		metadata: { permission: "credential.request" },
	});
	await ask({ type: "confirmation", title: "question", message: "choose" });
	assert.deepEqual(requested, ["credential", "question"]);
});

test("read, edit, write and grep expose optional user-visible activity descriptions", () => {
	const tools = new Map(systemTools({}).map((tool) => [tool.name, tool]));
	const cases = [
		{ name: "read", args: { path: "example.txt" } },
		{
			name: "edit",
			args: {
				path: "example.txt",
				edits: [{ oldText: "before", newText: "after" }],
				artifactRole: "final",
			},
		},
		{ name: "write", args: { path: "example.txt", content: "text", artifactRole: "final" } },
		{ name: "grep", args: { pattern: "text" } },
	];
	for (const { name, args } of cases) {
		const tool = tools.get(name);
		assert(tool);
		assert.match(tool.description, /Always set description/);
		assert.match(JSON.stringify(tool.parameters), /Short user-visible activity title/);
		assert.deepEqual(validateToolArguments(tool, fauxToolCall(name, args)), args);
		const titled = { ...args, description: "检查项目配置" };
		assert.deepEqual(validateToolArguments(tool, fauxToolCall(name, titled)), titled);
		for (const description of ["", "x".repeat(81)]) {
			assert.throws(() => validateToolArguments(tool, fauxToolCall(name, { ...args, description })));
		}
	}
	for (const name of ["find", "ls", "job_output", "job_kill"]) {
		const tool = tools.get(name);
		assert(tool);
		assert.doesNotMatch(JSON.stringify(tool.parameters), /Short user-visible activity title/);
	}
});

function pdf(text: string): Buffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	body += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body);
}

test("upstream tool set performs file, listing and search operations", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const tools = new Map(systemTools({}, directory).map((tool) => [tool.name, tool]));
	assert.deepEqual(
		[...tools.keys()],
		["read", "bash", "edit", "write", "grep", "find", "ls", "webfetch", "job_output", "job_kill"],
	);
	assert.equal(tools.has("powershell"), false);

	const write = tools.get("write");
	const read = tools.get("read");
	const edit = tools.get("edit");
	const ls = tools.get("ls");
	const grep = tools.get("grep");
	const find = tools.get("find");
	assert(write && read && edit && ls && grep && find);

	const written = await write.execute("write", {
		path: "nested/example.txt",
		description: "创建示例文件",
		content: "alpha\nbeta\n",
		artifactRole: "final",
	});
	assert.match(JSON.stringify(written.details), /"artifactRole":"final"/);
	assert.match(JSON.stringify(written.details), /@@/);
	assert.equal(await readFile(join(directory, "nested", "example.txt"), "utf8"), "alpha\nbeta\n");
	assert.match(
		JSON.stringify(await read.execute("read", { path: "nested/example.txt", description: "查看示例内容" })),
		/1: alpha/,
	);

	await writeFile(join(directory, "long.txt"), Array.from({ length: 100 }, () => "x".repeat(3000)).join("\n"));
	const bounded = await read.execute("read-bounded", { path: "long.txt" });
	const boundedText = JSON.stringify(bounded.content);
	const boundedDisplay = (bounded.details as { display?: { lineEnd?: number; truncated?: boolean } }).display;
	assert.match(boundedText, /line truncated to 2000 chars/);
	assert.equal(boundedDisplay?.truncated, true);
	assert(boundedDisplay?.lineEnd);
	assert.match(boundedText, new RegExp(`offset=${boundedDisplay.lineEnd + 1}`));

	await writeFile(join(directory, "correct-name.txt"), "found");
	await assert.rejects(read.execute("read-missing", { path: "correct.txt" }), /correct-name\.txt/);
	await writeFile(join(directory, "binary.docx"), "plain-looking bytes");
	await assert.rejects(read.execute("read-binary", { path: "binary.docx" }), /二进制文件/);
	await edit.execute("edit", {
		path: "nested/example.txt",
		description: "更新示例内容",
		artifactRole: "final",
		edits: [
			{ oldText: "alpha", newText: "first" },
			{ oldText: "beta", newText: "second" },
		],
	});
	assert.equal(await readFile(join(directory, "nested", "example.txt"), "utf8"), "first\nsecond\n");
	assert.match(JSON.stringify(await ls.execute("ls", { path: "." })), /nested\//);
	assert.match(
		JSON.stringify(await grep.execute("grep", { pattern: "second", path: ".", description: "查找更新内容" })),
		/example\.txt/,
	);
	assert.match(
		JSON.stringify(await grep.execute("grep-empty", { pattern: "missing-text", path: "nested/example.txt" })),
		/No matches found/,
	);
	const found = await find.execute("find", { pattern: "**/*.txt", path: "." });
	const foundText = found.content[0];
	assert(foundText.type === "text");
	assert.match(foundText.text.replaceAll("\\", "/"), /nested\/example\.txt/);

	const pdfPath = join(directory, "sample.pdf");
	await writeFile(pdfPath, pdf("Hello PDF"));
	const document = await read.execute("read-pdf", { path: pdfPath, pages: "1" });
	assert.match(JSON.stringify(document), /Hello PDF/);
	assert.match(JSON.stringify(document.details), /"pageCount":1/);
});

test("bash uses the platform shell and moves long commands to an incremental background job", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-shell-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const tools = new Map(systemTools({}, directory).map((tool) => [tool.name, tool]));
	const command =
		process.platform === "win32"
			? "Write-Output first; Start-Sleep -Milliseconds 150; Write-Output second"
			: "printf 'first\\n'; sleep 0.15; printf 'second\\n'";
	const shell = tools.get("bash");
	const output = tools.get("job_output");
	assert(shell && output);
	const started = await shell.execute("shell", { command, yieldMs: 1, timeout: 5_000 });
	const jobId = (started.details as { jobId?: string }).jobId;
	assert(jobId);
	const completed = await output.execute("output", { job_id: jobId, wait_ms: 5_000 });
	assert.match(JSON.stringify(completed), /second/);
	assert.match(JSON.stringify(completed.details), /"status":"completed"/);
});

test("bash applies permission policy before spawning and job_kill stops an immediate background command", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-shell-permission-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const jobs = new BackgroundJobs();
	t.after(() => jobs.close());
	const requested: Record<string, unknown>[] = [];
	const runtime: ToolRuntime = {
		sessionId: "permission-test",
		directory,
		jobs,
		async ask(request) {
			requested.push(request.metadata ?? {});
			throw new Error("denied");
		},
	};
	const guarded = new Map(systemTools({}, directory, runtime).map((tool) => [tool.name, tool]));
	const risky = process.platform === "win32" ? "Remove-Item victim.txt" : "rm victim.txt";
	await assert.rejects(guarded.get("bash")!.execute("risk", { command: risky }), /denied/);
	assert.equal(requested[0].permission, "bash");

	const normal = new Map(systemTools({}, directory).map((tool) => [tool.name, tool]));
	const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
	const started = await normal.get("bash")!.execute("sleep", { command: sleep, yieldMs: 0, timeout: 30_000 });
	const jobId = (started.details as { jobId?: string }).jobId;
	assert(jobId);
	const stopped = await normal.get("job_kill")!.execute("kill", { job_id: jobId });
	assert.match(JSON.stringify(stopped.details), /"status":"cancelled"/);
	assert.doesNotMatch(JSON.stringify(stopped.details), /"exit":0/);
	assert.match(JSON.stringify(stopped.content), /aborted/);
});

test("shell job completion follows exit codes without changing task completion", async () => {
	const jobs = new BackgroundJobs();
	const runtime: ToolRuntime = {
		sessionId: "exit-status-test",
		directory: process.cwd(),
		jobs,
		async ask() {},
	};
	const output = systemTools({}, runtime.directory, runtime).find((tool) => tool.name === "job_output");
	assert(output);
	for (const entry of [
		{ type: "shell", exit: 0, status: "completed" },
		{ type: "shell", exit: 7, status: "failed" },
		{ type: "shell", exit: null, status: "failed" },
		{ type: "shell", exit: undefined, status: "failed" },
		{ type: "task", exit: 7, status: "completed" },
	] as const) {
		const started = jobs.start({
			ownerSessionId: "exit-status-test",
			type: entry.type,
			title: "exit status",
			async run() {
				return { details: { exit: entry.exit } };
			},
		});
		const completed = await jobs.wait(started.id);
		assert.equal(completed?.status, entry.status);
		assert.equal(completed?.details?.exit, entry.exit);
		assert.equal(completed?.error, undefined);
		const result = await output.execute("poll", { job_id: started.id });
		const details = result.details as { status?: string; exit?: number | null };
		assert.equal(details.status, entry.status);
		assert.equal(details.exit, entry.type === "shell" ? entry.exit : undefined);
		if (entry.type === "task") assert.doesNotMatch(JSON.stringify(result.content), /Process exited/);
		else if (entry.exit === null || entry.exit === undefined)
			assert.match(JSON.stringify(result.content), /Process ended without an exit code/);
	}
});

test("foreground bash reports command failure without throwing or scanning output", async () => {
	const tools = new Map(systemTools({}).map((tool) => [tool.name, tool]));
	const shell = tools.get("bash");
	assert(shell);
	for (const entry of [
		{ exit: 0, status: "completed", output: "Error is just output" },
		{ exit: 7, status: "failed", output: "" },
	]) {
		const command =
			process.platform === "win32"
				? `Write-Output '${entry.output}'; exit ${entry.exit}`
				: `printf '%s\n' '${entry.output}'; exit ${entry.exit}`;
		const result = await shell.execute("exit", { command, yieldMs: 10_000, timeout: 5_000 });
		const details = result.details as { status?: string; exit?: number };
		assert.equal(details.status, entry.status);
		assert.equal(details.exit, entry.exit);
		const content = result.content[0];
		assert(content.type === "text");
		assert.match(content.text, new RegExp(`^\\[status: ${entry.status}\\]`));
		assert.match(content.text, new RegExp(`Process exited with code ${entry.exit}`));
		assert(content.text.includes(entry.output));
	}
});

test("background bash notification and polling retain the same failed exit", async (testContext) => {
	const jobs = new BackgroundJobs();
	testContext.after(() => jobs.close());
	const notifications: string[] = [];
	const runtime: ToolRuntime = {
		sessionId: "background-exit-test",
		directory: process.cwd(),
		jobs,
		async ask() {},
		async notifyBackground(message) {
			notifications.push(message);
		},
	};
	const tools = new Map(systemTools({}, runtime.directory, runtime).map((tool) => [tool.name, tool]));
	const shell = tools.get("bash");
	const output = tools.get("job_output");
	assert(shell && output);
	const started = await shell.execute("start", { command: "exit 7", yieldMs: 0, timeout: 5_000 });
	const initial = started.details as { jobId?: string; status?: string; exit?: number };
	assert(initial.jobId);
	assert.equal(initial.status, "running");
	assert.equal(initial.exit, undefined);
	assert.match(JSON.stringify(started.content), /Process running with job ID/);
	for (let poll = 0; poll < 2; poll++) {
		const result = await output.execute("poll", { job_id: initial.jobId, wait_ms: 5_000 });
		const details = result.details as { status?: string; exit?: number };
		assert.equal(details.status, "failed");
		assert.equal(details.exit, 7);
		assert.match(JSON.stringify(result.content), /Process exited with code 7/);
		if (poll === 1) assert.match(JSON.stringify(result.content), /no new output/);
	}
	assert.equal(jobs.get(initial.jobId)?.status, "failed");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /state="failed"/);
	assert.match(notifications[0], /Process exited with code 7/);
});

test("bash retains timeout and process startup failures as execution errors", async () => {
	const shell = systemTools({}).find((tool) => tool.name === "bash");
	assert(shell);
	const command = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
	await assert.rejects(
		shell.execute("timeout", { command, timeout: 25, yieldMs: 5_000 }),
		/Command timed out after 25ms/,
	);
	const missing = systemTools({ PI_SHELL: join(tmpdir(), "pie-nonexistent-shell", "missing.exe") }).find(
		(tool) => tool.name === "bash",
	);
	assert(missing);
	await assert.rejects(missing.execute("missing", { command: "exit 0", timeout: 5_000, yieldMs: 5_000 }), /ENOENT/);
});
