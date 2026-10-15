import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("runtime source dependencies stay inside the package and never load local execution adapters", async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const source = resolve(root, "src");
	const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	};
	assert.equal("@pie/local" in manifest.dependencies, false);
	assert.equal("@pie/server" in manifest.dependencies, false);
	const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
	const pending = [source];
	let imports = 0;
	while (pending.length) {
		const directory = pending.pop()!;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const ast = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
			for (const statement of ast.statements) {
				if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
				const specifier = statement.moduleSpecifier;
				if (!specifier || !ts.isStringLiteral(specifier)) continue;
				imports++;
				const target = specifier.text;
				if (target.startsWith(".")) {
					const internal = relative(source, resolve(dirname(path), target));
					assert(!internal.startsWith("..") && !isAbsolute(internal), `${path}: ${target}`);
					continue;
				}
				if (target.startsWith("node:") || builtins.has(target)) {
					assert(
						["crypto", "path", "timers/promises"].includes(target.replace(/^node:/, "")),
						`${path}: ${target}`,
					);
					continue;
				}
				const packageName = target.startsWith("@") ? target.split("/").slice(0, 2).join("/") : target.split("/")[0];
				assert(packageName in manifest.dependencies, `${path}: undeclared ${target}`);
			}
		}
	}
	assert(imports > 20);
});
