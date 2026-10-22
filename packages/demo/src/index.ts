import { loadEnvironment } from "./environment";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import {
	CatchEscapedLinksPlugin,
	UrlWatcherPlugin,
} from "@mercuryworkshop/scramjet-utils";
import {
	DEFAULT_PROXY_DOMAIN,
	resolveTarget,
	proxyUrl,
	shellUrl,
} from "./routing";

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
	const base = import.meta.env.VITE_PROXY_DOMAIN || DEFAULT_PROXY_DOMAIN;
	const gatewayAccess = import.meta.env.VITE_GATEWAY_ACCESS === "1";
	const routingEntry = new URL(entry);
	if (gatewayAccess && entry.hostname === base)
		routingEntry.hostname = "go." + base;
	const target = resolveTarget(routingEntry, base);
	document.title = target.hostname;

	const serviceworker = await registerWorker();
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
	const watcher = new UrlWatcherPlugin(syncAddress);
	const frame = controller.createFrame(iframe, {
		plugins: [
			watcher,
			new CatchEscapedLinksPlugin((url) =>
				gatewayAccess && entry.hostname === base
					? shellUrl(url, entry, base)
					: proxyUrl(url, entry, base)
			),
		],
	});
	watcher.tap(frame.hooks.init.post, (context) => {
		if (!context.isTopLevel) return;
		context.window.addEventListener("popstate", () =>
			syncAddress(context.client.url.href)
		);
	});
	iframe.addEventListener("load", () => {
		try {
			document.title = iframe.contentDocument?.title || target.hostname;
		} catch {
			// A document can be temporarily inaccessible while it navigates.
		}
	});
	app.replaceChildren(iframe);
	frame.go(target.href);
}

main().catch((error) => {
	console.error("Proxy initialization failed:", error);
	const message = document.createElement("p");
	message.setAttribute("role", "alert");
	message.textContent =
		error instanceof Error ? error.message : "代理加载失败，请刷新重试。";
	app.replaceChildren(message);
});
