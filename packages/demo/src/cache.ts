import { HttpCachePlugin } from "../../utils/src/http-cache-plugin";
import {
	ResourceCache,
	gatewayCacheScope,
} from "../../utils/src/http-cache-storage";

export function proxyResourceCache(topOrigin: () => string) {
	const store = new ResourceCache({ scope: gatewayCacheScope });
	const plugin = new HttpCachePlugin({ store, topOrigin });
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
