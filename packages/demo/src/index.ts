import { loadEnvironment } from "./environment";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import {
	defaultConfigDev,
	rewriteUrl,
	ScramjetHeaders,
} from "@mercuryworkshop/scramjet";
import {
	Controller,
	ManagedPlugin,
} from "@mercuryworkshop/scramjet-controller";
import { CatchEscapedLinksPlugin } from "@mercuryworkshop/scramjet-utils";
import {
	DEFAULT_PROXY_DOMAIN,
	DEFAULT_GATEWAY_HOST,
	isGatewayEntry,
	normalizeProxyDomain,
	resolveTarget,
	proxyUrl,
	shellUrl,
} from "./routing";
import {
	consumeHandoff,
	transferableCookies,
	prepareHandoff,
	receiveHandoff,
} from "./handoff";
import { isBlankDocument, syncShellSurface } from "./chrome";
import { failLoading, finishLoading, setStage, showHost } from "./loading";

const app = document.getElementById("app")!;

async function registerWorker(): Promise<ServiceWorker> {
	if (!navigator.serviceWorker) {
		throw new Error("请通过 HTTPS 访问代理网页。");
	}
	await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	if (!navigator.serviceWorker.controller) {
		await new Promise<void>((resolve, reject) => {
			const onChange = () => {
				if (!navigator.serviceWorker.controller) return;
				clearTimeout(timer);
				navigator.serviceWorker.removeEventListener(
					"controllerchange",
					onChange
				);
				resolve();
			};
			const timer = setTimeout(() => {
				navigator.serviceWorker.removeEventListener(
					"controllerchange",
					onChange
				);
				reject(new Error("代理初始化超时，请刷新重试。"));
			}, 15000);
			navigator.serviceWorker.addEventListener("controllerchange", onChange);
			onChange();
		});
	}
	return navigator.serviceWorker.controller!;
}

async function main() {
	const entry = new URL(location.href);
	const base = normalizeProxyDomain(
		import.meta.env.VITE_PROXY_DOMAIN || DEFAULT_PROXY_DOMAIN
	);
	const gatewayAccess = import.meta.env.VITE_GATEWAY_ACCESS === "1";
	const gatewayHost =
		import.meta.env.VITE_GATEWAY_HOST ||
		(import.meta.env.VITE_PROXY_DOMAIN ? base : DEFAULT_GATEWAY_HOST);
	const gatewayEntry =
		gatewayAccess && isGatewayEntry(entry, base, gatewayHost);
	if (!gatewayEntry && receiveHandoff(entry, base)) return;
	const routingEntry = new URL(entry);
	if (gatewayEntry) routingEntry.hostname = "go." + base;
	const target = resolveTarget(routingEntry, base);
	const originTarget = gatewayEntry
		? null
		: resolveTarget(new URL(entry.origin), base);
	const handoff = gatewayEntry ? null : consumeHandoff(entry, base);
	document.title = target.hostname;
	showHost(target.hostname);
	setStage("正在初始化代理", 0.2);

	const serviceworker = await registerWorker();
	setStage("正在建立安全连接", 0.45);
	const wispUrl = new URL(import.meta.env.VITE_WISP_URL || "/wisp/", entry);
	if (wispUrl.protocol === "https:") wispUrl.protocol = "wss:";
	if (wispUrl.protocol === "http:") wispUrl.protocol = "ws:";
	if (!["ws:", "wss:"].includes(wispUrl.protocol)) {
		throw new Error("Wisp 地址必须使用 ws:// 或 wss://。");
	}
	let webrtc = defaultConfigDev.webrtc;
	if (gatewayAccess) {
		const configuration = await fetch("/api/config", {
			credentials: "same-origin",
		});
		if (!configuration.ok) {
			if (configuration.status === 401)
				location.replace(
					"/login?return=" +
						encodeURIComponent(entry.pathname + entry.search + entry.hash)
				);
			throw new Error("无法获取访问配置，请稍后重试。");
		}
		webrtc = (await configuration.json()).webrtc;
	}
	const controller = new Controller({
		serviceworker,
		transport: new LibcurlClient({ wisp: wispUrl.href }),
		scramjetConfig: {
			...defaultConfigDev,
			environment: loadEnvironment(),
			webrtc,
		},
	});
	await controller.wait();
	setStage("正在打开网页", 0.7);
	if (handoff) {
		controller.cookieJar.load(
			JSON.stringify({
				...JSON.parse(controller.cookieJar.dump()),
				...JSON.parse(handoff.cookies),
			})
		);
		await controller.persistCookies();
	}

	const iframe = document.createElement("iframe");
	iframe.title = target.hostname;
	iframe.allow =
		"fullscreen; autoplay; clipboard-read; clipboard-write; camera; microphone; display-capture";
	const syncAddress = (value: string) => {
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol)) return;
		const publicUrl = shellUrl(url, entry, base);
		if (location.href !== publicUrl.href) {
			history.replaceState(null, "", publicUrl);
		}
		document.title = url.hostname;
	};
	const syncSurface = syncShellSurface(iframe);
	const watcher = new ManagedPlugin("demo-navigation", []);
	const frame = controller.createFrame(iframe, {
		plugins: [
			watcher,
			new CatchEscapedLinksPlugin((url) =>
				gatewayEntry ? shellUrl(url, entry, base) : proxyUrl(url, entry, base)
			),
		],
	});
	let currentTarget = target;
	let navigation = 0;
	let handoffAbort: AbortController | undefined;
	watcher.tap(
		frame.hooks.fetch.intercept,
		async ({ parsed, request }, props) => {
			// Only the main frame's GET document can safely restart on a new origin.
			if (parsed.isIframe || parsed.destination !== "iframe") return;
			const sequence = ++navigation;
			handoffAbort?.abort();
			if (request.method !== "GET") return;
			// A fallback can display another logical origin inside this proxy shell.
			// Keep its controller: this shell cannot authenticate that document's origin.
			if (!originTarget || currentTarget.origin !== originTarget.origin) return;
			const destination = proxyUrl(parsed.url, entry, base);
			if (destination.origin === entry.origin) return;
			handoffAbort = new AbortController();
			const ready = await prepareHandoff(
				destination,
				{
					source: entry.origin,
					target: parsed.url.href,
					cookies: transferableCookies(
						controller.cookieJar.dump(),
						originTarget,
						parsed.url
					),
					referrer:
						parsed.referrerSourceUrl === null
							? ""
							: (parsed.referrerSourceUrl?.href ?? currentTarget.href),
					referrerPolicy: parsed.referrerPolicy,
					initiator: parsed.fetchInitiatorOrigin ?? currentTarget.origin,
					crossSiteRedirect: parsed.crossSiteRedirect ?? false,
					fetchSite: parsed.fetchSiteState,
					createdAt: Date.now(),
				},
				handoffAbort.signal
			);
			if (ready || sequence !== navigation) {
				props.response = {
					body: "",
					status: 204,
					statusText: "No Content",
					headers: new ScramjetHeaders(),
				};
				if (sequence === navigation) location.assign(destination);
			}
		}
	);
	watcher.tap(frame.hooks.init.post, (context) => {
		if (!context.isTopLevel) return;
		currentTarget = new URL(context.client.url.href);
		syncAddress(currentTarget.href);
		syncSurface();
		setStage("正在加载页面内容", 0.9);
		// Reveal once the document has parsed; waiting for "load" would also
		// wait for every image and ad on the page.
		if (context.window.document.readyState === "loading")
			context.window.document.addEventListener(
				"DOMContentLoaded",
				finishLoading,
				{ once: true }
			);
		else finishLoading();
		watcher.tap(
			context.client.hooks.lifecycle.navigate,
			({ type }, { url }) => {
				// Location events announce an upcoming request, which may be a POST.
				if (type !== "location") syncAddress(url);
			}
		);
		context.window.addEventListener("hashchange", () =>
			syncAddress(context.client.url.href)
		);
		context.window.addEventListener("popstate", () =>
			syncAddress(context.client.url.href)
		);
	});
	iframe.addEventListener("load", () => {
		try {
			const doc = iframe.contentDocument;
			// Inserting the iframe fires a load for its initial about:blank, even
			// when src is already set, so check the document that actually loaded.
			if (!doc || isBlankDocument(doc)) return;
			finishLoading();
			document.title = doc.title || target.hostname;
		} catch {
			// A document can be temporarily inaccessible while it navigates.
		}
	});
	// The loader overlays the iframe until the first document is ready.
	app.prepend(iframe);
	if (handoff) {
		const context = frame.context;
		// The controller exposes native URLs; core metadata uses branded URL types.
		const meta = { origin: context.prefix, base: context.prefix } as Parameters<
			typeof rewriteUrl
		>[2];
		const initial = new URL(rewriteUrl(target.href, context, meta));
		initial.searchParams.set(
			"$rfs",
			handoff.referrer
				? new URL(frame.prefix, entry).href +
						controller.config.codec.encode(handoff.referrer)
				: ""
		);
		initial.searchParams.set("$io", handoff.initiator);
		if (handoff.referrerPolicy)
			initial.searchParams.set("$rfp", handoff.referrerPolicy);
		if (handoff.crossSiteRedirect) initial.searchParams.set("$csr", "1");
		if (handoff.fetchSite) initial.searchParams.set("$fs", handoff.fetchSite);
		iframe.src = initial.href;
	} else frame.go(target.href);
}

main().catch((error) => {
	console.error("Proxy initialization failed:", error);
	failLoading(
		error instanceof Error ? error.message : "代理加载失败，请刷新重试。"
	);
});
