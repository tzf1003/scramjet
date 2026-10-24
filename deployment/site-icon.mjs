import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import ipaddr from "ipaddr.js";

// Serves the icon of a proxied target site without a login. The browser asks
// for icons outside the proxy runtime and often without cookies (bookmarks,
// home-screen shortcuts), so the gateway fetches them itself. It only returns
// image bytes found at the target's own public URLs; a site without an icon
// gets a 404 and nothing else is substituted.

export const SITE_ICON_PATH = "/__scramjet_icon";
export const ICON_PATHS = new Set([
	"/favicon.ico",
	"/apple-touch-icon.png",
	"/apple-touch-icon-precomposed.png",
]);

const MAX_ICON_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_DECLARED = 3;
const FETCH_TIMEOUT = 5000;
// Wall-clock budget for one lookup: page, redirects and every candidate.
const LOOKUP_DEADLINE = 10000;
const MAX_CONCURRENT = 16;
const CACHE_ENTRIES = 500;
const HIT_TTL = 3600_000;
const MISS_TTL = 300_000;
const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/svg+xml",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/ico",
]);

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reverse the demo's flattened label (`www-example-com`) into a hostname. */
export function expandLabel(value) {
	if (value.length > 63 || value.includes(".")) return null;
	// A numeric suffix is a port; icons are only fetched from the default one.
	if (/[^-]-[0-9]+$/.test(value)) return null;
	const host = value.replace(/--|-/g, (separator) =>
		separator === "--" ? "-" : "."
	);
	return validTarget(host) &&
		value === host.replace(/-/g, "--").replace(/\./g, "-")
		? host
		: null;
}

export function validTarget(host, proxyDomain) {
	if (typeof host !== "string" || host.length > 253) return false;
	const parts = host.split(".");
	if (parts.length < 2 || !parts.every((part) => label.test(part)))
		return false;
	// Numeric TLDs are IP literals, and proxy hosts would loop back to us.
	if (/^[0-9]+$/.test(parts.at(-1))) return false;
	if (/(?:^|\.)localhost$/.test(host)) return false;
	if (proxyDomain && (host === proxyDomain || host.endsWith("." + proxyDomain)))
		return false;
	return true;
}

/** Hostname whose icon a request asks for, or null when it is not a target. */
export function iconTarget(url, hostname, { proxyDomain, reserved }) {
	if (url.pathname === SITE_ICON_PATH) {
		const host = (url.searchParams.get("host") || "").toLowerCase();
		return validTarget(host, proxyDomain) ? host : null;
	}
	if (!ICON_PATHS.has(url.pathname)) return null;
	if (reserved.includes(hostname) || !hostname.endsWith("." + proxyDomain))
		return null;
	const host = expandLabel(hostname.slice(0, -proxyDomain.length - 1));
	return host && validTarget(host, proxyDomain) ? host : null;
}

function attributes(tag) {
	const result = {};
	for (const match of tag.matchAll(
		/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
	))
		result[match[1].toLowerCase()] ??= match[2] ?? match[3] ?? match[4] ?? "";
	return result;
}

function sizeOf(sizes) {
	if (!sizes) return 32;
	if (sizes.toLowerCase() === "any") return 64;
	const found = [...sizes.matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1]));
	return found.length ? Math.max(...found) : 32;
}

/** Icon URLs the page declares, best first, for the requested kind. */
export function declaredIcons(html, base, apple) {
	const found = [];
	for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
		const attrs = attributes(tag);
		const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
		const isApple = rels.some((rel) =>
			["apple-touch-icon", "apple-touch-icon-precomposed"].includes(rel)
		);
		const isIcon = rels.includes("icon");
		if (!attrs.href || (apple ? !isApple : !isIcon)) continue;
		let href;
		try {
			href = new URL(attrs.href.trim(), base);
		} catch {
			continue;
		}
		if (href.protocol !== "https:") continue;
		const target = apple ? 180 : 64;
		found.push({
			href: href.href,
			distance: Math.abs(sizeOf(attrs.sizes) - target),
			order: found.length,
		});
	}
	return found
		.sort((a, b) => a.distance - b.distance || a.order - b.order)
		.map((entry) => entry.href);
}

// Connect to the address that was checked, so a later DNS answer cannot
// redirect the request to a private host.
function safeLookup(hostname, options, callback) {
	dnsLookup(hostname, { family: 4 }, (error, address) => {
		if (error) return callback(error);
		try {
			if (ipaddr.process(address).range() !== "unicast")
				throw new Error("Destination denied");
		} catch (denied) {
			return callback(denied);
		}
		if (options?.all) callback(null, [{ address, family: 4 }]);
		else callback(null, address, 4);
	});
}

function get(url, limit, accept, deadline, redirects = MAX_REDIRECTS) {
	let timer;
	return new Promise((resolve, reject) => {
		let target;
		try {
			target = new URL(url);
		} catch {
			return reject(new Error("bad url"));
		}
		if (
			target.protocol !== "https:" ||
			target.username ||
			target.password ||
			(target.port && target.port !== "443") ||
			!validTarget(target.hostname)
		)
			return reject(new Error("denied"));
		const remaining = deadline - Date.now();
		if (remaining <= 0) return reject(new Error("timeout"));
		const request = https.get(
			target,
			{
				lookup: safeLookup,
				timeout: Math.min(FETCH_TIMEOUT, remaining),
				headers: {
					accept,
					"accept-encoding": "identity",
					"user-agent": "Mozilla/5.0 (compatible; SiteIconFetcher)",
				},
			},
			(response) => {
				const status = response.statusCode || 0;
				if ([301, 302, 303, 307, 308].includes(status)) {
					response.resume();
					if (!response.headers.location || redirects <= 0)
						return reject(new Error("redirect"));
					return resolve(
						get(
							new URL(response.headers.location, target).href,
							limit,
							accept,
							deadline,
							redirects - 1
						)
					);
				}
				if (status !== 200) {
					response.resume();
					return reject(new Error("status"));
				}
				const length = Number(response.headers["content-length"]);
				if (length > limit) {
					response.destroy();
					return reject(new Error("too large"));
				}
				const chunks = [];
				let size = 0;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > limit) {
						response.destroy();
						return reject(new Error("too large"));
					}
					chunks.push(chunk);
				});
				response.on("end", () =>
					resolve({
						url: target.href,
						type: String(response.headers["content-type"] || "")
							.split(";")[0]
							.trim()
							.toLowerCase(),
						body: Buffer.concat(chunks),
					})
				);
				response.on("error", reject);
				response.on("close", () => reject(new Error("aborted")));
			}
		);
		// The socket timeout only covers inactivity, so a trickling response
		// needs this hard stop.
		timer = setTimeout(() => request.destroy(new Error("timeout")), remaining);
		request.on("timeout", () => request.destroy(new Error("timeout")));
		request.on("error", reject);
	}).finally(() => clearTimeout(timer));
}

function sniff(body) {
	if (body.length < 4) return null;
	if (body.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
	if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
	if (body.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
	if (
		body.subarray(0, 4).toString("latin1") === "RIFF" &&
		body.subarray(8, 12).toString("latin1") === "WEBP"
	)
		return "image/webp";
	if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0)
		return "image/x-icon";
	return null;
}

async function fetchIcon(url, deadline) {
	const { body, type } = await get(
		url,
		MAX_ICON_BYTES,
		"image/*,*/*;q=0.5",
		deadline
	);
	if (!body.length) throw new Error("empty");
	// Servers often label a favicon text/plain or octet-stream, so trust the
	// bytes. Anything that is neither a known image type nor an image fails.
	const kind = sniff(body) || (IMAGE_TYPES.has(type) ? type : null);
	if (!kind) throw new Error("not an image");
	if (
		kind === "image/svg+xml" &&
		!/<svg[\s>]/i.test(body.toString("utf8", 0, 2048))
	)
		throw new Error("not an image");
	return { type: kind, body };
}

async function discover(host, apple) {
	const deadline = Date.now() + LOOKUP_DEADLINE;
	const candidates = [];
	try {
		const page = await get(
			`https://${host}/`,
			MAX_HTML_BYTES,
			"text/html,application/xhtml+xml",
			deadline
		);
		if (/html/.test(page.type) || !page.type)
			candidates.push(
				...declaredIcons(page.body.toString("utf8"), page.url, apple).slice(
					0,
					MAX_DECLARED
				)
			);
	} catch {
		// A site that blocks the page request can still serve its icon file.
	}
	if (apple)
		candidates.push(
			`https://${host}/apple-touch-icon.png`,
			`https://${host}/apple-touch-icon-precomposed.png`
		);
	else candidates.push(`https://${host}/favicon.ico`);
	// The conventional paths follow the declared ones, so the declared cap
	// never crowds them out.
	for (const candidate of new Set(candidates)) {
		try {
			return await fetchIcon(candidate, deadline);
		} catch {
			// Try the next declared location.
		}
	}
	return null;
}

export function createSiteIcons({ proxyDomain, reserved, rateLimit = 60 }) {
	const cache = new Map();
	const pending = new Map();
	const buckets = new Map();
	let active = 0;
	const options = { proxyDomain, reserved };

	function remember(key, value, ttl) {
		cache.delete(key);
		cache.set(key, { value, until: Date.now() + ttl });
		if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
	}

	function allowed(client) {
		const now = Date.now();
		for (const [key, bucket] of buckets)
			if (now > bucket.until) buckets.delete(key);
		const bucket = buckets.get(client) || { count: 0, until: now + 600_000 };
		buckets.set(client, bucket);
		return ++bucket.count <= rateLimit && buckets.size <= 10000;
	}

	async function resolve(host, apple, client) {
		const key = (apple ? "apple:" : "icon:") + host;
		const hit = cache.get(key);
		if (hit && hit.until > Date.now()) return hit.value;
		if (pending.has(key)) return pending.get(key);
		if (!allowed(client) || active >= MAX_CONCURRENT) return undefined;
		active++;
		const work = discover(host, apple)
			.catch(() => null)
			.then((icon) => {
				remember(key, icon, icon ? HIT_TTL : MISS_TTL);
				return icon;
			})
			.finally(() => {
				active--;
				pending.delete(key);
			});
		pending.set(key, work);
		return work;
	}

	/** Answers an icon request, or returns false when the request is not one. */
	return async function handle(req, res, url, hostname, client) {
		if (req.method !== "GET" && req.method !== "HEAD") return false;
		const host = iconTarget(url, hostname, options);
		if (!host) return false;
		const apple =
			url.pathname.startsWith("/apple-touch-icon") ||
			url.searchParams.get("kind") === "apple";
		const icon = await resolve(host, apple, client);
		if (icon === undefined) {
			res.writeHead(429, { "cache-control": "no-store" });
			res.end();
			return true;
		}
		if (!icon) {
			res.writeHead(404, {
				"cache-control": `public, max-age=${MISS_TTL / 1000}`,
			});
			res.end();
			return true;
		}
		res.writeHead(200, {
			"content-type": icon.type,
			"content-length": icon.body.length,
			"cache-control": `public, max-age=${HIT_TTL / 1000}, stale-while-revalidate=86400`,
			"content-security-policy": "default-src 'none'; sandbox",
		});
		res.end(req.method === "HEAD" ? undefined : icon.body);
		return true;
	};
}
