import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function turnAction(
	action: "pause" | "unpause" | "restart" | "snapshot" | "link-down" | "link-up"
) {
	const directory = process.env.WEBRTC_TURN_CONTROL_DIR;
	assert.ok(
		directory,
		"run with tests/webrtc/run-browser-suite.py or isolation/run-linux-suite.py for real TURN fault injection"
	);
	const id = randomUUID();
	const temporary = path.join(directory, "turn-request.tmp");
	await writeFile(temporary, JSON.stringify({ id, action }));
	await rename(temporary, path.join(directory, "turn-request.json"));
	for (let attempt = 0; attempt < 400; attempt++) {
		try {
			const result = JSON.parse(
				await readFile(path.join(directory, "turn-response.json"), "utf8")
			);
			if (result.id === id) {
				assert.equal(result.ok, true, JSON.stringify(result));
				return result;
			}
		} catch (error) {
			// Docker bind mounts can briefly expose stale/partial metadata across
			// the host/VM boundary. Only a complete matching receipt is accepted.
			if (
				!(error instanceof SyntaxError) &&
				(error as NodeJS.ErrnoException).code !== "ENOENT"
			)
				throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`TURN ${action} did not complete`);
}
