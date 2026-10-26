import { NativeURL } from "@/shared/snapshot";
import { isHtmlMimeType, ScramjetHeaders } from "@/shared";
import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchParsed } from ".";

/** Whether the response asks to be saved to disk rather than displayed. */
export function isAttachment(headers: { get(name: string): string | null }) {
	return /^\s*attachment\b/i.test(headers.get("content-disposition") ?? "");
}

export function normalizeContentType(
	parsed: ScramjetFetchParsed,
	headers: ScramjetHeaders
) {
	if (!isDocument(parsed)) return;

	const ct = headers.get("content-type");
	if (!ct) return;
	if (!isHtmlMimeType(ct)) return;
	// an attachment keeps its original bytes, so its charset still applies
	if (isAttachment(headers)) return;

	headers.set("content-type", "text/html; charset=utf-8");
}

export function isRedirect(response: BareResponse) {
	return response.status >= 300 && response.status < 400;
}

export function isDocument(parsed: ScramjetFetchParsed) {
	return parsed.destination === "document" || parsed.destination === "iframe";
}

export function createReferrerString(
	clientUrl: URL,
	resource: URL,
	policy: string | null
): string {
	policy ||= "strict-origin-when-cross-origin";
	const originIsHttps = clientUrl.protocol === "https:";
	const destIsHttps = resource.protocol === "https:";

	const isPotentialDowngrade = originIsHttps && !destIsHttps;

	const isSameOrigin =
		clientUrl.protocol === resource.protocol &&
		clientUrl.host === resource.host;

	const referrerOrigin = clientUrl.origin;

	const referrerUrl = new NativeURL(clientUrl.href);
	referrerUrl.hash = "";
	const referrerUrlString = referrerUrl.href;

	switch (policy) {
		case "no-referrer":
			return "";

		case "no-referrer-when-downgrade":
			if (isPotentialDowngrade) return "";
			return referrerUrlString;

		case "same-origin":
			if (isSameOrigin) return referrerUrlString;
			return "";

		case "origin":
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "strict-origin":
			if (isPotentialDowngrade) return "";
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "origin-when-cross-origin":
			if (isSameOrigin) return referrerUrlString;
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "strict-origin-when-cross-origin":
			if (isSameOrigin) return referrerUrlString;
			if (isPotentialDowngrade) return "";
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "unsafe-url":
			return referrerUrlString;

		default:
			return "";
	}
}
