/** Private upstream-resource storage. Entries and their generation commit atomically. */
export const CACHE_DATABASE = "__scramjet_http_cache_v3";
export const LEGACY_CACHE_NAMES = ["scramjet-http-cache-v2"];
const MiB = 1024 * 1024;
const SETTINGS = "settings";
export type CacheStats = {
	hit: number;
	miss: number;
	revalidated: number;
	stored: number;
	evicted: number;
	skipped: number;
	failure: number;
	reasons: Record<string, number>;
};
export type CacheSettings = { epoch: string; enabled: boolean; scope: string };
type Entry = {
	id: string;
	partition: string;
	epoch: string;
	vary: string[];
	variant: string;
	headers: [string, string][];
	status: number;
	statusText: string;
	body: ArrayBuffer;
	size: number;
	storedAt: number;
	accessedAt: number;
	initialAge: number;
	lifetime: number;
};
export type CacheRequest = {
	url: string;
	topOrigin: string;
	headers: Headers;
	credentials: string;
	method: string;
	destination: string;
	cache: RequestCache;
};
export type CacheTicket = {
	key: string;
	headers: Headers;
	epoch: string;
	startedAt: number;
	request: CacheRequest;
	entry?: Entry;
	conditional?: boolean;
};
export type CacheLookup = {
	ticket?: CacheTicket;
	response?: Response;
	onlyIfCachedMiss?: boolean;
};
export type ResourceCacheOptions = {
	databaseName?: string;
	maxBytes?: number;
	maxEntries?: number;
	maxEntryBytes?: number;
	maxPendingWrites?: number;
	scope?: () => string | null;
};

export function gatewayCacheScope(): string | null {
	const cookies =
		typeof document === "undefined"
			? []
			: document.cookie.split(";").map((x) => x.trim());
	if (cookies.includes("__Secure-scramjet-logged-out=1")) return null;
	return (
		cookies
			.find((x) => x.startsWith("__Secure-scramjet-cache-epoch="))
			?.split("=")[1] || "local"
	);
}
function directives(value: string | null): Map<string, string> {
	const result = new Map<string, string>();
	for (const part of (value || "").split(",")) {
		const [name, ...rest] = part.trim().split("=");
		const key = name.toLowerCase();
		if (result.has(key)) result.set("no-cache", "");
		result.set(key, rest.join("=").replace(/^"|"$/g, ""));
	}
	return result;
}
function seconds(value: string | null | undefined): number | undefined {
	return value !== undefined &&
		value !== null &&
		/^\d+$/.test(value) &&
		Number.isSafeInteger(Number(value))
		? Number(value)
		: undefined;
}
function lifetime(headers: Headers, time: number): number {
	const cc = directives(headers.get("cache-control"));
	if (
		cc.has("no-cache") ||
		/(?:^|,)\s*no-cache\s*(?:,|$)/i.test(headers.get("pragma") || "")
	)
		return 0;
	const maxAge = seconds(cc.get("max-age"));
	if (maxAge !== undefined) return maxAge;
	const date = Date.parse(headers.get("date") || "");
	const expires = Date.parse(headers.get("expires") || "");
	return Number.isFinite(expires)
		? Math.max(0, (expires - (Number.isFinite(date) ? date : time)) / 1000)
		: 0;
}
function age(entry: Entry): number {
	return entry.initialAge + Math.max(0, Date.now() - entry.storedAt) / 1000;
}
function reusable(entry: Entry): boolean {
	return age(entry) < entry.lifetime;
}
function storable(headers: Headers, status: number): boolean {
	const mime = (headers.get("content-type") || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return (
		status === 200 &&
		!headers.has("set-cookie") &&
		!headers.has("set-cookie2") &&
		!headers.has("content-range") &&
		!directives(headers.get("cache-control")).has("no-store") &&
		!(headers.get("vary") || "").split(",").some((x) => x.trim() === "*") &&
		(/^(?:image\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+)$/.test(mime) ||
			[
				"text/css",
				"text/javascript",
				"application/javascript",
				"application/x-javascript",
				"application/wasm",
				"application/font-woff",
				"application/vnd.ms-fontobject",
			].includes(mime))
	);
}
async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(bytes), (x) =>
		x.toString(16).padStart(2, "0")
	).join("");
}
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function complete(transaction: IDBTransaction): Promise<void> {
	const done = new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = transaction.onerror = () =>
			reject(transaction.error || new Error("Cache transaction aborted"));
	});
	void done.catch(() => {});
	return done;
}
function headerPairs(headers: Headers): [string, string][] {
	return Array.from(headers.entries());
}
function entryResponse(entry: Entry, method: string): Response {
	const headers = new Headers(entry.headers);
	headers.set("age", String(Math.floor(age(entry))));
	return new Response(method === "HEAD" ? null : entry.body, {
		status: entry.status,
		statusText: entry.statusText,
		headers,
	});
}

export class ResourceCache {
	readonly name: string;
	readonly stats: CacheStats = {
		hit: 0,
		miss: 0,
		revalidated: 0,
		stored: 0,
		evicted: 0,
		skipped: 0,
		failure: 0,
		reasons: {},
	};
	private options: Required<Omit<ResourceCacheOptions, "scope">>;
	private scope: () => string | null;
	private database?: Promise<IDBDatabase>;
	private pending = new Set<Promise<void>>();
	private migrated = false;
	constructor(options: ResourceCacheOptions = {}) {
		this.name = options.databaseName || CACHE_DATABASE;
		this.options = {
			databaseName: this.name,
			maxBytes: 100 * MiB,
			maxEntries: 2000,
			maxEntryBytes: 8 * MiB,
			maxPendingWrites: 4,
			...options,
		};
		this.scope = options.scope || (() => "local");
	}
	skip(reason: string): void {
		this.stats.skipped++;
		this.stats.reasons[reason] = (this.stats.reasons[reason] || 0) + 1;
	}
	private fail(_error?: unknown): void {
		this.stats.failure++;
	}
	private open(): Promise<IDBDatabase> {
		if (!this.database)
			this.database = new Promise((resolve, reject) => {
				const request = indexedDB.open(this.name, 1);
				request.onupgradeneeded = () => {
					const db = request.result;
					db.createObjectStore("entries", { keyPath: "id" }).createIndex(
						"partition",
						"partition"
					);
					db.createObjectStore("meta");
				};
				request.onsuccess = () => {
					request.result.onversionchange = () => {
						request.result.close();
						this.database = undefined;
					};
					resolve(request.result);
				};
				request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("Cache database blocked"));
			});
		return this.database;
	}
	async settings(): Promise<CacheSettings | null> {
		try {
			const scope = this.scope();
			const db = await this.open();
			const tx = db.transaction(["meta", "entries"], "readwrite");
			const done = complete(tx);
			const meta = tx.objectStore("meta");
			let settings = (await idbRequest(meta.get(SETTINGS))) as
				| CacheSettings
				| undefined;
			if (!settings || settings.scope !== (scope ?? "revoked")) {
				settings = {
					epoch: crypto.randomUUID(),
					enabled: settings?.enabled ?? true,
					scope: scope ?? "revoked",
				};
				meta.put(settings, SETTINGS);
				tx.objectStore("entries").clear();
			}
			await done;
			if (!this.migrated) {
				this.migrated = true;
				if (typeof caches !== "undefined")
					for (const name of LEGACY_CACHE_NAMES)
						void caches.delete(name).catch((error) => this.fail(error));
			}
			return scope === null ? null : settings;
		} catch (error) {
			this.fail(error);
			return null;
		}
	}
	async valid(ticket: CacheTicket): Promise<boolean> {
		return (await this.settings())?.epoch === ticket.epoch;
	}
	async clear(enabled?: boolean): Promise<boolean> {
		try {
			const db = await this.open();
			const tx = db.transaction(["meta", "entries"], "readwrite");
			const done = complete(tx);
			const meta = tx.objectStore("meta");
			const previous = (await idbRequest(meta.get(SETTINGS))) as
				| CacheSettings
				| undefined;
			meta.put(
				{
					epoch: crypto.randomUUID(),
					enabled: enabled ?? previous?.enabled ?? true,
					scope: this.scope() ?? "revoked",
				},
				SETTINGS
			);
			tx.objectStore("entries").clear();
			await done;
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}
	async setEnabled(enabled: boolean): Promise<boolean> {
		return this.clear(enabled);
	}
	async usage(): Promise<{
		bytes: number;
		entries: number;
		enabled: boolean;
		available: boolean;
	}> {
		const settings = await this.settings();
		if (!settings)
			return { bytes: 0, entries: 0, enabled: false, available: false };
		try {
			const db = await this.open();
			const tx = db.transaction("entries", "readonly");
			const done = complete(tx);
			let bytes = 0,
				entries = 0;
			await new Promise<void>((resolve, reject) => {
				const request = tx.objectStore("entries").openCursor();
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					const entry = cursor.value as Entry;
					bytes += entry.size;
					entries++;
					cursor.continue();
				};
			});
			await done;
			return { bytes, entries, enabled: settings.enabled, available: true };
		} catch (error) {
			this.fail(error);
			return {
				bytes: 0,
				entries: 0,
				enabled: settings.enabled,
				available: false,
			};
		}
	}
	async lookup(request: CacheRequest): Promise<CacheLookup> {
		const method = request.method.toUpperCase();
		const headers = new Headers(request.headers);
		if (
			!new Set(["GET", "HEAD"]).has(method) ||
			!new Set([
				"script",
				"style",
				"image",
				"font",
				"",
				"worker",
				"sharedworker",
			]).has(request.destination) ||
			!/^https?:\/\//.test(request.url) ||
			headers.has("authorization") ||
			headers.has("proxy-authorization") ||
			headers.has("range") ||
			request.cache === "no-store" ||
			directives(headers.get("cache-control")).has("no-store") ||
			headers.has("if-none-match") ||
			headers.has("if-modified-since")
		) {
			this.skip("request-policy");
			return { onlyIfCachedMiss: request.cache === "only-if-cached" };
		}
		try {
			const settings = await this.settings();
			if (!settings?.enabled) {
				this.skip("disabled-or-unavailable");
				return { onlyIfCachedMiss: request.cache === "only-if-cached" };
			}
			const key = await digest(
				JSON.stringify([
					request.url,
					request.topOrigin,
					headers.get("cookie") || "",
					request.credentials,
				])
			);
			const ticket: CacheTicket = {
				key,
				headers,
				epoch: settings.epoch,
				startedAt: Date.now(),
				request,
			};
			if (request.cache === "reload") {
				this.stats.miss++;
				return { ticket };
			}
			const db = await this.open();
			const tx = db.transaction("entries", "readonly");
			const done = complete(tx);
			const entries = (await idbRequest(
				tx.objectStore("entries").index("partition").getAll(key)
			)) as Entry[];
			await done;
			let entry: Entry | undefined;
			for (const candidate of entries) {
				if (
					candidate.epoch === ticket.epoch &&
					candidate.variant === (await this.variant(candidate.vary, headers))
				) {
					entry = candidate;
					break;
				}
			}
			if (!entry) {
				this.stats.miss++;
				return { ticket, onlyIfCachedMiss: request.cache === "only-if-cached" };
			}
			ticket.entry = entry;
			const requestCC = directives(headers.get("cache-control"));
			const forced =
				request.cache === "no-cache" ||
				requestCC.has("no-cache") ||
				(seconds(requestCC.get("max-age")) !== undefined &&
					age(entry) >= Number(requestCC.get("max-age"))) ||
				(seconds(requestCC.get("min-fresh")) !== undefined &&
					age(entry) + Number(requestCC.get("min-fresh")) >= entry.lifetime) ||
				/no-cache/i.test(headers.get("pragma") || "");
			if (!forced && reusable(entry)) {
				if ((await this.settings())?.epoch !== ticket.epoch) return {};
				this.stats.hit++;
				void this.touch(entry.id, ticket.epoch);
				return { response: entryResponse(entry, method) };
			}
			if (request.cache === "only-if-cached") return { onlyIfCachedMiss: true };
			// A stale HEAD cannot refresh the stored GET body.
			if (method === "HEAD") return {};
			const etag = new Headers(entry.headers).get("etag"),
				modified = new Headers(entry.headers).get("last-modified");
			if (etag) {
				headers.set("if-none-match", etag);
				ticket.conditional = true;
			} else if (modified) {
				headers.set("if-modified-since", modified);
				ticket.conditional = true;
			}
			this.stats.miss++;
			return { ticket };
		} catch (error) {
			this.fail(error);
			return { onlyIfCachedMiss: request.cache === "only-if-cached" };
		}
	}
	private async variant(vary: string[], headers: Headers): Promise<string> {
		return digest(
			JSON.stringify(vary.map((name) => [name, headers.get(name)]))
		);
	}
	private async touch(id: string, epoch: string): Promise<void> {
		try {
			const db = await this.open();
			const tx = db.transaction(["meta", "entries"], "readwrite");
			const done = complete(tx);
			const store = tx.objectStore("entries");
			const settings = (await idbRequest(
				tx.objectStore("meta").get(SETTINGS)
			)) as CacheSettings;
			const entry = (await idbRequest(store.get(id))) as Entry | undefined;
			if (settings?.epoch === epoch && entry) {
				entry.accessedAt = Date.now();
				store.put(entry);
			}
			await done;
		} catch (error) {
			this.fail(error);
		}
	}
	/** Merge a validator response before rewriting. Network cookie headers remain live-only. */
	async revalidate(
		ticket: CacheTicket,
		response: Response,
		rawHeaders: [string, string][]
	): Promise<Response> {
		if (response.status !== 304 || !ticket.conditional || !ticket.entry)
			return response;
		const entry = ticket.entry;
		const headers = new Headers(entry.headers);
		for (const [name, value] of response.headers)
			if (
				![
					"content-length",
					"content-encoding",
					"content-range",
					"set-cookie",
					"set-cookie2",
				].includes(name)
			)
				headers.set(name, value);
		if (!response.headers.has("date"))
			headers.set("date", new Date().toUTCString());
		if (!response.headers.has("age")) headers.delete("age");
		const merged = new Response(entry.body, {
			status: 200,
			statusText: entry.statusText,
			headers,
		});
		await this.remove(entry.id);
		this.stats.revalidated++;
		for (const [name, value] of rawHeaders)
			if (/^set-cookie2?$/i.test(name)) merged.headers.append(name, value);
		return merged;
	}
	private async remove(id: string): Promise<void> {
		try {
			const db = await this.open();
			const tx = db.transaction("entries", "readwrite");
			const done = complete(tx);
			tx.objectStore("entries").delete(id);
			await done;
		} catch (error) {
			this.fail(error);
		}
	}
	private discard(ticket: CacheTicket): void {
		const task = (async () => {
			try {
				const db = await this.open();
				const tx = db.transaction(["meta", "entries"], "readwrite");
				const done = complete(tx);
				const settings = (await idbRequest(
					tx.objectStore("meta").get(SETTINGS)
				)) as CacheSettings | undefined;
				if (settings?.epoch === ticket.epoch) {
					const store = tx.objectStore("entries");
					const keys = await idbRequest(
						store.index("partition").getAllKeys(ticket.key)
					);
					for (const key of keys) store.delete(key);
				}
				await done;
			} catch (error) {
				this.fail(error);
			}
		})();
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task));
	}

	/** Tee asynchronously; the live response is returned immediately with original headers intact. */
	store(
		ticket: CacheTicket,
		response: Response,
		rawHeaders: ReadonlyArray<readonly [string, string]> = []
	): Response {
		if (rawHeaders.some(([name]) => /^set-cookie2?$/i.test(name))) {
			this.skip("response-cookie");
			this.discard(ticket);
			return response;
		}
		if (ticket.request.method !== "GET") return response;
		if (!storable(response.headers, response.status)) {
			this.skip("response-policy");
			this.discard(ticket);
			return response;
		}
		const headers = new Headers(response.headers);
		const ttl = lifetime(headers, Date.now());
		if (ttl <= 0 && !headers.has("etag") && !headers.has("last-modified")) {
			this.skip("no-freshness-or-validator");
			this.discard(ticket);
			return response;
		}
		const size = seconds(headers.get("content-length"));
		if (
			(size !== undefined && size > this.options.maxEntryBytes) ||
			this.pending.size >= this.options.maxPendingWrites ||
			!response.body
		) {
			this.skip("size-or-concurrency");
			this.discard(ticket);
			return response;
		}
		const [live, copy] = response.body.tee();
		const task = this.write(ticket, copy, headers, response.statusText).catch(
			(error) => this.fail(error)
		);
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task));
		return new Response(live, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}
	private async write(
		ticket: CacheTicket,
		stream: ReadableStream<Uint8Array>,
		headers: Headers,
		statusText: string
	): Promise<void> {
		const reader = stream.getReader();
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			void reader.cancel().catch(() => {});
		}, 30000);
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > this.options.maxEntryBytes) {
					void reader.cancel();
					this.skip("oversize");
					this.discard(ticket);
					return;
				}
				chunks.push(new Uint8Array(value));
			}
		} finally {
			clearTimeout(timeout);
			reader.releaseLock();
		}
		if (timedOut) {
			this.skip("write-timeout");
			return;
		}
		const scope = this.scope();
		if (scope === null) return;
		const vary = (headers.get("vary") || "")
			.split(",")
			.map((x) => x.trim().toLowerCase())
			.filter(Boolean)
			.sort();
		const variant = await this.variant(vary, ticket.headers);
		const id = await digest(ticket.epoch + ticket.key + variant);
		const storedAt = Date.now();
		const date = Date.parse(headers.get("date") || "");
		const apparent = Number.isFinite(date)
			? Math.max(0, (storedAt - date) / 1000)
			: 0;
		const initialAge = Math.max(
			apparent,
			(seconds(headers.get("age")) || 0) +
				Math.max(0, storedAt - ticket.startedAt) / 1000
		);
		const entry: Entry = {
			id,
			partition: ticket.key,
			epoch: ticket.epoch,
			vary,
			variant,
			headers: headerPairs(headers),
			status: 200,
			statusText,
			body: await new Blob(chunks).arrayBuffer(),
			size,
			storedAt,
			accessedAt: storedAt,
			initialAge,
			lifetime: lifetime(headers, storedAt),
		};
		let budget = this.options.maxBytes;
		try {
			const estimate = await navigator.storage.estimate();
			if (estimate.quota)
				budget = Math.min(
					budget,
					estimate.quota * 0.05,
					Math.max(0, (estimate.quota - (estimate.usage || 0)) * 0.5)
				);
		} catch {}
		if (size > budget) {
			this.skip("quota");
			return;
		}
		const db = await this.open();
		const tx = db.transaction(["meta", "entries"], "readwrite");
		const done = complete(tx);
		const settings = (await idbRequest(
			tx.objectStore("meta").get(SETTINGS)
		)) as CacheSettings | undefined;
		if (
			!settings?.enabled ||
			settings.epoch !== ticket.epoch ||
			settings.scope !== scope ||
			this.scope() !== scope
		) {
			await done;
			return;
		}
		const store = tx.objectStore("entries");
		const entries: Omit<Entry, "body">[] = [];
		await new Promise<void>((resolve, reject) => {
			const req = store.openCursor();
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) {
					resolve();
					return;
				}
				const { body: _, ...meta } = cursor.value as Entry;
				entries.push(meta);
				cursor.continue();
			};
		});
		for (let i = entries.length - 1; i >= 0; i--) {
			if (
				entries[i].partition === ticket.key &&
				JSON.stringify(entries[i].vary) !== JSON.stringify(vary)
			) {
				store.delete(entries[i].id);
				entries.splice(i, 1);
			}
		}
		let total =
			entries.reduce((sum, e) => sum + (e.id === id ? 0 : e.size), 0) + size;
		let count = entries.filter((e) => e.id !== id).length + 1;
		entries.sort(
			(a, b) =>
				Number(reusable(a as Entry)) - Number(reusable(b as Entry)) ||
				a.accessedAt - b.accessedAt
		);
		for (const old of entries) {
			if (total <= budget && count <= this.options.maxEntries) break;
			if (old.id === id) continue;
			store.delete(old.id);
			total -= old.size;
			count--;
			this.stats.evicted++;
		}
		store.put(entry);
		await done;
		this.stats.stored++;
	}
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.all(Array.from(this.pending));
	}
	close(): void {
		void this.database?.then((db) => db.close()).catch(() => {});
		this.database = undefined;
	}
}
