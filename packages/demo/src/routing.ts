export const DEFAULT_PROXY_DOMAIN = "derp.xs2api.com";
export const TARGET_QUERY = "__scramjet_url";
export const PROXY_RESOURCE_PATH =
	/^(?:\/(?:scramjet|controller|src|assets|node_modules|@vite|@id|@fs|wisp)(?:\/|$)|\/(?:sw\.js|icon\.png)$)/;

export function normalizeProxyDomain(value: string): string {
	const domain = value.trim().toLowerCase().replace(/\.$/, "");
	if (
		!domain ||
		domain.length > 253 ||
		!domain
			.split(".")
			.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		throw new TypeError("Proxy domain must be a hostname.");
	}
	return domain;
}

function httpTarget(value: string): URL {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new TypeError("Target must be an HTTP(S) URL without credentials.");
	}
	return url;
}

/** Escape literal hyphens before flattening domain separators. */
function flattenHostname(hostname: string): string {
	return normalizeProxyDomain(hostname).replace(/-/g, "--").replace(/\./g, "-");
}

function expandHostname(label: string): string {
	if (label.includes(".") || label.length > 63) {
		throw new TypeError("Use one flattened target label under the proxy domain.");
	}
	const hostname = normalizeProxyDomain(
		label.replace(/--|-/g, (separator) => (separator === "--" ? "-" : "."))
	);
	if (flattenHostname(hostname) !== label) {
		throw new TypeError("Invalid flattened target hostname.");
	}
	return hostname;
}

/** Resolve a public entry URL while preserving the target's path, query and hash. */
export function resolveTarget(entry: URL, proxyDomain: string): URL {
	const base = normalizeProxyDomain(proxyDomain);
	const hostname = entry.hostname.toLowerCase().replace(/\.$/, "");
	const suffix = `.${base}`;
	if (!hostname.endsWith(suffix)) {
		throw new TypeError(`Open a target hostname under .${base}.`);
	}
	const targetHost = expandHostname(hostname.slice(0, -suffix.length));
	const explicitTarget = entry.searchParams.get(TARGET_QUERY);
	if (explicitTarget !== null) return httpTarget(explicitTarget);

	const target = new URL(`https://${targetHost}`);
	// Assign separately: a path beginning with // must remain a path.
	target.pathname = entry.pathname;
	target.search = entry.search;
	target.hash = entry.hash;
	return target;
}

/** New tabs use a wildcard hostname; HTTP and custom ports use an explicit target. */
export function proxyUrl(target: URL, entry: URL, proxyDomain: string): URL {
	httpTarget(target.href);
	const base = normalizeProxyDomain(proxyDomain);
	const result = new URL(entry.origin);
	const targetLabel = target.hostname.includes(":")
		? ""
		: flattenHostname(target.hostname);
	if (
		target.protocol === "https:" &&
		!target.port &&
		targetLabel.length > 0 &&
		targetLabel.length <= 63 &&
		// Browsers interpret this prefix as Punycode rather than an encoded label.
		!targetLabel.startsWith("xn--") &&
		!PROXY_RESOURCE_PATH.test(target.pathname) &&
		!target.searchParams.has(TARGET_QUERY) &&
		`${targetLabel}.${base}`.length <= 253
	) {
		result.hostname = `${targetLabel}.${base}`;
		result.pathname = target.pathname;
		result.search = target.search;
		result.hash = target.hash;
	} else {
		result.searchParams.set(TARGET_QUERY, target.href);
	}
	return result;
}

/** Keep the controller alive during cross-site navigation, including POSTs. */
export function shellUrl(target: URL, entry: URL, proxyDomain: string): URL {
	const result = proxyUrl(target, entry, proxyDomain);
	if (result.origin === entry.origin) return result;
	const fallback = new URL(entry.origin);
	fallback.searchParams.set(TARGET_QUERY, target.href);
	return fallback;
}
