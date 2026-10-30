import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const testFilePattern = /\.test\.(?:mjs|cjs|js|ts)$/;

async function discover(root) {
	const path = resolve(root);
	const info = await stat(path);
	if (info.isFile()) return testFilePattern.test(path) ? [path] : [];
	if (!info.isDirectory()) return [];
	const entries = await readdir(path, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		files.push(...(await discover(resolve(path, entry.name))));
	}
	return files;
}

const roots = process.argv.slice(2);
if (!roots.length) throw new Error("需要至少一个测试目录");

const files = [...new Set((await Promise.all(roots.map(discover))).flat())].sort();
if (!files.length) throw new Error(`未发现测试文件：${roots.join(", ")}`);

console.log(`发现 ${files.length} 个 Node 测试文件：`);
for (const file of files) console.log(`  ${relative(process.cwd(), file)}`);

const child = spawn(
	process.execPath,
	[...process.execArgv, "--conditions=source", "--test", ...files.map((file) => relative(process.cwd(), file))],
	{ stdio: "inherit" },
);
child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`测试进程被信号 ${signal} 终止`);
		process.exitCode = 1;
	} else {
		process.exitCode = code ?? 1;
	}
});
