import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackgroundJobs } from "../src/tools/jobs.ts";
import { applyPermissionPolicy, type ToolRuntime } from "../src/tools/runtime.ts";
import { systemTools } from "../src/tools.ts";

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
		["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "job_output", "job_kill"],
	);

	const write = tools.get("write");
	const read = tools.get("read");
	const edit = tools.get("edit");
	const ls = tools.get("ls");
	const grep = tools.get("grep");
	const find = tools.get("find");
	assert(write && read && edit && ls && grep && find);

	const written = await write.execute("write", {
		path: "nested/example.txt",
		content: "alpha\nbeta\n",
		artifactRole: "final",
	});
	assert.match(JSON.stringify(written.details), /"artifactRole":"final"/);
	assert.match(JSON.stringify(written.details), /@@/);
	assert.equal(await readFile(join(directory, "nested", "example.txt"), "utf8"), "alpha\nbeta\n");
	assert.match(JSON.stringify(await read.execute("read", { path: "nested/example.txt" })), /alpha/);
	await edit.execute("edit", {
		path: "nested/example.txt",
		artifactRole: "final",
		edits: [
			{ oldText: "alpha", newText: "first" },
			{ oldText: "beta", newText: "second" },
		],
	});
	assert.equal(await readFile(join(directory, "nested", "example.txt"), "utf8"), "first\nsecond\n");
	assert.match(JSON.stringify(await ls.execute("ls", { path: "." })), /nested\//);
	assert.match(JSON.stringify(await grep.execute("grep", { pattern: "second", path: "." })), /example\.txt/);
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

test("shell moves long commands to background and job_output reads incremental completion", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pie-shell-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const tools = new Map(systemTools({}, directory).map((tool) => [tool.name, tool]));
	const name = process.platform === "win32" ? "powershell" : "bash";
	const command =
		process.platform === "win32"
			? "Write-Output first; Start-Sleep -Milliseconds 150; Write-Output second"
			: "printf 'first\\n'; sleep 0.15; printf 'second\\n'";
	const shell = tools.get(name);
	const output = tools.get("job_output");
	assert(shell && output);
	const started = await shell.execute("shell", { command, yieldMs: 1, timeout: 5 });
	const jobId = (started.details as { jobId?: string }).jobId;
	assert(jobId);
	const completed = await output.execute("output", { job_id: jobId, wait_ms: 5_000 });
	assert.match(JSON.stringify(completed), /second/);
	assert.match(JSON.stringify(completed.details), /"status":"completed"/);
});

test("shell permission analysis blocks risky commands before spawning and job_kill settles cancellation", async (t) => {
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
	const shellName = process.platform === "win32" ? "powershell" : "bash";
	const risky = process.platform === "win32" ? "Remove-Item victim.txt" : "rm victim.txt";
	await assert.rejects(guarded.get(shellName)!.execute("risk", { command: risky }), /denied/);
	assert.equal(requested[0].permission, "shell");

	const normal = new Map(systemTools({}, directory).map((tool) => [tool.name, tool]));
	const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
	const started = await normal.get(shellName)!.execute("sleep", { command: sleep, background: true, timeout: 30 });
	const jobId = (started.details as { jobId?: string }).jobId;
	assert(jobId);
	const stopped = await normal.get("job_kill")!.execute("kill", { job_id: jobId });
	assert.match(JSON.stringify(stopped.details), /"status":"cancelled"/);
});
