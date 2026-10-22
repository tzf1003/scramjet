import crypto from "node:crypto";

export const ACCESS_COOKIE = "__Secure-scramjet-access-key";
export const HOST_ACCESS_COOKIE = "__Host-scramjet-access-key";
export const LOGOUT_COOKIE = "__Secure-scramjet-logged-out";
export const LEGACY_COOKIE = "__Host-scramjet-turn-session";
export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * `domain` is the proxy domain. Shared mode (the default when it is set) issues
 * one cookie covering that domain and every subdomain, so a key entered on any
 * mapped host authenticates all of them; `shared: false` keeps host-only
 * cookies and expires any domain cookie left by a shared deployment.
 */
export function createAccessControl(
	accessKey,
	{ domain, shared = Boolean(domain) } = {}
) {
	if (
		typeof accessKey !== "string" ||
		accessKey.length < 8 ||
		accessKey.length > 512
	) {
		throw new Error("Access key must contain 8 to 512 characters");
	}
	const expected = crypto.createHash("sha256").update(accessKey).digest();
	function valid(candidate) {
		return (
			typeof candidate === "string" &&
			candidate.length <= 512 &&
			crypto.timingSafeEqual(
				expected,
				crypto.createHash("sha256").update(candidate).digest()
			)
		);
	}
	const name = shared ? ACCESS_COOKIE : HOST_ACCESS_COOKIE;
	// Host-only cookies issued before shared access stay valid until renewed.
	const accepted = shared ? [ACCESS_COOKIE, HOST_ACCESS_COOKIE] : [name];
	function authenticated(req) {
		const parts = (req.headers.cookie || "").split(";").map((p) => p.trim());
		return accepted.some((cookieName) => {
			const cookies = parts.filter((part) => part.startsWith(cookieName + "="));
			if (cookies.length !== 1) return false;
			try {
				return valid(
					decodeURIComponent(cookies[0].slice(cookieName.length + 1))
				);
			} catch {
				return false;
			}
		});
	}
	const attributes = "; Path=/; Secure; HttpOnly; SameSite=Strict";
	const scope = domain ? `; Domain=${domain}` : "";
	const expire = (cookieName, extra = attributes) =>
		`${cookieName}=${extra}; Max-Age=0`;
	// Readable by scripts and free of secrets: tells every origin not to
	// restore a saved key after an explicit logout.
	const markerAttributes = `; Path=/; Secure; SameSite=Strict${scope}`;
	/** Set-Cookie values issued on login and renewal. */
	function cookie() {
		const value = `${name}=${encodeURIComponent(accessKey)}${attributes}${shared ? scope : ""}; Max-Age=${COOKIE_MAX_AGE}`;
		if (shared)
			// Drop the old host-only cookie so it cannot shadow the shared one.
			return [
				value,
				expire(HOST_ACCESS_COOKIE),
				expire(LOGOUT_COOKIE, markerAttributes),
			];
		return domain
			? [value, expire(ACCESS_COOKIE, attributes + scope)]
			: [value];
	}
	function clearCookies() {
		const cleared = [HOST_ACCESS_COOKIE, LEGACY_COOKIE].map((cookieName) =>
			expire(cookieName)
		);
		if (domain) cleared.unshift(expire(ACCESS_COOKIE, attributes + scope));
		if (shared)
			cleared.push(
				`${LOGOUT_COOKIE}=1${markerAttributes}; Max-Age=${COOKIE_MAX_AGE}`
			);
		return cleared;
	}
	return { valid, authenticated, cookie, clearCookies, shared };
}
