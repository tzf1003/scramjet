#!/usr/bin/env node
/**
 * Minimal coturn REST credential service.
 *
 * coturn's `use-auth-secret` mode expects:
 *   username   = "<unix-expiry>:<opaque-id>"
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * The shared secret never reaches the browser. Run this on the same origin as
 * Scramjet (reverse proxy /turn-credentials) so the credential fetch needs no CORS.
 */
import http from "node:http";
import crypto from "node:crypto";

const secret = process.env.TURN_STATIC_AUTH_SECRET;
if (!secret) {
	console.error("TURN_STATIC_AUTH_SECRET is required");
	process.exit(1);
}

const port = Number(process.env.PORT ?? 8081);
const ttl = Number(process.env.TURN_TTL ?? 3600);
const urls = (process.env.TURN_URLS ?? "")
	.split(",")
	.map((url) => url.trim())
	.filter(Boolean);
if (urls.length === 0) {
	console.error("TURN_URLS is required (comma-separated turn:/turns: URLs)");
	process.exit(1);
}
if (!Number.isFinite(ttl) || ttl <= 0) {
	console.error("TURN_TTL must be a positive number of seconds");
	process.exit(1);
}
if (urls.some((url) => !/^turns?:/i.test(url))) {
	console.error("TURN_URLS may contain only turn:/turns: URLs");
	process.exit(1);
}

const allowedOrigin = process.env.ALLOWED_ORIGIN;

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/healthz") {
		json(res, 200, { ok: true });
		return;
	}
	if (req.method !== "GET" || !req.url?.startsWith("/turn-credentials")) {
		json(res, 404, { error: "not found" });
		return;
	}
	if (allowedOrigin) {
		res.setHeader(
			"access-control-allow-origin",
			allowedOrigin === "*" ? "*" : allowedOrigin
		);
		res.setHeader("vary", "origin");
		if (allowedOrigin !== "*" && req.headers.origin !== allowedOrigin) {
			json(res, 403, { error: "origin not allowed" });
			return;
		}
	}

	const expiry = Math.floor(Date.now() / 1000) + ttl;
	const id = crypto.randomBytes(9).toString("base64url");
	const username = `${expiry}:${id}`;
	const credential = crypto
		.createHmac("sha1", secret)
		.update(username)
		.digest("base64");

	res.setHeader("cache-control", "no-store");
	json(res, 200, { urls, username, credential, ttl });
});

server.listen(port, () => {
	console.log(`TURN credential service listening on :${port}`);
});

function shutdown() {
	server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
