import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const { values } = parseArgs({ options: { out: { type: "string" } } });
const executableName = process.platform === "win32" ? "pie-agent.exe" : "pie-agent";
const output = resolve(repositoryRoot, values.out ?? join("dist", executableName));
const temporary = mkdtempSync(join(tmpdir(), "pie-sidecar-"));

function run(command, args) {
	const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
	if (result.status === 0) return;
	throw new Error([`Command failed: ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"));
}

try {
	const bundle = join(temporary, "pie-sidecar.cjs");
	const blob = join(temporary, "pie-sidecar.blob");
	const seaConfig = join(temporary, "sea-config.json");
	await build({
		absWorkingDir: repositoryRoot,
		bundle: true,
		conditions: ["source"],
		define: { "import.meta.url": JSON.stringify("file:///pie-sidecar.cjs") },
		entryPoints: ["packages/server/src/sidecar.ts"],
		format: "cjs",
		ignoreAnnotations: true,
		legalComments: "none",
		outfile: bundle,
		platform: "node",
		target: "node22.19",
	});
	writeFileSync(
		seaConfig,
		JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
	);
	run(process.execPath, ["--experimental-sea-config", seaConfig]);
	mkdirSync(dirname(output), { recursive: true });
	copyFileSync(process.execPath, output);
	if (process.platform === "darwin") run("codesign", ["--remove-signature", output]);
	const postjectArguments = [
		require.resolve("postject/dist/cli.js"),
		output,
		"NODE_SEA_BLOB",
		blob,
		"--sentinel-fuse",
		"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
	];
	if (process.platform === "darwin") postjectArguments.push("--macho-segment-name", "NODE_SEA");
	run(process.execPath, postjectArguments);
	if (process.platform === "darwin") run("codesign", ["--sign", "-", output]);
	if (process.platform !== "win32") chmodSync(output, 0o755);
	console.log(`Built ${basename(output)} (${readFileSync(output).byteLength} bytes)`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
