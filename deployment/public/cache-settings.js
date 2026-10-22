import { ResourceCache, gatewayCacheScope } from "/cache-runtime.js";
const store = new ResourceCache({ scope: gatewayCacheScope });
const toggle = document.querySelector("#cache-enabled");
const usage = document.querySelector("#cache-usage");
const clear = document.querySelector("#cache-clear");
async function refresh() {
	const value = await store.usage();
	toggle.checked = value.enabled;
	toggle.disabled = !value.available;
	clear.disabled = !value.available;
	usage.textContent = value.available
		? `${(value.bytes / 1024 / 1024).toFixed(1)} MiB · ${value.entries} 个资源`
		: "缓存不可用，可继续正常浏览";
}
toggle.addEventListener("change", async () => {
	toggle.disabled = true;
	const ok = await store.setEnabled(toggle.checked);
	await refresh();
	if (!ok) usage.textContent = "设置未保存，请稍后重试";
});
clear.addEventListener("click", async () => {
	clear.disabled = true;
	const ok = await store.clear();
	await refresh();
	if (!ok) usage.textContent = "清理失败，请稍后重试";
});
document.addEventListener("scramjet-cache-revoke", () => {
	void store.clear();
});
window.addEventListener("focus", () => {
	void refresh();
});
void refresh();
