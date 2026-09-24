import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createTwoFilesPatch } from "diff";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { collectDiagnostics, type FileDiagnostics, formatDiagnostics } from "./diagnostics.ts";
import { type ArtifactOutput, type ArtifactRole, authorizePath, type ToolRuntime } from "./runtime.ts";
import { MAX_BYTES, MAX_LINES, resolvePath, truncateHead, withFileMutationQueue } from "./shared.ts";

export async function readText(path: string, signal?: AbortSignal, truncate = true): Promise<string> {
	signal?.throwIfAborted();
	const file = await open(path, "r");
	try {
		if (!(await file.stat()).isFile()) throw new Error("只能读取普通文件");
		const buffer = Buffer.alloc(65537);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		signal?.throwIfAborted();
		if (!truncate && bytesRead > 65536) throw new Error("SKILL.md 超过 64 KiB");
		return (
			buffer.subarray(0, Math.min(bytesRead, 65536)).toString("utf8") +
			(bytesRead > 65536 ? "\n[已截断至 64 KiB]" : "")
		);
	} finally {
		await file.close();
	}
}

const imageTypes: Record<string, string> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const readParameters = Type.Object(
	{
		path: Type.String({ description: "Path to the file or directory to read (relative or absolute)" }),
		offset: Type.Optional(
			Type.Integer({ minimum: 1, description: "Line or directory entry to start at (1-indexed)" }),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines or directory entries" })),
		pages: Type.Optional(Type.String({ description: "PDF page or inclusive range, for example 3 or 1-5" })),
	},
	{ additionalProperties: false },
);

type ReadDetails = {
	path: string;
	type: "file" | "directory" | "image" | "pdf";
	truncation?: ReturnType<typeof truncateHead>;
	display?: Record<string, unknown>;
	pdf?: { pageCount: number; pages: { first: number; last: number } };
};

function parsePages(value: string | undefined): { first: number; last: number } | undefined {
	if (!value) return undefined;
	const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
	if (!match) throw new Error(`PDF 页码无效：${value}`);
	const first = Number(match[1]);
	const last = Number(match[2] ?? match[1]);
	if (first < 1 || last < first || last - first + 1 > 20) throw new Error("每次最多读取连续 20 页 PDF");
	return { first, last };
}

async function readPdf(data: Buffer, pages: string | undefined, signal?: AbortSignal) {
	if (data.byteLength > 100 * 1024 * 1024) throw new Error("PDF 超过 100 MiB");
	const requested = parsePages(pages);
	const loading = getDocument({ data: new Uint8Array(data), useSystemFonts: true, useWorkerFetch: false });
	try {
		const document = await loading.promise;
		const selected = requested ?? { first: 1, last: document.numPages };
		if (!requested && document.numPages > 10) throw new Error("PDF 超过 10 页，请使用 pages 分页读取");
		if (selected.last > document.numPages) throw new Error(`PDF 只有 ${document.numPages} 页`);
		const output: string[] = [];
		for (let pageNumber = selected.first; pageNumber <= selected.last; pageNumber++) {
			signal?.throwIfAborted();
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			let text = "";
			for (const item of content.items) {
				if (!("str" in item)) continue;
				text += item.str;
				text += item.hasEOL ? "\n" : " ";
			}
			output.push(`<page number="${pageNumber}">\n${text.trim()}\n</page>`);
		}
		const truncation = truncateHead(output.join("\n\n"));
		return {
			text: truncation.content + (truncation.truncated ? "\n\n[PDF 文本已达到输出上限，请缩小 pages 范围。]" : ""),
			truncation,
			pageCount: document.numPages,
			pages: selected,
		};
	} finally {
		await loading.destroy();
	}
}

function createReadTool(runtime: ToolRuntime): AgentTool<typeof readParameters, ReadDetails> {
	return {
		name: "read",
		label: "read",
		description: `Read text files, directory listings, images, and PDF pages. Text output is limited to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB.`,
		parameters: readParameters,
		async execute(_id, { path, offset, limit, pages }, signal) {
			signal?.throwIfAborted();
			const absolutePath = resolvePath(path, runtime.directory);
			await authorizePath(runtime, absolutePath, "read", signal);
			await access(absolutePath, constants.R_OK);
			const info = await stat(absolutePath);
			if (info.isDirectory()) {
				if (pages) throw new Error("pages 只适用于 PDF 文件");
				const entries = await readdir(absolutePath, { withFileTypes: true });
				entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
				const start = (offset ?? 1) - 1;
				if (start >= entries.length && entries.length > 0) throw new Error(`Offset ${offset} 超出目录范围`);
				const selected = entries
					.slice(start, start + (limit ?? 500))
					.map((entry) => entry.name + (entry.isDirectory() ? "/" : ""));
				const more = start + selected.length < entries.length;
				const text = [
					`<path>${absolutePath}</path>`,
					"<type>directory</type>",
					"<entries>",
					selected.join("\n") || "(empty directory)",
					more
						? `\n[Showing ${selected.length} of ${entries.length}. Use offset=${start + selected.length + 1}.]`
						: `\n(${entries.length} entries)`,
					"</entries>",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						path: absolutePath,
						type: "directory",
						display: { entries: selected, offset: start + 1, totalEntries: entries.length, truncated: more },
					},
				};
			}
			if (!info.isFile()) throw new Error("只能读取普通文件或目录");
			const data = await readFile(absolutePath);
			signal?.throwIfAborted();
			const extension = extname(absolutePath).toLowerCase();
			const mimeType = imageTypes[extension];
			if (mimeType) {
				if (pages) throw new Error("pages 只适用于 PDF 文件");
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: data.toString("base64"), mimeType },
					],
					details: { path: absolutePath, type: "image" },
				};
			}
			if (extension === ".pdf" || data.subarray(0, 5).toString("ascii") === "%PDF-") {
				const pdf = await readPdf(data, pages, signal);
				return {
					content: [{ type: "text", text: pdf.text }],
					details: {
						path: absolutePath,
						type: "pdf",
						truncation: pdf.truncation.truncated ? pdf.truncation : undefined,
						pdf: { pageCount: pdf.pageCount, pages: pdf.pages },
					},
				};
			}
			if (pages) throw new Error("pages 只适用于 PDF 文件");
			if (data.includes(0)) throw new Error(`不能读取二进制文件：${path}`);
			const lines = data.toString("utf8").split("\n");
			const start = (offset ?? 1) - 1;
			if (start >= lines.length)
				throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
			const selected = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
			const truncation = truncateHead(selected);
			let text = truncation.content;
			const shown = truncation.outputLines || (text ? 1 : 0);
			const consumed = limit === undefined ? shown : Math.min(limit, lines.length - start);
			if (truncation.truncated || start + consumed < lines.length)
				text += `\n\n[Showing lines ${start + 1}-${start + consumed} of ${lines.length}. Use offset=${start + consumed + 1} to continue.]`;
			return {
				content: [{ type: "text", text }],
				details: {
					path: absolutePath,
					type: "file",
					truncation: truncation.truncated ? truncation : undefined,
					display: {
						text: truncation.content,
						lineStart: start + 1,
						lineEnd: start + consumed,
						totalLines: lines.length,
					},
				},
			};
		},
	};
}

const artifactRole = Type.Union([Type.Literal("final"), Type.Literal("intermediate"), Type.Literal("temporary")]);
const editItem = Type.Object({
	oldText: Type.String({ description: "Exact, unique text to replace" }),
	newText: Type.String({ description: "Replacement text" }),
});
const editParameters = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editItem, {
		minItems: 1,
		description: "Non-overlapping replacements matched against the original file",
	}),
	artifactRole,
});

type FileMutationDetails = {
	filepath: string;
	exists: boolean;
	diff: string;
	diagnostics: FileDiagnostics;
	outputs: ArtifactOutput[];
};

async function mutationResult(path: string, original: string, updated: string, role: ArtifactRole, exists: boolean) {
	const diff = createTwoFilesPatch(path, path, original, updated, "before", "after", { context: 3 });
	const diagnostics = await collectDiagnostics(path, updated);
	return {
		diff,
		diagnostics,
		text: diagnostics[path]?.length
			? `File updated.\n\nDiagnostics:\n${formatDiagnostics(diagnostics)}`
			: "File updated successfully.",
		details: { filepath: path, exists, diff, diagnostics, outputs: [{ path, artifactRole: role }] },
	};
}

function createEditTool(runtime: ToolRuntime): AgentTool<typeof editParameters, FileMutationDetails> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit one file using exact text replacements and return its diff, diagnostics, and declared artifact.",
		parameters: editParameters,
		prepareArguments(input) {
			if (!input || typeof input !== "object" || Array.isArray(input)) return input as never;
			const value = { ...(input as Record<string, unknown>) };
			if (typeof value.edits === "string") {
				try {
					value.edits = JSON.parse(value.edits);
				} catch {}
			}
			if (value.edits && typeof value.edits === "object" && !Array.isArray(value.edits)) value.edits = [value.edits];
			if (typeof value.oldText === "string" && typeof value.newText === "string")
				value.edits = [
					...(Array.isArray(value.edits) ? value.edits : []),
					{ oldText: value.oldText, newText: value.newText },
				];
			return value as never;
		},
		async execute(_id, { path, edits, artifactRole }, signal) {
			const absolutePath = resolvePath(path, runtime.directory);
			await authorizePath(runtime, absolutePath, "edit", signal);
			return withFileMutationQueue(absolutePath, async () => {
				signal?.throwIfAborted();
				await access(absolutePath, constants.R_OK | constants.W_OK);
				const original = await readFile(absolutePath, "utf8");
				const matches = edits.map(({ oldText, newText }) => {
					if (!oldText) throw new Error("oldText must not be empty");
					const start = original.indexOf(oldText);
					if (start < 0) throw new Error(`Could not find exact text in ${path}`);
					if (original.indexOf(oldText, start + oldText.length) >= 0)
						throw new Error(`oldText is not unique in ${path}`);
					return { start, end: start + oldText.length, newText };
				});
				matches.sort((a, b) => a.start - b.start);
				for (let index = 1; index < matches.length; index++)
					if (matches[index].start < matches[index - 1].end) throw new Error("Edit replacements overlap");
				let updated = original;
				for (const match of [...matches].reverse())
					updated = updated.slice(0, match.start) + match.newText + updated.slice(match.end);
				const result = await mutationResult(absolutePath, original, updated, artifactRole, true);
				await runtime.ask(
					{
						type: "confirmation",
						title: "确认文件修改",
						message: result.diff,
						metadata: { permission: "edit", filepath: absolutePath, diff: result.diff },
					},
					signal,
				);
				signal?.throwIfAborted();
				await writeFile(absolutePath, updated, "utf8");
				return { content: [{ type: "text", text: result.text }], details: result.details };
			});
		},
	};
}

const writeParameters = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	artifactRole,
});

function createWriteTool(runtime: ToolRuntime): AgentTool<typeof writeParameters, FileMutationDetails> {
	return {
		name: "write",
		label: "write",
		description: "Write a file and return its diff, diagnostics, and declared artifact.",
		parameters: writeParameters,
		async execute(_id, { path, content, artifactRole }, signal) {
			const absolutePath = resolvePath(path, runtime.directory);
			await authorizePath(runtime, absolutePath, "edit", signal);
			return withFileMutationQueue(absolutePath, async () => {
				signal?.throwIfAborted();
				let original = "";
				let exists = true;
				try {
					original = await readFile(absolutePath, "utf8");
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
					exists = false;
				}
				const result = await mutationResult(absolutePath, original, content, artifactRole, exists);
				await runtime.ask(
					{
						type: "confirmation",
						title: "确认写入文件",
						message: result.diff,
						metadata: { permission: "edit", filepath: absolutePath, diff: result.diff },
					},
					signal,
				);
				await mkdir(dirname(absolutePath), { recursive: true });
				signal?.throwIfAborted();
				await writeFile(absolutePath, content, "utf8");
				return { content: [{ type: "text", text: result.text }], details: result.details };
			});
		},
	};
}

const lsParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum entries (default: 500)" })),
});

function createLsTool(runtime: ToolRuntime): AgentTool<typeof lsParameters, ReadDetails> {
	return {
		name: "ls",
		label: "ls",
		description: "List a directory alphabetically, including dotfiles. Directories have a trailing slash.",
		parameters: lsParameters,
		async execute(_id, { path, limit }, signal) {
			const result = await createReadTool(runtime).execute("ls", { path: path ?? ".", limit }, signal);
			return result;
		},
	};
}

export function fileTools(runtime: ToolRuntime): AgentTool[] {
	return [createReadTool(runtime), createEditTool(runtime), createWriteTool(runtime), createLsTool(runtime)];
}
