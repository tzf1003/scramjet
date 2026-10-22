import { browserKeyClient } from "./access-key-client.js";

const client = browserKeyClient();
let pending = false;
async function keepAccess() {
	if (pending || document.visibilityState === "hidden") return;
	pending = true;
	try {
		const response = await fetch("/api/session", {
			credentials: "same-origin",
			cache: "no-store",
		});
		if (response.status === 401) {
			document.dispatchEvent(new Event("scramjet-cache-revoke"));
			if (await client.restore()) location.reload();
			else
				location.replace(
					"/login?return=" +
						encodeURIComponent(
							location.pathname + location.search + location.hash
						)
				);
		}
	} catch (error) {
		if (error.status === 401)
			location.replace(
				"/login?return=" +
					encodeURIComponent(
						location.pathname + location.search + location.hash
					)
			);
	} finally {
		pending = false;
	}
}
document.addEventListener("visibilitychange", keepAccess);
window.addEventListener("online", keepAccess);
setInterval(keepAccess, 5 * 60 * 1000);
keepAccess();
