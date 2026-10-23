import http from "node:http";
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import ipaddr from "ipaddr.js";
import {
	createCredentialServer,
	signCredentialSession,
} from "./credential-server.mjs";
import { createAccessControl, LEGACY_COOKIE } from "./access-key.mjs";
import { createClientIp } from "./client-ip.mjs";

const env = process.env;
const secret = env.CREDENTIAL_SESSION_SECRET;
if (!secret || secret.length < 32)
	throw new Error("Invalid deployment secrets");
const proxyDomain = (env.PROXY_DOMAIN || "")
	.trim()
	.toLowerCase()
	.replace(/^\*\./, "")
	.replace(/\.$/, "");
const gatewayHost = (env.GATEWAY_HOST || proxyDomain).trim().toLowerCase();
const validHostname = (hostname) =>
	hostname.length > 0 &&
	hostname.length <= 253 &&
	hostname
		.split(".")
		.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
if (
	!validHostname(proxyDomain) ||
	!validHostname(gatewayHost) ||
	(gatewayHost !== proxyDomain && !gatewayHost.endsWith("." + proxyDomain))
)
	throw new Error("Gateway host must belong to the configured proxy domain");
const accessScope = (env.ACCESS_COOKIE_SCOPE || "domain").trim().toLowerCase();
if (!["domain", "host"].includes(accessScope))
	throw new Error("ACCESS_COOKIE_SCOPE must be domain or host");
const access = createAccessControl(
	readFileSync(
		env.ACCESS_KEY_FILE || "/run/secrets/admin-password",
		"utf8"
	).trim(),
	{ domain: proxyDomain, shared: accessScope === "domain" }
);
function requestOrigin(req) {
	try {
		const url = new URL("https://" + req.headers.host);
		if (
			url.username ||
			url.password ||
			url.port ||
			url.host !== req.headers.host?.toLowerCase() ||
			(url.hostname !== proxyDomain &&
				!url.hostname.endsWith("." + proxyDomain))
		)
			return null;
		if (!validHostname(url.hostname)) return null;
		return url.origin;
	} catch {
		return null;
	}
}
const credentialServer = createCredentialServer(env);
const root = path.resolve(env.PUBLIC_ROOT || "public");
const attempts = new Map();
const peers = new Map();
const now = () => Math.floor(Date.now() / 1000);
// These routes are public before authentication and never issue credentials.
const publicAssets = new Set([
	"/login.js",
	"/access-key-client.js",
	"/access-session.js",
	"/style.css",
]);
function assetCacheControl(name) {
	if (publicAssets.has(name)) return "public, max-age=300, must-revalidate";
	if (
		/^\/(?:scramjet|controller|assets)\//.test(name) &&
		/\.(?:js|mjs|css|wasm|png|svg|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)$/.test(
			name
		)
	) {
		// Vite's content-addressed files can be reused without a round trip.
		if (/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/.]+$/.test(name))
			return "private, max-age=31536000, immutable";
		return "private, no-cache";
	}
	if (["/home.js", "/icon.png"].includes(name)) return "private, no-cache";
	return "no-store";
}
function json(res, code, value) {
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(value));
}
const ip = createClientIp(env.TRUSTED_PROXY_CIDRS);
async function serve(req, res, name) {
	const file = path.resolve(root, "." + name);
	if (!file.startsWith(root + path.sep))
		return json(res, 404, { error: "not found" });
	const metadata = await stat(file).catch(() => null);
	if (!metadata?.isFile()) return json(res, 404, { error: "not found" });
	const mime = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css",
		".json": "application/json",
		".wasm": "application/wasm",
		".svg": "image/svg+xml",
		".gz": "application/gzip",
		".txt": "text/plain; charset=utf-8",
	};
	const cacheControl = assetCacheControl(name);
	const headers = {
		"content-type": mime[path.extname(file)] || "application/octet-stream",
		"cache-control": cacheControl,
		"content-length": metadata.size,
	};
	if (cacheControl !== "no-store") {
		// Authentication already ran for private files. Cache only file bytes;
		// HTML and API requests continue renewing the access cookie.
		res.removeHeader("set-cookie");
		if (cacheControl.startsWith("private")) headers.vary = "Cookie";
		const identity = [
			env.SOURCE_COMMIT,
			name,
			metadata.size,
			metadata.mtimeMs,
			metadata.ctimeMs,
		];
		const etag = `W/"${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}"`;
		headers.etag = etag;
		const tags = req.headers["if-none-match"];
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			tags
				?.split(",")
				.some(
					(tag) =>
						tag.trim() === "*" ||
						tag.trim().replace(/^W\//, "") === etag.slice(2)
				)
		) {
			delete headers["content-length"];
			res.writeHead(304, headers);
			return res.end();
		}
	}
	res.writeHead(200, headers);
	if (req.method === "HEAD") return res.end();
	createReadStream(file).pipe(res);
}
Object.assign(wisp.options, {
	allow_private_ips: false,
	allow_loopback_ips: false,
	allow_udp_streams: false,
	port_whitelist: [80, 443],
	stream_limit_total: 128,
	parse_real_ip: false,
	hostname_blacklist: [/:/, /^localhost\.?$/i, /(?:^|\.)localhost\.?$/i],
	dns_method: async (hostname) => {
		const { address } = await lookup(hostname, { family: 4 });
		if (ipaddr.process(address).range() !== "unicast")
			throw new Error("Destination denied");
		return address;
	},
});
logging.set_level(logging.NONE);
const server = http.createServer(async (req, res) => {
	res.setHeader("x-content-type-options", "nosniff");
	try {
		if (req.method === "GET" && req.url === "/healthz")
			return json(res, 200, {
				ok: true,
				revision: env.SOURCE_COMMIT,
				mode: "relay",
			});
		const origin = requestOrigin(req);
		if (!origin) return json(res, 421, { error: "Invalid host" });
		if (req.url === "/api/login" && req.method === "POST") {
			if (req.headers.origin !== origin)
				return json(res, 403, { error: "请求来源无效" });
			const time = Date.now(),
				key = ip(req);
			for (const [k, v] of attempts) if (time > v.until) attempts.delete(k);
			const bucket = attempts.get(key) || { count: 0, until: time + 600000 };
			if (bucket.count >= 10 || attempts.size > 10000)
				return json(res, 429, { error: "尝试次数过多，请十分钟后重试" });
			bucket.count++;
			attempts.set(key, bucket);
			let data = "";
			for await (const chunk of req) {
				data += chunk;
				if (Buffer.byteLength(data) > 2048)
					return json(res, 413, { error: "请求过大" });
			}
			let input;
			try {
				input = JSON.parse(data);
			} catch {
				return json(res, 400, { error: "请求格式无效" });
			}
			if (!access.valid(input?.accessKey))
				return json(res, 401, { error: "访问密钥无效，请重新输入" });
			attempts.delete(key);
			res.setHeader("set-cookie", [
				...access.cookie(),
				access.cacheEpochCookie(),
				`${LEGACY_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
			]);
			return json(res, 200, { ok: true, expiresAt: null });
		}
		const pathname = new URL(req.url, origin).pathname;
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			(pathname === "/login" || publicAssets.has(pathname))
		)
			return serve(req, res, pathname === "/login" ? "/login.html" : pathname);
		if (req.method === "POST" && req.url === "/api/logout") {
			if (req.headers.origin !== origin)
				return json(res, 403, { error: "origin denied" });
			res.setHeader("set-cookie", [
				...access.clearCookies(),
				access.cacheEpochCookie(),
			]);
			// "cookies" would also drop the shared logout marker set above.
			res.setHeader(
				"clear-site-data",
				access.shared ? '"cache", "storage"' : '"cache", "cookies", "storage"'
			);
			return json(res, 200, { ok: true });
		}
		if (!access.authenticated(req)) {
			if (
				req.url.startsWith("/api/") ||
				req.url.startsWith("/turn-credentials")
			)
				return json(res, 401, { error: "访问密钥验证失败" });
			res.writeHead(302, {
				location: "/login?return=" + encodeURIComponent(req.url),
				"cache-control": "no-store",
			});
			return res.end();
		}
		res.setHeader("set-cookie", access.cookie());
		if (req.method === "GET" && req.url === "/api/config")
			return json(res, 200, {
				webrtc: {
					mode: "relay",
					iceServers: [],
					credentialEndpoint: "/turn-credentials",
					iceServersExpiresAt: null,
					credentialRefreshRatio: 0.8,
					failClosed: true,
					diagnostics: false,
					networkIsolationVerified: false,
				},
			});
		if (req.method === "GET" && req.url === "/api/session")
			return json(res, 200, {
				expiresAt: null,
				mode: "relay",
				revision: env.SOURCE_COMMIT,
			});
		if (req.url.startsWith("/turn-credentials")) {
			if (req.headers.origin && req.headers.origin !== origin)
				return json(res, 403, { error: "origin denied" });
			req.headers.authorization =
				"Bearer " + signCredentialSession("admin", secret, now() + 60);
			credentialServer.emit("request", req, res);
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD")
			return json(res, 405, { error: "method not allowed" });
		const url = new URL(req.url, origin);
		const name = decodeURIComponent(url.pathname);
		if (
			(url.hostname === proxyDomain || url.hostname === gatewayHost) &&
			!url.searchParams.has("__scramjet_url") &&
			!/^\/(?:scramjet|controller|assets)\//.test(name) &&
			![
				"/sw.js",
				"/icon.png",
				"/version.json",
				"/source.tar.gz",
				"/home.js",
			].includes(name)
		)
			return await serve(req, res, "/home.html");
		if (name === "/home.js") return await serve(req, res, name);
		// The handoff bridge only relays navigation state; skip the full shell.
		if (name === "/__scramjet_handoff")
			return await serve(req, res, "/handoff.html");
		if (
			name === "/source.tar.gz" ||
			name === "/version.json" ||
			name === "/icon.png" ||
			name === "/sw.js" ||
			/^\/(?:scramjet|controller|assets)\//.test(name)
		)
			return await serve(req, res, name);
		return await serve(req, res, "/index.html");
	} catch (err) {
		console.error("Request failed:", err.code || err.name);
		if (!res.headersSent) json(res, 500, { error: "server error" });
		else res.destroy();
	}
});
server.on("upgrade", (req, socket, head) => {
	const key = ip(req);
	const origin = requestOrigin(req);
	if (
		!origin ||
		req.url !== "/wisp/" ||
		req.headers.origin !== origin ||
		!access.authenticated(req)
	) {
		socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		return;
	}
	if ((peers.get(key) || 0) >= 12 || server._connections > 128) {
		socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
		return;
	}
	peers.set(key, (peers.get(key) || 0) + 1);
	socket.once("close", () => {
		const n = (peers.get(key) || 1) - 1;
		if (n) peers.set(key, n);
		else peers.delete(key);
	});
	wisp.routeRequest(req, socket, head);
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.listen(Number(env.PORT || 8080), env.LISTEN_HOST || "0.0.0.0", () =>
	console.log(
		"Scramjet ready: " + env.SOURCE_COMMIT + "; port=" + server.address().port
	)
);
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, () => {
		server.close();
		setTimeout(() => process.exit(0), 1000);
	});
