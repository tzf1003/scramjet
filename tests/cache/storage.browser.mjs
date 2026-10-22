import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	chromium,
	firefox,
	webkit,
} from "../../packages/runway/node_modules/playwright/index.mjs";
const root = resolve(import.meta.dirname, "../..");
const output = process.env.SCRAMJET_CACHE_OUTPUT || "/tmp/scramjet-cache-tests";
await mkdir(output, { recursive: true });
const vite = await createServer({
	root,
	configFile: false,
	cacheDir: output + "/vite-cache",
	server: { host: "127.0.0.1", port: 0 },
	plugins: [
		{
			name: "cache-test-page",
			configureServer(server) {
				server.middlewares.use("/__cache_test", (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						"<title>Resource cache verification</title><h1>Resource cache verification</h1>"
					);
				});
			},
		},
	],
});
await vite.listen();
const url = `http://127.0.0.1:${vite.httpServer.address().port}/__cache_test`;
let failures = 0;
try {
	for (const [name, engine] of Object.entries(
		process.env.CACHE_BROWSER === "webkit"
			? { webkit }
			: { chromium, firefox, webkit }
	)) {
		const browser = await engine.launch({ headless: true });
		try {
			const page = await browser.newPage();
			const errors = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.goto(url);
			const results = await page.evaluate(async () => {
				const { ResourceCache, LEGACY_CACHE_NAMES } = await import(
					"/packages/utils/src/http-cache-storage.ts"
				);
				const results = [];
				const opened = [];
				const eq = (actual, expected, message = "") => {
					if (actual !== expected)
						throw Error(`${message}: expected ${expected}, got ${actual}`);
				};
				const ok = (value, message = "assertion") => {
					if (!value) throw Error(message);
				};
				const request = (extra = {}) => ({
					url: "https://target.test/app.js?q=1",
					topOrigin: "https://target.test",
					headers: new Headers(),
					credentials: "include",
					method: "GET",
					destination: "script",
					cache: "default",
					...extra,
				});
				const response = (headers = {}, body = "original-bytes") =>
					new Response(body, {
						headers: {
							"content-type": "application/javascript",
							"cache-control": "max-age=3600",
							...headers,
						},
					});
				const cache = (options = {}) => {
					const c = new ResourceCache({
						databaseName: "test-" + crypto.randomUUID(),
						...options,
					});
					c._errors = [];
					const fail = c.fail.bind(c);
					c.fail = (e) => {
						c._errors.push(String(e));
						fail(e);
					};
					opened.push(c);
					return c;
				};
				const seed = async (c, r = request(), resp = response()) => {
					const { ticket } = await c.lookup(r);
					ok(ticket, "ticket");
					const live = c.store(ticket, resp);
					const text = await live.text();
					await c.idle();
					return text;
				};
				const check = async (name, fn) => {
					try {
						await fn();
						results.push({ name, pass: true });
					} catch (error) {
						results.push({
							name,
							pass: false,
							error: String(error) + "\n" + String(error.stack || ""),
							storageErrors: opened.flatMap((c) => c._errors || []),
						});
					}
				};
				await check(
					"fresh hits persist across instances; original bytes and HEAD are retained",
					async () => {
						const c = cache();
						eq(await seed(c), "original-bytes");
						const other = new ResourceCache({ databaseName: c.name });
						opened.push(other);
						eq(
							await (await other.lookup(request())).response.text(),
							"original-bytes"
						);
						eq(
							(await other.lookup(request({ method: "HEAD" }))).response.body,
							null
						);
						eq(c.stats.stored, 1);
					}
				);
				await check(
					"cookie, top site, URL query and credential modes partition entries",
					async () => {
						const c = cache();
						await seed(
							c,
							request({ headers: new Headers({ cookie: "session=alice" }) })
						);
						for (const extra of [
							{ headers: new Headers({ cookie: "session=bob" }) },
							{},
							{
								topOrigin: "https://other.test",
								headers: new Headers({ cookie: "session=alice" }),
							},
							{
								url: "https://target.test/app.js?q=2",
								headers: new Headers({ cookie: "session=alice" }),
							},
							{
								credentials: "omit",
								headers: new Headers({ cookie: "session=alice" }),
							},
						])
							ok(!(await c.lookup(request(extra))).response, "partition miss");
						eq(
							await (
								await c.lookup(
									request({
										headers: new Headers({ cookie: "session=alice" }),
									})
								)
							).response.text(),
							"original-bytes"
						);
						const db = await c.open();
						const tx = db.transaction("entries");
						const rows = await new Promise((resolve, reject) => {
							const r = tx.objectStore("entries").getAll();
							r.onsuccess = () => resolve(r.result);
							r.onerror = () => reject(r.error);
						});
						ok(
							!JSON.stringify(rows).includes("session=alice"),
							"no persisted credential or URL"
						);
						ok(
							!JSON.stringify(rows).includes("https://target.test"),
							"URL hashed"
						);
					}
				);
				await check(
					"Vary uses effective upstream headers and preserves variants",
					async () => {
						const c = cache();
						const en = request({
								headers: new Headers({ "accept-language": "en" }),
							}),
							ja = request({
								headers: new Headers({ "accept-language": "ja" }),
							});
						await seed(c, en, response({ vary: "Accept-Language" }, "English"));
						await seed(
							c,
							ja,
							response({ vary: "Accept-Language" }, "Japanese")
						);
						eq(await (await c.lookup(en)).response.text(), "English");
						eq(await (await c.lookup(ja)).response.text(), "Japanese");
					}
				);
				await check(
					"no-store, cookie setters, Vary star, HTML, JSON and errors stay live",
					async () => {
						for (const resp of [
							response({ "cache-control": "no-store" }),
							response({ vary: "*" }),
							response({ "content-type": "text/html" }),
							response({ "content-type": "application/json" }),
							new Response("error", {
								status: 404,
								headers: {
									"content-type": "image/png",
									"cache-control": "max-age=60",
								},
							}),
						]) {
							const c = cache();
							await seed(c, request(), resp);
							eq((await c.usage()).entries, 0);
						}
					}
				);
				await check(
					"documents, streams, authorization, Range and unsafe methods bypass",
					async () => {
						const c = cache();
						for (const extra of [
							{ destination: "iframe" },
							{ destination: "document" },
							{ destination: "video" },
							{ method: "POST" },
							{ cache: "no-store" },
							{ headers: new Headers({ authorization: "Bearer test" }) },
							{ headers: new Headers({ range: "bytes=0-10" }) },
						])
							eq((await c.lookup(request(extra))).ticket, undefined);
					}
				);
				await check(
					"immutable expires, private max-age wins over s-maxage, Date and Age count",
					async () => {
						for (const headers of [
							{ "cache-control": "immutable, max-age=0", etag: '"v1"' },
							{ "cache-control": "s-maxage=9999, max-age=0", etag: '"v1"' },
							{ "cache-control": "max-age=60", age: "100", etag: '"v1"' },
							{
								"cache-control": "max-age=60",
								date: new Date(Date.now() - 120000).toUTCString(),
								etag: '"v1"',
							},
						]) {
							const c = cache();
							await seed(c, request(), response(headers));
							const lookup = await c.lookup(request());
							ok(!lookup.response);
							eq(lookup.ticket.headers.get("if-none-match"), '"v1"');
						}
					}
				);
				await check(
					"ETag 304 merges headers and old body; a changed 200 replaces it",
					async () => {
						const c = cache();
						await seed(
							c,
							request(),
							response({ "cache-control": "no-cache", etag: '"v1"' })
						);
						const { ticket } = await c.lookup(request());
						eq(ticket.headers.get("if-none-match"), '"v1"');
						const merged = await c.revalidate(
							ticket,
							new Response(null, {
								status: 304,
								headers: {
									"cache-control": "max-age=300",
									etag: '"v1"',
									"x-new": "yes",
								},
							}),
							[]
						);
						const live = c.store(ticket, merged);
						eq(await live.text(), "original-bytes");
						await c.idle();
						eq(
							(await c.lookup(request())).response.headers.get("x-new"),
							"yes"
						);
						const refreshed = await c.lookup(request({ cache: "reload" }));
						await c
							.store(refreshed.ticket, response({ etag: '"v2"' }, "new-bytes"))
							.text();
						await c.idle();
						eq(await (await c.lookup(request())).response.text(), "new-bytes");
					}
				);
				await check(
					"Last-Modified validates; 304 cookies remain live and are not stored",
					async () => {
						const c = cache();
						await seed(
							c,
							request(),
							response({
								"cache-control": "no-cache",
								"last-modified": "Wed, 21 Oct 2026 00:00:00 GMT",
							})
						);
						const { ticket } = await c.lookup(request());
						ok(ticket.headers.has("if-modified-since"));
						const merged = await c.revalidate(
							ticket,
							new Response(null, { status: 304 }),
							[["Set-Cookie", "session=new"]]
						);
						await c
							.store(ticket, merged, [["Set-Cookie", "session=new"]])
							.text();
						await c.idle();
						eq((await c.usage()).entries, 0);
					}
				);
				await check(
					"reload and no-cache force the network; only-if-cached never fetches",
					async () => {
						const c = cache();
						eq(
							(await c.lookup(request({ cache: "only-if-cached" })))
								.onlyIfCachedMiss,
							true
						);
						await seed(c);
						ok((await c.lookup(request({ cache: "only-if-cached" }))).response);
						ok(!(await c.lookup(request({ cache: "reload" }))).response);
						ok(!(await c.lookup(request({ cache: "no-cache" }))).response);
					}
				);
				await check(
					"clear and disable reject pending writes and synchronize other instances",
					async () => {
						const c = cache(),
							other = new ResourceCache({ databaseName: c.name });
						opened.push(other);
						const { ticket } = await c.lookup(request());
						let finish;
						const body = new ReadableStream({
							start(controller) {
								finish = () => {
									controller.enqueue(new TextEncoder().encode("late"));
									controller.close();
								};
							},
						});
						const live = c.store(ticket, response({}, body));
						await other.clear();
						finish();
						await live.text();
						await c.idle();
						eq((await c.usage()).entries, 0);
						await seed(c);
						await other.setEnabled(false);
						eq((await c.lookup(request())).ticket, undefined);
						eq((await c.usage()).entries, 0);
						await c.setEnabled(true);
						await seed(c);
						eq((await c.usage()).entries, 1);
					}
				);
				await check(
					"scope rotation and logout reject old entries and validator tickets",
					async () => {
						let scope = "login-one";
						const c = cache({ scope: () => scope });
						await seed(c);
						const before = await c.lookup(request({ cache: "reload" }));
						scope = "login-two";
						ok(!(await c.lookup(request())).response);
						eq(await c.valid(before.ticket), false);
						eq((await c.usage()).entries, 0);
						await seed(c);
						scope = null;
						eq(await c.settings(), null);
						scope = "login-three";
						eq((await c.usage()).entries, 0);
					}
				);
				await check(
					"entry count and byte budgets evict LRU; oversized streams stay live",
					async () => {
						const c = cache({
							maxEntries: 2,
							maxBytes: 100,
							maxEntryBytes: 50,
						});
						const r = (n) => request({ url: `https://target.test/${n}.js` });
						await seed(c, r(1));
						await seed(c, r(2));
						await new Promise((r) => setTimeout(r, 20));
						await c.lookup(r(1));
						await new Promise((r) => setTimeout(r, 20));
						await seed(c, r(3));
						eq((await c.usage()).entries, 2);
						ok(!(await c.lookup(r(2))).response);
						ok((await c.lookup(r(1))).response);
						const large = "a".repeat(80);
						eq(await seed(c, r(4), response({}, large)), large);
						eq((await c.usage()).entries, 2);
						ok(c.stats.evicted >= 1);
						ok(c.stats.reasons.oversize);
					}
				);
				await check(
					"request freshness limits and stale HEAD do not reuse expired bodies",
					async () => {
						const c = cache();
						await seed(
							c,
							request(),
							response({
								age: "120",
								"cache-control": "max-age=300",
								etag: '"head"',
							})
						);
						ok(
							!(
								await c.lookup(
									request({
										headers: new Headers({ "cache-control": "max-age=60" }),
									})
								)
							).response
						);
						ok(
							!(
								await c.lookup(
									request({
										headers: new Headers({ "cache-control": "min-fresh=200" }),
									})
								)
							).response
						);
						const head = await c.lookup(
							request({ method: "HEAD", cache: "no-cache" })
						);
						eq(head.ticket, undefined);
						eq(head.response, undefined);
					}
				);
				await check(
					"changed Vary declarations replace incompatible variants",
					async () => {
						const c = cache();
						const r = request({
							headers: new Headers({ "accept-language": "en" }),
						});
						await seed(c, r, response({ vary: "Accept-Language" }, "before"));
						await seed(c, { ...r, cache: "reload" }, response({}, "after"));
						eq(await (await c.lookup(r)).response.text(), "after");
						eq((await c.usage()).entries, 1);
					}
				);
				await check(
					"raw cookie fields prevent 200 storage and concurrent writes are bounded",
					async () => {
						const c = cache({ maxPendingWrites: 1 });
						const first = await c.lookup(request());
						let finish;
						const body = new ReadableStream({
							start(controller) {
								finish = () => {
									controller.enqueue(new TextEncoder().encode("bounded"));
									controller.close();
								};
							},
						});
						const live = c.store(first.ticket, response({}, body));
						const other = await c.lookup(
							request({ url: "https://target.test/second.js" })
						);
						await c.store(other.ticket, response()).text();
						ok(c.stats.reasons["size-or-concurrency"]);
						finish();
						await live.text();
						await c.idle();
						eq((await c.usage()).entries, 1);
						const cookie = await c.lookup(request({ cache: "reload" }));
						await c
							.store(cookie.ticket, response(), [
								["Set-Cookie", "session=rotated"],
							])
							.text();
						await c.idle();
						eq((await c.usage()).entries, 0);
					}
				);
				await check(
					"unavailable IndexedDB fails open and legacy cleanup preserves site caches",
					async () => {
						const c = cache();
						c.open = () => Promise.reject(Error("storage denied"));
						eq((await c.lookup(request())).ticket, undefined);
						ok(c.stats.failure > 0);
						await caches.open(LEGACY_CACHE_NAMES[0]);
						await caches.open("target-owned-cache");
						const valid = cache();
						await valid.settings();
						await new Promise((r) => setTimeout(r, 50));
						ok(!(await caches.keys()).includes(LEGACY_CACHE_NAMES[0]));
						ok((await caches.keys()).includes("target-owned-cache"));
					}
				);
				await check(
					"first bytes are delivered before a cache write completes",
					async () => {
						const c = cache();
						const { ticket } = await c.lookup(request());
						let finish;
						const body = new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("first"));
								finish = () => controller.close();
							},
						});
						const live = c.store(ticket, response({}, body));
						const reader = live.body.getReader();
						eq(new TextDecoder().decode((await reader.read()).value), "first");
						eq(c.stats.stored, 0);
						finish();
						await reader.read();
						await c.idle();
						eq(c.stats.stored, 1);
					}
				);
				for (const c of opened) c.close();
				return results;
			});
			assert.deepEqual(errors, []);
			failures += results.filter((r) => !r.pass).length;
			await writeFile(
				`${output}/${name}-storage.json`,
				JSON.stringify({ results, errors }, null, 2)
			);
			console.log(JSON.stringify({ browser: name, results }));
		} finally {
			await browser.close();
		}
	}
} finally {
	await vite.close();
}
if (failures) process.exitCode = 1;
