import crypto from "node:crypto";

export const ACCESS_COOKIE = "__Secure-scramjet-access-key";
export const HOST_ACCESS_COOKIE = "__Host-scramjet-access-key";
export const LEGACY_COOKIE = "__Host-scramjet-turn-session";
export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * With `domain`, one cookie covers that domain and every subdomain, so a key
 * entered on any mapped host authenticates all of them. Without it the cookie
 * stays host-only.
 */
export function createAccessControl(accessKey, { domain } = {}) {
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
	const name = domain ? ACCESS_COOKIE : HOST_ACCESS_COOKIE;
	// Host-only cookies issued before shared access stay valid until renewed.
	const accepted = domain ? [ACCESS_COOKIE, HOST_ACCESS_COOKIE] : [name];
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
	/** Set-Cookie values issued on login and renewal. */
	function cookie() {
		const value = `${name}=${encodeURIComponent(accessKey)}${attributes}${scope}; Max-Age=${COOKIE_MAX_AGE}`;
		// Drop the old host-only cookie so it cannot shadow the shared one.
		return domain
			? [value, `${HOST_ACCESS_COOKIE}=${attributes}; Max-Age=0`]
			: [value];
	}
	function clearCookies() {
		const cleared = [HOST_ACCESS_COOKIE, LEGACY_COOKIE].map(
			(cookieName) => `${cookieName}=${attributes}; Max-Age=0`
		);
		if (domain)
			cleared.unshift(`${ACCESS_COOKIE}=${attributes}${scope}; Max-Age=0`);
		return cleared;
	}
	return { valid, authenticated, cookie, clearCookies };
}
