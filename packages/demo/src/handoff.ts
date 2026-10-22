import { HANDOFF_PATH, proxyUrl, resolveTarget } from "./routing.ts";
import { getDomain } from "tldts";

const STORAGE_KEY = "__scramjet_navigation";
const MESSAGE = "scramjet-navigation";
const MAX_AGE = 30_000;
const MAX_BYTES = 512_000;

type Cookie = {
	domain: string;
	name: string;
	value: string;
	path: string;
	hostOnly?: boolean;
	[key: string]: unknown;
};

export type NavigationState = {
	source: string;
	target: string;
	cookies: string;
	referrer: string;
	referrerPolicy?: string;
	initiator: string;
	crossSiteRedirect: boolean;
	fetchSite?: "same-origin" | "same-site" | "cross-site";
	createdAt: number;
};

/** Transfer only cookies belonging to the destination's domain scope. */
export function destinationCookies(serialized: string, target: URL): string {
	const cookies: Record<string, Cookie> = JSON.parse(serialized);
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(cookies).filter(([id, cookie]) => {
				if (
					!cookie ||
					typeof cookie.domain !== "string" ||
					!cookie.domain.startsWith(".") ||
					typeof cookie.name !== "string" ||
					typeof cookie.value !== "string" ||
					typeof cookie.path !== "string" ||
					!cookie.path.startsWith("/") ||
					id !== `${cookie.domain}@${cookie.path}@${cookie.name}`
				)
					return false;
				for (const key of ["hostOnly", "secure", "httpOnly"]) {
					if (cookie[key] !== undefined && typeof cookie[key] !== "boolean")
						return false;
				}
				for (const key of ["expires", "maxAge"]) {
					if (
						cookie[key] !== undefined &&
						(typeof cookie[key] !== "number" || !Number.isFinite(cookie[key]))
					)
						return false;
				}
				if (
					cookie.sameSite !== undefined &&
					typeof cookie.sameSite !== "string"
				)
					return false;
				const domain = cookie.domain.replace(/^\./, "").toLowerCase();
				// Domain cookies may never span an ICANN or private public suffix.
				if (!getDomain(domain, { allowPrivateDomains: true })) return false;
				return (
					target.hostname === domain ||
					(!cookie.hostOnly && target.hostname.endsWith(`.${domain}`))
				);
			})
		)
	);
}

/** Security metadata is bounded by the logical origin authenticated by postMessage. */
function verifiedNavigation(
	state: NavigationState,
	base: string
): NavigationState {
	const source = resolveTarget(new URL(state.source), base);
	const target = new URL(state.target);
	const site = (url: URL) =>
		`${url.protocol}//${getDomain(url.hostname, { allowPrivateDomains: true }) || url.hostname}`;
	const observed =
		source.origin === target.origin
			? "same-origin"
			: site(source) === site(target)
				? "same-site"
				: "cross-site";
	let referrer = state.referrer;
	if (referrer) {
		const supplied = new URL(referrer);
		if (
			supplied.origin !== source.origin ||
			supplied.username ||
			supplied.password
		)
			referrer = source.origin + "/";
	}
	return {
		...state,
		referrer,
		initiator: source.origin,
		// A sender can preserve a more restrictive redirect context only.
		fetchSite:
			state.fetchSite === "cross-site" || observed === "cross-site"
				? "cross-site"
				: state.fetchSite === "same-site" || observed === "same-site"
					? "same-site"
					: "same-origin",
		crossSiteRedirect: state.crossSiteRedirect || observed === "cross-site",
	};
}

export function transferableCookies(
	serialized: string,
	source: URL,
	target: URL
): string {
	return destinationCookies(destinationCookies(serialized, source), target);
}

export function isProxyPeer(origin: string, entry: URL, base: string): boolean {
	try {
		const peer = new URL(origin);
		if (
			peer.origin !== origin ||
			peer.protocol !== entry.protocol ||
			peer.port !== entry.port
		)
			return false;
		resolveTarget(peer, base);
		return true;
	} catch {
		return false;
	}
}

function validState(
	value: unknown,
	entry: URL,
	base: string
): value is NavigationState {
	if (!value || typeof value !== "object") return false;
	const state = value as NavigationState;
	if (
		typeof state.source !== "string" ||
		!isProxyPeer(state.source, entry, base) ||
		typeof state.target !== "string" ||
		typeof state.cookies !== "string" ||
		typeof state.referrer !== "string" ||
		typeof state.initiator !== "string" ||
		typeof state.createdAt !== "number" ||
		!Number.isFinite(state.createdAt) ||
		Math.abs(Date.now() - state.createdAt) > MAX_AGE ||
		state.cookies.length > MAX_BYTES ||
		typeof state.crossSiteRedirect !== "boolean" ||
		(state.referrerPolicy !== undefined &&
			typeof state.referrerPolicy !== "string") ||
		(state.fetchSite !== undefined &&
			!["same-origin", "same-site", "cross-site"].includes(state.fetchSite))
	)
		return false;
	try {
		const target = new URL(state.target);
		const canonical = proxyUrl(target, entry, base);
		if (
			target.protocol !== "https:" ||
			canonical.searchParams.has("__scramjet_url") ||
			canonical.origin !== entry.origin
		)
			return false;
		if (
			state.referrer &&
			!["http:", "https:"].includes(new URL(state.referrer).protocol)
		)
			return false;
		const initiator = new URL(state.initiator);
		if (
			initiator.origin !== state.initiator ||
			!["http:", "https:"].includes(initiator.protocol)
		)
			return false;
		const source = resolveTarget(new URL(state.source), base);
		return transferableCookies(state.cookies, source, target) === state.cookies;
	} catch {
		return false;
	}
}

/** A hidden shell on the destination stores a one-use state in this tab's session. */
export function receiveHandoff(entry: URL, base: string): boolean {
	if (entry.pathname !== HANDOFF_PATH) return false;
	const token = entry.searchParams.get("token");
	if (window.parent === window || !token || !/^[a-f0-9]{32}$/.test(token)) {
		throw new Error("Invalid proxy navigation handoff.");
	}
	const receive = (event: MessageEvent) => {
		if (
			event.source !== window.parent ||
			!isProxyPeer(event.origin, entry, base) ||
			event.data?.type !== MESSAGE ||
			event.data.token !== token
		)
			return;
		if (event.data.action === "probe") {
			window.parent.postMessage(
				{ type: MESSAGE, token, action: "ready" },
				event.origin
			);
		} else if (
			event.data.action === "store" &&
			event.data.state?.source === event.origin &&
			validState(event.data.state, entry, base)
		) {
			try {
				sessionStorage.setItem(
					STORAGE_KEY,
					JSON.stringify(verifiedNavigation(event.data.state, base))
				);
				window.parent.postMessage(
					{ type: MESSAGE, token, action: "stored" },
					event.origin
				);
				window.removeEventListener("message", receive);
			} catch {
				window.parent.postMessage(
					{ type: MESSAGE, token, action: "failed" },
					event.origin
				);
			}
		}
	};
	window.addEventListener("message", receive);
	return true;
}

export function consumeHandoff(
	entry: URL,
	base: string
): NavigationState | undefined {
	try {
		const serialized = sessionStorage.getItem(STORAGE_KEY);
		sessionStorage.removeItem(STORAGE_KEY);
		if (!serialized) return;
		const state: unknown = JSON.parse(serialized);
		if (
			validState(state, entry, base) &&
			state.target === resolveTarget(entry, base).href
		)
			return verifiedNavigation(state, base);
	} catch {
		// Storage can be disabled; navigation keeps its original controller in that case.
	}
}

export function prepareHandoff(
	destination: URL,
	state: NavigationState,
	signal?: AbortSignal
): Promise<boolean> {
	return new Promise((resolve) => {
		const token = Array.from(
			crypto.getRandomValues(new Uint8Array(16)),
			(byte) => byte.toString(16).padStart(2, "0")
		).join("");
		const bridge = new URL(HANDOFF_PATH, destination);
		bridge.searchParams.set("token", token);
		const iframe = document.createElement("iframe");
		iframe.hidden = true;
		iframe.setAttribute("aria-hidden", "true");
		iframe.referrerPolicy = "no-referrer";
		let finished = false;
		const finish = (success: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			clearInterval(probe);
			window.removeEventListener("message", receive);
			signal?.removeEventListener("abort", abort);
			iframe.remove();
			resolve(success);
		};
		const abort = () => finish(false);
		const receive = (event: MessageEvent) => {
			if (
				event.source !== iframe.contentWindow ||
				event.origin !== destination.origin ||
				event.data?.type !== MESSAGE ||
				event.data.token !== token
			)
				return;
			if (event.data.action === "ready") {
				iframe.contentWindow?.postMessage(
					{ type: MESSAGE, token, action: "store", state },
					destination.origin
				);
			} else if (event.data.action === "stored") finish(true);
			else if (event.data.action === "failed") finish(false);
		};
		const probe = setInterval(
			() =>
				iframe.contentWindow?.postMessage(
					{ type: MESSAGE, token, action: "probe" },
					destination.origin
				),
			100
		);
		const timeout = setTimeout(() => finish(false), 5_000);
		window.addEventListener("message", receive);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			finish(false);
			return;
		}
		iframe.addEventListener("error", () => finish(false), { once: true });
		iframe.src = bridge.href;
		document.body.append(iframe);
	});
}
