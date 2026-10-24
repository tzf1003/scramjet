export const DEFAULT_PROXY_DOMAIN = "xs2api.com";
export const DEFAULT_GATEWAY_HOST = "my.xs2api.com";
export const TARGET_QUERY = "__scramjet_url";
export const HANDOFF_PATH = "/__scramjet_handoff";
export const SITE_ICON_PATH = "/__scramjet_icon";
export const PROXY_RESOURCE_PATH =
	/^(?:\/(?:scramjet|controller|src|assets|node_modules|@vite|@id|@fs|wisp)(?:\/|$)|\/(?:sw\.js|__scramjet_handoff|__scramjet_icon)$)/;

export function normalizeProxyDomain(value: string): string {
	const domain = value
		.trim()
		.toLowerCase()
		.replace(/^\*\./, "")
		.replace(/\.$/, "");
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

export function isGatewayEntry(
	entry: URL,
	base: string,
	gatewayHost: string
): boolean {
	return [
		normalizeProxyDomain(base),
		normalizeProxyDomain(gatewayHost),
	].includes(entry.hostname);
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
		throw new TypeError(
			"Use one flattened target label under the proxy domain."
		);
	}
	const hostname = normalizeProxyDomain(
		label.replace(/--|-/g, (separator) => (separator === "--" ? "-" : "."))
	);
	if (flattenHostname(hostname) !== label) {
		throw new TypeError("Invalid flattened target hostname.");
	}
	return hostname;
}

function targetLabel(target: URL): string {
	// Numeric labels are reserved for port suffixes; IP literals use explicit URLs.
	if (/^[\d.]+$/.test(target.hostname) || target.hostname.includes(":"))
		return "";
	return (
		flattenHostname(target.hostname) + (target.port ? `-${target.port}` : "")
	);
}

function expandTarget(label: string): URL {
	if (label.length > 63 || label.includes(".")) {
		throw new TypeError(
			"Use one flattened target label under the proxy domain."
		);
	}
	const match = /^(.*[^-])-([0-9]+)$/.exec(label);
	const host = expandHostname(match ? match[1] : label);
	const target = new URL(`https://${host}`);
	if (match) {
		const port = Number(match[2]);
		if (port < 1 || port > 65535 || String(port) !== match[2]) {
			throw new TypeError("Target port must be between 1 and 65535.");
		}
		target.port = match[2];
	}
	// Reject ambiguous numeric hosts and browser hostname canonicalizations.
	if (
		targetLabel(target) !== label &&
		!(match?.[2] === "443" && targetLabel(target) === match[1])
	) {
		throw new TypeError("Invalid flattened target hostname or port.");
	}
	return target;
}

/** Resolve a public entry URL while preserving the target's path, query and hash. */
export function resolveTarget(entry: URL, proxyDomain: string): URL {
	const base = normalizeProxyDomain(proxyDomain);
	const hostname = entry.hostname.toLowerCase().replace(/\.$/, "");
	const suffix = `.${base}`;
	if (!hostname.endsWith(suffix)) {
		throw new TypeError(`Open a target hostname under .${base}.`);
	}
	const target = expandTarget(hostname.slice(0, -suffix.length));
	const explicitTarget = entry.searchParams.get(TARGET_QUERY);
	if (explicitTarget !== null) return httpTarget(explicitTarget);

	// Assign separately: a path beginning with // must remain a path.
	target.pathname = entry.pathname;
	target.search = entry.search;
	target.hash = entry.hash;
	return target;
}

/** HTTPS hosts and ports use a wildcard label; special URLs use an explicit target. */
export function proxyUrl(target: URL, entry: URL, proxyDomain: string): URL {
	httpTarget(target.href);
	const base = normalizeProxyDomain(proxyDomain);
	const result = new URL(entry.origin);
	let label = "";
	try {
		label = targetLabel(target);
	} catch {
		// URL hosts outside DNS label syntax use the explicit target parameter.
	}
	if (
		target.protocol === "https:" &&
		label.length > 0 &&
		label.length <= 63 &&
		// Browsers interpret this prefix as Punycode rather than an encoded label.
		!label.startsWith("xn--") &&
		!PROXY_RESOURCE_PATH.test(target.pathname) &&
		!target.searchParams.has(TARGET_QUERY) &&
		`${label}.${base}`.length <= 253
	) {
		result.hostname = `${label}.${base}`;
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
