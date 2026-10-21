import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import {
	createCredentialServer,
	signCredentialSession,
} from "../server/credential-server.mjs";

test("credential issuance requires authenticated sessions, enforces quotas and observes revocation/rotation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "scramjet-credentials-"));
	const secretFile = join(directory, "turn-secret");
	const revokedFile = join(directory, "revoked.json");
	const signingSecret = crypto.randomBytes(32).toString("hex");
	const firstSecret = crypto.randomBytes(32).toString("hex");
	await writeFile(secretFile, firstSecret);
	await writeFile(revokedFile, "[]");
	const env = {
		TURN_STATIC_AUTH_SECRET_FILE: secretFile,
		CREDENTIAL_SESSION_SECRET: signingSecret,
		CREDENTIAL_REVOKED_USERS_FILE: revokedFile,
		TURN_URLS: "turn:127.0.0.1:3478",
		TURN_TTL: "120",
		CREDENTIAL_RATE_LIMIT: "2",
		CREDENTIAL_RATE_WINDOW_MS: "1000",
	};
	const server = createCredentialServer(env);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const token = signCredentialSession(
		"alice",
		signingSecret,
		Math.floor(Date.now() / 1000) + 60
	);
	const headers = { authorization: `Bearer ${token}` };
	try {
		assert.equal((await fetch(base + "/turn-credentials")).status, 401);
		assert.equal(
			(await fetch(base + "/turn-credentials-anything", { headers })).status,
			404
		);
		assert.equal(
			(await fetch(base + "/turn-credentials?query=1", { headers })).status,
			404
		);
		assert.equal(
			(
				await fetch(base + "/turn-credentials", {
					headers: { authorization: "Bearer invalid" },
				})
			).status,
			401
		);
		const response = await fetch(base + "/turn-credentials", { headers });
		assert.equal(response.status, 200);
		const value = await response.json();
		assert.equal(
			value.credential,
			crypto
				.createHmac("sha1", firstSecret)
				.update(value.username)
				.digest("base64")
		);
		assert.equal(
			(
				await fetch(base + "/turn-credentials", {
					headers: { cookie: `__Host-scramjet-turn-session=${token}` },
				})
			).status,
			200
		);
		assert.equal(
			(await fetch(base + "/turn-credentials", { headers })).status,
			429
		);
		await writeFile(revokedFile, '["alice"]');
		assert.equal(
			(await fetch(base + "/turn-credentials", { headers })).status,
			403
		);
		await writeFile(revokedFile, "[]");
		const secondSecret = crypto.randomBytes(32).toString("hex");
		await writeFile(secretFile, secondSecret);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const rotated = await (
			await fetch(base + "/turn-credentials", { headers })
		).json();
		assert.equal(
			rotated.credential,
			crypto
				.createHmac("sha1", secondSecret)
				.update(rotated.username)
				.digest("base64")
		);
		await writeFile(revokedFile, "invalid");
		assert.equal(
			(await fetch(base + "/turn-credentials", { headers })).status,
			503
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true });
	}
});

test("credential service fails closed on missing authentication configuration", () => {
	assert.throws(
		() =>
			createCredentialServer({
				TURN_STATIC_AUTH_SECRET: "x".repeat(32),
				TURN_URLS: "turn:127.0.0.1",
			}),
		/CREDENTIAL_SESSION_SECRET/
	);
});
