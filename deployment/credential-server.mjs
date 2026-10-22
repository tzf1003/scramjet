#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function hmac(secret, value) {
	return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}
function equal(a, b) {
	const left = Buffer.from(a),
		right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}
// Call from an authenticated application backend, then set an HttpOnly/Secure
// __Host-scramjet-turn-session cookie on the controller's origin.
export function signCredentialSession(subject, secret, expiresAt) {
	const payload = Buffer.from(
		JSON.stringify({ sub: subject, exp: expiresAt })
	).toString("base64url");
	return `${payload}.${hmac(secret, payload)}`;
}

export function createCredentialServer(env = process.env) {
	const readSecret = () =>
		env.TURN_STATIC_AUTH_SECRET_FILE
			? readFileSync(env.TURN_STATIC_AUTH_SECRET_FILE, "utf8").trim()
			: env.TURN_STATIC_AUTH_SECRET;
	if (!readSecret() || readSecret().length < 32)
		throw new Error("a TURN secret of at least 32 characters is required");
	const anonymousTest = env.ALLOW_ANONYMOUS_TEST_ONLY === "1";
	const sessionSecret = env.CREDENTIAL_SESSION_SECRET;
	if (!anonymousTest && (!sessionSecret || sessionSecret.length < 32))
		throw new Error(
			"CREDENTIAL_SESSION_SECRET of at least 32 characters is required"
		);
	const ttl = Number(env.TURN_TTL ?? 120);
	if (!Number.isSafeInteger(ttl) || ttl < 2 || ttl > 3600)
		throw new Error("TURN_TTL must be an integer between 2 and 3600 seconds");
	const urls = (env.TURN_URLS ?? "")
		.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
	if (!urls.length || urls.some((url) => !/^turns?:[^\s]+$/i.test(url)))
		throw new Error("TURN_URLS must contain turn:/turns: URLs");
	const limit = Number(env.CREDENTIAL_RATE_LIMIT ?? 30);
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error("CREDENTIAL_RATE_LIMIT must be positive");
	const windowMs = Number(env.CREDENTIAL_RATE_WINDOW_MS ?? 60000);
	if (!Number.isSafeInteger(windowMs) || windowMs < 1)
		throw new Error("CREDENTIAL_RATE_WINDOW_MS must be positive");
	const buckets = new Map();
	function allowed(key, now) {
		for (const [id, item] of buckets) if (now >= item.until) buckets.delete(id);
		const current = buckets.get(key);
		if (current) {
			if (current.count >= limit) return false;
			current.count++;
			return true;
		}
		if (buckets.size >= 10000) return false;
		buckets.set(key, { count: 1, until: now + windowMs });
		return true;
	}
	function principal(req) {
		if (anonymousTest) return "test:" + req.socket.remoteAddress;
		const authorization = req.headers.authorization;
		const cookie = req.headers.cookie
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("__Host-scramjet-turn-session="));
		const token = authorization?.startsWith("Bearer ")
			? authorization.slice(7)
			: cookie?.slice("__Host-scramjet-turn-session=".length);
		if (!token || token.length > 4096) return null;
		const parts = token.split(".");
		if (parts.length !== 2 || !equal(hmac(sessionSecret, parts[0]), parts[1]))
			return null;
		try {
			const payload = JSON.parse(
				Buffer.from(parts[0], "base64url").toString("utf8")
			);
			if (
				typeof payload.sub !== "string" ||
				!/^[A-Za-z0-9_.:@-]{1,128}$/.test(payload.sub) ||
				!Number.isSafeInteger(payload.exp) ||
				payload.exp <= Date.now() / 1000
			)
				return null;
			return payload.sub;
		} catch {
			return null;
		}
	}
	function json(res, status, body) {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(payload),
			"x-content-type-options": "nosniff",
		});
		res.end(payload);
	}
	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/healthz") {
			json(res, 200, { ok: true });
			return;
		}
		let url;
		try {
			url = new URL(req.url, "http://credential.local");
		} catch {
			json(res, 400, { error: "invalid URL" });
			return;
		}
		if (
			req.method !== "GET" ||
			url.pathname !== "/turn-credentials" ||
			url.search
		) {
			json(res, 404, { error: "not found" });
			return;
		}
		const origin = env.ALLOWED_ORIGIN;
		if (
			req.headers.origin &&
			origin &&
			req.headers.origin !== origin &&
			!(anonymousTest && origin === "*")
		) {
			json(res, 403, { error: "origin not allowed" });
			return;
		}
		if (origin && req.headers.origin) {
			res.setHeader("access-control-allow-origin", origin);
			res.setHeader("vary", "origin");
		}
		const user = principal(req);
		if (!user) {
			json(res, 401, { error: "authentication required" });
			return;
		}
		try {
			if (env.CREDENTIAL_REVOKED_USERS_FILE) {
				const revoked = JSON.parse(
					readFileSync(env.CREDENTIAL_REVOKED_USERS_FILE, "utf8")
				);
				if (
					!Array.isArray(revoked) ||
					revoked.some((value) => typeof value !== "string")
				)
					throw new Error("invalid revocation list");
				if (revoked.includes(user)) {
					json(res, 403, { error: "session revoked" });
					return;
				}
			}
			const now = Date.now();
			if (
				!allowed("ip:" + req.socket.remoteAddress, now) ||
				!allowed("user:" + user, now)
			) {
				res.setHeader("retry-after", String(Math.ceil(windowMs / 1000)));
				json(res, 429, { error: "credential issuance limit reached" });
				return;
			}
			const secret = readSecret();
			if (!secret || secret.length < 32) throw new Error("invalid TURN secret");
			const expiry = Math.floor(now / 1000) + ttl;
			const id = hmac(sessionSecret ?? secret, user).slice(0, 24);
			const username = `${expiry}:${id}`;
			const credential = crypto
				.createHmac("sha1", secret)
				.update(username)
				.digest("base64");
			json(res, 200, { urls, username, credential, ttl });
		} catch {
			json(res, 503, { error: "credential service unavailable" });
		}
	});
	server.headersTimeout = 5000;
	server.requestTimeout = 5000;
	server.maxHeadersCount = 30;
	return server;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const server = createCredentialServer();
		const port = Number(process.env.PORT ?? 8081);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("PORT is invalid");
		server.listen(port, process.env.LISTEN_HOST ?? "0.0.0.0", () =>
			console.log(`TURN credential service listening on :${port}`)
		);
		for (const signal of ["SIGTERM", "SIGINT"])
			process.on(signal, () => server.close(() => process.exit(0)));
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
