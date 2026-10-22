import crypto from "node:crypto";

export const ACCESS_COOKIE = "__Host-scramjet-access-key";
export const LEGACY_COOKIE = "__Host-scramjet-turn-session";
export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function createAccessControl(accessKey) {
	if (
		typeof accessKey !== "string" ||
		accessKey.length < 24 ||
		accessKey.length > 512
	) {
		throw new Error("Access key must contain 24 to 512 characters");
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
	function authenticated(req) {
		const cookies = (req.headers.cookie || "")
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part.startsWith(ACCESS_COOKIE + "="));
		if (cookies.length !== 1) return false;
		try {
			return valid(
				decodeURIComponent(cookies[0].slice(ACCESS_COOKIE.length + 1))
			);
		} catch {
			return false;
		}
	}
	const attributes = "; Path=/; Secure; HttpOnly; SameSite=Strict";
	function cookie() {
		return `${ACCESS_COOKIE}=${encodeURIComponent(accessKey)}${attributes}; Max-Age=${COOKIE_MAX_AGE}`;
	}
	function clearCookies() {
		return [ACCESS_COOKIE, LEGACY_COOKIE].map(
			(name) => `${name}=${attributes}; Max-Age=0`
		);
	}
	return { valid, authenticated, cookie, clearCookies };
}
