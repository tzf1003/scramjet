#!/usr/bin/env node
// Existing repository diagnostics stay visible; every additional error fails CI.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../.."
);
const require = createRequire(path.join(root, "packages/core/package.json"));
const ts = require("typescript");
const base = process.argv[2] ?? "b14b709ac190b786dd03becbd0728ab72bdd3ad6";
const git = (...args) =>
	execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
const baselineFiles = new Set(
	git("ls-tree", "-r", "--name-only", base).trim().split("\n")
);
const cache = new Map();
function original(file) {
	const relative = path.relative(root, file).split(path.sep).join("/");
	if (
		!baselineFiles.has(relative) ||
		/(?:^|\/)node_modules\//.test(relative) ||
		!/\.(?:ts|json)$/.test(relative)
	)
		return ts.sys.readFile(file);
	if (!cache.has(relative))
		cache.set(relative, git("show", `${base}:${relative}`));
	return cache.get(relative);
}
function diagnostics(project, baseline) {
	const configFile = path.join(root, "packages", project, "tsconfig.json");
	const config = ts.readConfigFile(
		configFile,
		baseline ? original : ts.sys.readFile
	);
	const parsed = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		path.dirname(configFile),
		{ noEmit: true, incremental: false }
	);
	const host = ts.createCompilerHost(parsed.options);
	if (baseline) host.readFile = original;
	const files = baseline
		? parsed.fileNames.filter((file) =>
				baselineFiles.has(path.relative(root, file).split(path.sep).join("/"))
			)
		: parsed.fileNames;
	const program = ts.createProgram(files, parsed.options, host);
	return ts
		.getPreEmitDiagnostics(program)
		.filter((item) => item.category === ts.DiagnosticCategory.Error)
		.map((item) => ({
			file: item.file ? path.relative(root, item.file.fileName) : "config",
			code: item.code,
			message: ts.flattenDiagnosticMessageText(item.messageText, " "),
		}));
}
let failed = false;
for (const project of ["core", "controller"]) {
	const current = diagnostics(project, false),
		before = diagnostics(project, true);
	const counts = new Map();
	for (const item of before) {
		const key = JSON.stringify(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const introduced = [];
	for (const item of current) {
		const key = JSON.stringify(item);
		const remaining = counts.get(key) ?? 0;
		if (remaining) counts.set(key, remaining - 1);
		else introduced.push(item);
	}
	console.log(
		JSON.stringify({
			project,
			baseline: base,
			baselineErrors: before.length,
			currentErrors: current.length,
			introduced,
		})
	);
	if (introduced.length) failed = true;
}
// Own WebRTC modules are linted in full. Legacy Core lint remains a separate,
// visible repository task; this gate does not change or suppress its rules.
try {
	execFileSync(
		"pnpm",
		[
			"exec",
			"eslint",
			"src/shared/webrtc.ts",
			"src/client/shared/requests/webrtc.ts",
		],
		{ cwd: path.join(root, "packages/core"), stdio: "inherit" }
	);
} catch {
	failed = true;
}
process.exitCode = failed ? 1 : 0;
