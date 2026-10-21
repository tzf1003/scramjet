#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../.."
);
const tsc = path.join(root, "packages/core/node_modules/typescript/bin/tsc");
// Emit Core declarations first so downstream workspace APIs are checked against
// the same source, including when dist points to the shared external build disk.
for (const [project, config, noEmit] of [
	["core", "tsconfig.json", true],
	["core", "tsconfig.types.json", false],
	["controller", "tsconfig.json", true],
]) {
	execFileSync(
		process.execPath,
		[
			tsc,
			"--project",
			path.join(root, "packages", project, config),
			...(noEmit ? ["--noEmit"] : []),
			"--incremental",
			"false",
		],
		{ cwd: root, stdio: "inherit" }
	);
	console.log(JSON.stringify({ project, config, errors: 0 }));
}
execFileSync("pnpm", ["--dir", "packages/core", "lint"], {
	cwd: root,
	stdio: "inherit",
});
