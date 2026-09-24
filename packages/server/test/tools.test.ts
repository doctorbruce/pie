import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPermissionPolicy } from "../src/tools/runtime.ts";
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
	assert.deepEqual([...tools.keys()], ["read", "edit", "write", "grep", "find", "ls"]);

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
