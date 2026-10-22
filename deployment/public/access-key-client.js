export const STORAGE_KEY = "scramjet-access-key";

export function createKeyClient({ storage, request = fetch }) {
	function load() {
		try {
			return storage.getItem(STORAGE_KEY) || "";
		} catch {
			return "";
		}
	}
	function forget() {
		try {
			storage.removeItem(STORAGE_KEY);
		} catch {
			/* Cookie clearing still works. */
		}
	}
	async function authorize(accessKey) {
		const response = await request("/api/login", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accessKey }),
		});
		const data = await response.json();
		if (!response.ok) {
			if (response.status === 401 && load() === accessKey) forget();
			const error = new Error(data.error || "验证失败，请稍后重试");
			error.status = response.status;
			throw error;
		}
		try {
			storage.setItem(STORAGE_KEY, accessKey);
		} catch {
			/* Persistent Cookie remains available. */
		}
		return data;
	}
	async function restore() {
		const accessKey = load();
		if (!accessKey) return false;
		await authorize(accessKey);
		return true;
	}
	return { load, forget, authorize, restore };
}

export function browserKeyClient() {
	let storage;
	try {
		storage = window.localStorage;
	} catch {
		storage = null;
	}
	return createKeyClient({ storage });
}

export function returnTarget(search, origin) {
	try {
		const target = new URL(
			new URLSearchParams(search).get("return") || "/",
			origin
		);
		return target.origin === origin && target.pathname !== "/login"
			? target.href
			: origin + "/";
	} catch {
		return origin + "/";
	}
}
