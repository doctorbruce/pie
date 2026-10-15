import { extname } from "node:path";
import ts from "typescript";

export type FileDiagnostic = {
	severity: "error" | "warning";
	message: string;
	line?: number;
	column?: number;
	code?: string | number;
	source: string;
};

export type FileDiagnostics = Record<string, FileDiagnostic[]>;

export async function collectDiagnostics(path: string, source: string): Promise<FileDiagnostics> {
	const extension = extname(path).toLowerCase();
	if (extension === ".json" || extension === ".jsonc") {
		const parsed = ts.parseConfigFileTextToJson(path, source);
		const issues = parsed.error ? [toDiagnostic(parsed.error)] : [];
		return issues.length ? { [path]: issues } : {};
	}
	if (![".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) return {};
	const result = ts.transpileModule(source, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			jsx: ts.JsxEmit.ReactJSX,
		},
	});
	const issues = (result.diagnostics ?? []).map((diagnostic) => toDiagnostic(diagnostic));
	return issues.length ? { [path]: issues } : {};
}

export function formatDiagnostics(diagnostics: FileDiagnostics): string {
	return Object.entries(diagnostics)
		.flatMap(([path, issues]) =>
			issues.map(
				(issue) =>
					`${path}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""} ${issue.severity} ${issue.code ?? ""}: ${issue.message}`,
			),
		)
		.join("\n");
}

function toDiagnostic(diagnostic: ts.Diagnostic): FileDiagnostic {
	const position =
		diagnostic.file && diagnostic.start !== undefined
			? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
			: undefined;
	return {
		severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		line: position ? position.line + 1 : undefined,
		column: position ? position.character + 1 : undefined,
		code: diagnostic.code,
		source: "typescript",
	};
}
