// Keeps the browser tab's icon in step with the proxied site. The gateway
// serves the icon without a login, so the shell only needs to point at it.

import { SITE_ICON_PATH } from "./routing.ts";

const LINKS: Array<[string, string]> = [
	['link[rel="icon"]', "icon"],
	['link[rel="apple-touch-icon"]', "apple"],
];

export function siteIconHref(target: URL, kind: "icon" | "apple"): string {
	const url = new URL(SITE_ICON_PATH, "https://shell.invalid");
	url.searchParams.set("host", target.hostname);
	if (kind === "apple") url.searchParams.set("kind", "apple");
	return url.pathname + url.search;
}

export function syncSiteIcon(target: URL) {
	for (const [selector, kind] of LINKS) {
		const link = document.head.querySelector<HTMLLinkElement>(selector);
		if (!link) continue;
		const href = siteIconHref(target, kind === "apple" ? "apple" : "icon");
		if (link.getAttribute("href") !== href) link.setAttribute("href", href);
	}
}
