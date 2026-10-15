import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Builds the single-file sidecar with `bun build --compile` for every Cowork target.
// Usage: node packages/server/scripts/build-sidecar-bun.mjs [--target-os=win32,darwin] [--compile-executable-dir=<dir>]
//
// --compile-executable-dir points at predownloaded Bun runtimes laid out as
// <dir>/bun-darwin-arm64/bun and <dir>/bun-windows-x64/bun.exe, so a CI machine never
// has to download them mid-build. Targets without a runtime there keep using Bun's cache.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");

// Cowork resolves the sidecar from resources/binaries/<platform>/<arch>/, so the output
// layout uses that naming: windows/amd64 rather than win32/x64.
const targets = [
	{ os: "win32", arch: "x64" },
	{ os: "darwin", arch: "arm64" },
	{ os: "darwin", arch: "x64" },
];

const { values } = parseArgs({
	options: { "target-os": { type: "string" }, "compile-executable-dir": { type: "string" } },
});

const platformName = (os) => (os === "win32" ? "windows" : os);
const architectureName = (arch) => (arch === "x64" ? "amd64" : arch);
const compileTargetName = (target) => `bun-${platformName(target.os)}-${target.arch}`;

const requested = values["target-os"]
	?.split(",")
	.map((item) => item.trim())
	.filter(Boolean);
const selected = targets.filter((target) => !requested || requested.includes(target.os));
if (selected.length === 0) throw new Error(`No build targets selected: ${requested?.join(", ")}`);

const executableDir = values["compile-executable-dir"]?.replace(/[\\/]+$/, "");

for (const target of selected) {
	const compileTarget = compileTargetName(target);
	const output = join(
		repositoryRoot,
		"dist",
		platformName(target.os),
		architectureName(target.arch),
		target.os === "win32" ? "pie-agent.exe" : "pie-agent",
	);
	const runtime = executableDir
		? join(executableDir, compileTarget, target.os === "win32" ? "bun.exe" : "bun")
		: undefined;
	if (runtime && !existsSync(runtime)) throw new Error(`Missing Bun executable for ${compileTarget}: ${runtime}`);

	console.log(`building ${platformName(target.os)}/${architectureName(target.arch)} (${compileTarget})`);
	mkdirSync(dirname(output), { recursive: true });
	const args = [
		"build",
		"--compile",
		`--target=${compileTarget}`,
		"--conditions=source",
		`--outfile=${output}`,
		...(runtime ? [`--compile-executable-path=${runtime}`] : []),
		join(repositoryRoot, "packages/server/src/sidecar.ts"),
	];
	const result = spawnSync("bun", args, { cwd: repositoryRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`bun build failed for ${compileTarget}`);

	writeFileSync(
		`${output}.LICENSES.txt`,
		[
			readFileSync(join(repositoryRoot, "packages/mcp/LICENSE"), "utf8"),
			"MCP TypeScript SDK OAuth implementation:",
			readFileSync(join(repositoryRoot, "packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt"), "utf8"),
			"Amio/OpenCode webfetch implementation:",
			readFileSync(join(repositoryRoot, "packages/local/LICENSES/opencode.txt"), "utf8"),
			"Webfetch HTML conversion dependencies:",
			readFileSync(join(repositoryRoot, "packages/local/LICENSES/webfetch-dependencies.txt"), "utf8"),
		].join("\n\n"),
	);
	if (process.platform !== "win32") chmodSync(output, 0o755);
}

// Bun leaves the darwin build carrying the signature of the runtime it appended to, so the
// file is not validly signed. Cowork re-signs the nested binaries while packaging the
// installer, so this script deliberately does not sign (and does not need rcodesign).
