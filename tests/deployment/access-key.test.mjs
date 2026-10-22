import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import {
	createAccessControl,
	ACCESS_COOKIE,
	COOKIE_MAX_AGE,
} from "../../deployment/access-key.mjs";
import {
	createKeyClient,
	STORAGE_KEY,
	returnTarget,
} from "../../deployment/public/access-key-client.js";

const key = crypto.randomBytes(32).toString("base64url");
const memoryStorage = () => {
	const values = new Map();
	return {
		getItem: (k) => values.get(k),
		setItem: (k, v) => values.set(k, v),
		removeItem: (k) => values.delete(k),
	};
};

test("a fixed key authenticates after the previous session expiry and rejects malformed cookies", () => {
	const access = createAccessControl(key);
	const request = { headers: { cookie: access.cookie().split(";")[0] } };
	const original = Date.now;
	try {
		Date.now = () => original() + 30 * 365 * 86400000;
		assert.equal(access.authenticated(request), true);
	} finally {
		Date.now = original;
	}
	for (const cookie of [
		"",
		`${ACCESS_COOKIE}=wrong`,
		`${ACCESS_COOKIE}=%E0%A4%A`,
		`${request.headers.cookie}; ${request.headers.cookie}`,
		"__Host-scramjet-turn-session=old.session",
	]) {
		assert.equal(access.authenticated({ headers: { cookie } }), false);
	}
	assert.match(access.cookie(), /Secure; HttpOnly; SameSite=Strict/);
	assert.match(access.cookie(), new RegExp(`Max-Age=${COOKIE_MAX_AGE}`));
	assert.equal(access.cookie().includes("Domain="), false);
	assert.equal(
		createAccessControl(crypto.randomBytes(32).toString("hex")).authenticated(
			request
		),
		false
	);
});

test("fresh frontend instances restore a saved key and discard it only after an authentication rejection", async () => {
	const storage = memoryStorage();
	let status = 200;
	const request = async (url, options) => {
		assert.equal(url, "/api/login");
		assert.equal(options.credentials, "same-origin");
		assert.equal(JSON.parse(options.body).accessKey, key);
		if (status === 0) throw new TypeError("network offline");
		return {
			ok: status === 200,
			status,
			json: async () => ({ ok: status === 200, error: "invalid" }),
		};
	};
	await createKeyClient({ storage, request }).authorize(key);
	assert.equal(storage.getItem(STORAGE_KEY), key);
	assert.equal(await createKeyClient({ storage, request }).restore(), true);
	status = 0;
	await assert.rejects(createKeyClient({ storage, request }).restore());
	assert.equal(storage.getItem(STORAGE_KEY), key);
	status = 429;
	await assert.rejects(createKeyClient({ storage, request }).restore());
	assert.equal(storage.getItem(STORAGE_KEY), key);
	status = 401;
	await assert.rejects(createKeyClient({ storage, request }).restore());
	assert.equal(storage.getItem(STORAGE_KEY), undefined);
	assert.equal(await createKeyClient({ storage, request }).restore(), false);
});

test("storage restrictions retain cookie-based access and return URLs stay on the same origin", async () => {
	const client = createKeyClient({
		storage: null,
		request: async () => ({ ok: true, json: async () => ({ ok: true }) }),
	});
	await client.authorize(key);
	assert.equal(client.load(), "");
	client.forget();
	assert.equal(
		returnTarget(
			"?return=" + encodeURIComponent("/path?q=1#anchor"),
			"https://proxy.test"
		),
		"https://proxy.test/path?q=1#anchor"
	);
	for (const value of [
		"https://evil.test",
		"//evil.test",
		"/login?return=/login",
		"http://[invalid",
	]) {
		assert.equal(
			returnTarget(
				"?return=" + encodeURIComponent(value),
				"https://proxy.test"
			),
			"https://proxy.test/"
		);
	}
});

test("gateway enforces the key for HTTP, WebSocket and TURN, renews cookies, and clears access on logout", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "scramjet-access-"));
	await writeFile(path.join(directory, "key"), key, { mode: 0o600 });
	const child = spawn(process.execPath, ["deployment/app.mjs"], {
		cwd: new URL("../..", import.meta.url),
		env: {
			...process.env,
			PORT: "0",
			LISTEN_HOST: "127.0.0.1",
			PROXY_DOMAIN: "proxy.test",
			ACCESS_KEY_FILE: path.join(directory, "key"),
			PUBLIC_ROOT: directory,
			CREDENTIAL_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
			TURN_STATIC_AUTH_SECRET: crypto.randomBytes(32).toString("hex"),
			TURN_URLS: "turn:192.0.2.1:3478",
			SOURCE_COMMIT: "access-key-test",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(async () => {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(directory, { recursive: true, force: true });
	});
	const port = await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Gateway startup timeout")),
			10000
		);
		child.stdout.on("data", (data) => {
			const match = String(data).match(/port=(\d+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(Number(match[1]));
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Gateway exited: ${code}`));
		});
	});
	const call = (route, options = {}) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				`http://127.0.0.1:${port}${route}`,
				{
					method: options.method || "GET",
					headers: { host: "proxy.test", ...options.headers },
				},
				(response) => {
					const chunks = [];
					response.on("data", (chunk) => chunks.push(chunk));
					response.on("end", () => {
						const headers = new Headers();
						for (const [name, value] of Object.entries(response.headers)) {
							for (const item of Array.isArray(value) ? value : [value])
								if (item) headers.append(name, item);
						}
						resolve(
							new Response(Buffer.concat(chunks), {
								status: response.statusCode,
								headers,
							})
						);
					});
				}
			);
			request.on("error", reject);
			request.end(options.body);
		});
	const login = (accessKey) =>
		call("/api/login", {
			method: "POST",
			headers: {
				origin: "https://proxy.test",
				"content-type": "application/json",
			},
			body: JSON.stringify({ accessKey }),
		});
	assert.equal((await call("/api/session")).status, 401);
	assert.equal((await login("wrong")).status, 401);
	assert.equal(
		(
			await call("/api/login", {
				method: "POST",
				headers: { origin: "https://evil.test" },
				body: JSON.stringify({ accessKey: key }),
			})
		).status,
		403
	);
	const success = await login(key);
	assert.equal(success.status, 200);
	assert.equal((await success.json()).expiresAt, null);
	const cookies = success.headers.getSetCookie();
	const cookie = cookies
		.find((value) => value.startsWith(ACCESS_COOKIE + "="))
		.split(";")[0];
	assert.equal(decodeURIComponent(cookie.slice(ACCESS_COOKIE.length + 1)), key);
	const session = await call("/api/session", { headers: { cookie } });
	assert.equal(session.status, 200);
	assert.equal((await session.json()).expiresAt, null);
	assert.match(session.headers.get("set-cookie"), /Max-Age=34560000/);
	assert.equal(
		(await call("/api/config", { headers: { cookie } })).status,
		200
	);
	const turn = await call("/turn-credentials", {
		headers: { cookie, origin: "https://proxy.test" },
	});
	assert.equal(turn.status, 200);
	const credential = await turn.json();
	assert.equal(credential.ttl, 120);
	assert.ok(Number(credential.username.split(":")[0]) > Date.now() / 1000);
	assert.equal(
		(
			await call("/turn-credentials", {
				headers: { authorization: "Bearer forged" },
			})
		).status,
		401
	);
	assert.equal(
		(await call("/api/session", { headers: { cookie, host: "evil.test" } }))
			.status,
		421
	);

	async function upgrade(token, origin = "https://proxy.test") {
		const socket = net.connect(port, "127.0.0.1");
		let response = "";
		const result = new Promise((resolve, reject) => {
			socket.setTimeout(3000, () => {
				socket.destroy();
				reject(new Error("Upgrade timeout"));
			});
			socket.on("error", reject);
			socket.on("data", (chunk) => {
				response += chunk.toString();
				if (response.includes("\r\n")) {
					resolve(response.split("\r\n")[0]);
					socket.destroy();
				}
			});
		});
		socket.write(
			`GET /wisp/ HTTP/1.1\r\nHost: proxy.test\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nCookie: ${token}\r\n\r\n`
		);
		return result;
	}
	assert.match(await upgrade(""), /401/);
	assert.match(await upgrade(cookie, "https://evil.test"), /401/);
	assert.match(await upgrade(cookie), /101/);
	const logout = await call("/api/logout", {
		method: "POST",
		headers: { origin: "https://proxy.test", cookie },
	});
	assert.equal(logout.status, 200);
	assert.ok(
		logout.headers.getSetCookie().every((value) => value.includes("Max-Age=0"))
	);
	assert.match(logout.headers.get("clear-site-data"), /storage/);
	assert.equal((await call("/api/session")).status, 401);
	const storage = memoryStorage();
	storage.setItem(STORAGE_KEY, key);
	createKeyClient({ storage }).forget();
	assert.equal(storage.getItem(STORAGE_KEY), undefined);
});
