import { HttpCachePlugin } from "../../utils/src/http-cache-plugin";
import {
	ResourceCache,
	gatewayCacheScope,
} from "../../utils/src/http-cache-storage";

export function proxyResourceCache(topOrigin: () => string) {
	const store = new ResourceCache({ scope: gatewayCacheScope });
	const bypass = sessionStorage.getItem("__scramjet_cache_bypass") === "1";
	sessionStorage.removeItem("__scramjet_cache_bypass");
	const plugin = new HttpCachePlugin({
		store,
		topOrigin,
		bypass: () => bypass,
	});
	const details = document.createElement("details");
	details.className = "resource-cache";
	const summary = document.createElement("summary");
	summary.textContent = "资源缓存";
	details.append(summary);
	const panel = document.createElement("div");
	panel.className = "resource-cache__panel";
	const label = document.createElement("label");
	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	label.append(toggle, " 启用资源缓存");
	const usage = document.createElement("p");
	usage.setAttribute("role", "status");
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "清理当前站点缓存";
	const reload = document.createElement("button");
	reload.type = "button";
	reload.textContent = "绕过缓存重新加载";
	panel.append(label, usage, clear, reload);
	details.append(panel);
	document.body.append(details);
	const refresh = async () => {
		const value = await store.usage();
		toggle.checked = value.enabled;
		toggle.disabled = !value.available;
		clear.disabled = !value.available;
		usage.textContent = value.available
			? `${(value.bytes / 1024 / 1024).toFixed(1)} MiB · ${value.entries} 个资源${bypass ? " · 本次已绕过缓存" : ""}`
			: "缓存不可用，正在正常联网加载";
	};
	details.addEventListener("toggle", () => {
		if (details.open) void refresh();
	});
	toggle.addEventListener("change", async () => {
		toggle.disabled = true;
		const ok = await store.setEnabled(toggle.checked);
		await refresh();
		if (!ok) usage.textContent = "缓存设置未保存，请稍后重试";
	});
	clear.addEventListener("click", async () => {
		clear.disabled = true;
		const ok = await store.clear();
		await refresh();
		if (!ok) usage.textContent = "清理失败，请稍后重试";
	});
	reload.addEventListener("click", () => {
		sessionStorage.setItem("__scramjet_cache_bypass", "1");
		location.reload();
	});
	// Read epoch changes even while idle; every cache read/write also checks it.
	const synchronize = () => {
		void store.settings();
	};
	window.addEventListener("focus", synchronize);
	document.addEventListener("visibilitychange", synchronize);
	document.addEventListener("scramjet-cache-revoke", () => {
		void store.clear();
	});
	let timer = setInterval(synchronize, 5000);
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) {
			synchronize();
			timer = setInterval(synchronize, 5000);
		}
	});
	window.addEventListener("pagehide", () => {
		clearInterval(timer);
		store.close();
	});
	// Counters are intentionally aggregate; they contain no URLs or credentials.
	Object.defineProperty(window, "scramjetCacheStats", {
		get: () => structuredClone(store.stats),
		configurable: true,
	});
	return plugin;
}
