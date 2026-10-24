import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import {
	chromium,
	firefox,
	webkit,
} from "../../packages/runway/node_modules/playwright/index.mjs";
const engineName = process.env.SCRAMJET_TEST_BROWSER || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
assert.ok(engine, `unknown SCRAMJET_TEST_BROWSER ${engineName}`);
const root = resolve(import.meta.dirname, "../..");
const out = process.env.SCRAMJET_CACHE_OUTPUT || "/tmp/scramjet-cache-tests";
await mkdir(out, { recursive: true });
const requests = [];
const html = `<!doctype html><title>Cache integration fixture</title><link rel="stylesheet" href="/style.css"><h1>Resource cache integration</h1><p id="ready">Loading</p><img src="/pixel.png"><script src="/app.js"></script><script src="/validate.js"></script><script src="/cookie.js"></script><script>Promise.all([fetch('/data.json').then(r=>r.json()),fetch('/empty.wasm').then(r=>r.arrayBuffer()).then(b=>WebAssembly.compile(b))]).then(()=>document.querySelector('#ready').textContent='Ready');</script>`;
const resources = {
	"/nested.js": [
		"application/javascript",
		"export const value=42;export const source=import.meta.url;",
		"max-age=3600",
	],
	"/app.js": [
		"application/javascript",
		`window.loadedApp=(window.loadedApp||0)+1;window.loadCachedModule=()=>import('./nested.js');/*${"resource".repeat(10000)}*/`,
		"max-age=3600",
	],
	"/style.css": [
		"text/css",
		"body{font-family:sans-serif;background:#eef4ff;color:#182b4a;padding:32px}h1{font-size:28px}",
		"max-age=3600",
	],
	"/pixel.png": [
		"image/png",
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=",
			"base64"
		),
		"max-age=3600",
	],
	"/empty.wasm": [
		"application/wasm",
		Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
		"max-age=3600",
	],
	"/validate.js": [
		"application/javascript",
		"window.validated=true;",
		"no-cache",
	],
	"/cookie.js": [
		"application/javascript",
		"window.cookieResource=true;",
		"max-age=3600",
	],
	"/data.json": ["application/json", '{"live":true}', "max-age=3600"],
};
const target = httpServer((req, res) => {
	const resource = resources[req.url];
	let body = resource?.[1] ?? html;
	const record = {
		path: req.url,
		cookie: req.headers.cookie || "",
		validator: req.headers["if-none-match"],
		bytes: 0,
		status: 200,
	};
	requests.push(record);
	res.setHeader("Content-Type", resource?.[0] || "text/html");
	res.setHeader("Cache-Control", resource?.[2] || "no-store");
	if (req.url === "/validate.js") {
		res.setHeader("ETag", '"fixture-v1"');
		if (record.validator === '"fixture-v1"') {
			record.status = 304;
			res.writeHead(304);
			res.end();
			return;
		}
	}
	if (req.url === "/cookie.js")
		res.setHeader("Set-Cookie", "resource=once; Path=/; SameSite=Lax");
	record.bytes = Buffer.byteLength(body);
	res.setHeader("Content-Length", record.bytes);
	res.end(body);
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
logging.set_level(logging.ERROR);
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;
const relay = httpServer();
relay.on("upgrade", (req, socket, head) =>
	wisp.routeRequest(req, socket, head)
);
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
process.env.VITE_PROXY_DOMAIN = "localhost";
process.env.VITE_GATEWAY_HOST = "localhost";
process.env.VITE_GATEWAY_ACCESS = "1";
process.env.VITE_WISP_URL = `ws://127.0.0.1:${relay.address().port}/wisp/`;
const vite = await createServer({
	root: root + "/packages/demo",
	configFile: root + "/packages/demo/vite.config.ts",
	cacheDir: out + "/vite-proxy",
	server: { host: "127.0.0.1", port: 0 },
	plugins: [
		{
			name: "test-config",
			configureServer(s) {
				s.middlewares.use("/api/config", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ webrtc: { mode: "off", iceServers: [] } }));
				});
			},
		},
	],
});
await vite.listen();
const browser = await engine.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
	if (m.type() === "error") consoleErrors.push(m.text());
});
const url = `http://localhost:${vite.httpServer.address().port}/?__scramjet_url=${encodeURIComponent("http://127.0.0.1:" + target.address().port + "/page")}`;
const frame = () => page.frameLocator("#app > iframe");
const ready = async () => {
	await frame().locator("#ready").filter({ hasText: "Ready" }).waitFor();
	await page.waitForFunction(() => window.scramjetCacheStats?.stored >= 4);
};
const snapshot = () => ({
	count: requests.length,
	bytes: requests.reduce((s, r) => s + r.bytes, 0),
});
const result = {};
try {
	await page.goto(url);
	await ready();
	// The first document sets a Cookie; warm the resulting Cookie partition once.
	await page.reload();
	await ready();
	await page.evaluate(
		async (storageUrl) => {
			const { ResourceCache, gatewayCacheScope } = await import(storageUrl);
			await new ResourceCache({ scope: gatewayCacheScope }).clear();
		},
		"/@fs" + root + "/packages/utils/src/http-cache-storage.ts"
	);
	const coldStart = snapshot();
	await page.reload();
	await ready();
	const before = snapshot();
	result.cold = {
		count: before.count - coldStart.count,
		bytes: before.bytes - coldStart.bytes,
	};
	const offset = requests.length;
	await page.reload();
	await frame().locator("#ready").filter({ hasText: "Ready" }).waitFor();
	await page.waitForFunction(() => window.scramjetCacheStats.hit >= 4);
	const warm = requests.slice(offset);
	for (const path of ["/app.js", "/style.css", "/pixel.png", "/empty.wasm"])
		assert.equal(
			warm.some((r) => r.path === path),
			false,
			path + " stays local"
		);
	assert.ok(warm.some((r) => r.path === "/page"));
	assert.ok(warm.some((r) => r.path === "/data.json"));
	assert.ok(warm.some((r) => r.path === "/cookie.js"));
	assert.ok(warm.some((r) => r.path === "/validate.js" && r.status === 304));
	result.warm = {
		count: snapshot().count - before.count,
		bytes: snapshot().bytes - before.bytes,
		requests: warm,
		stats: await page.evaluate(() => window.scramjetCacheStats),
	};
	assert.equal(
		await page.locator(".resource-cache, #cache-settings").count(),
		0
	);
	await page.locator(".loader").waitFor({ state: "hidden" });
	await page.screenshot({ path: out + "/cache-desktop.png" });
	assert.equal(
		await frame().locator("h1").innerText(),
		"Resource cache integration"
	);
	assert.equal(await page.locator("vite-error-overlay").count(), 0);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: out + "/cache-mobile.png" });

	const imported = await page.frames()[1].evaluate(async () => {
		const module = await window.loadCachedModule();
		return { value: module.value, source: module.source };
	});
	assert.equal(imported.value, 42);
	assert.equal(
		imported.source,
		"http://127.0.0.1:" + target.address().port + "/nested.js"
	);

	result.policy = [
		"automatic warm reuse",
		"live HTML and JSON",
		"live cookie setters",
		"304 validation",
		"cached script module imports",
	];
	assert.deepEqual(errors, []);
	assert.deepEqual(consoleErrors, []);
	result.errors = errors;
	result.consoleErrors = consoleErrors;
	result.url = page.url();
	result.title = await page.title();
	await writeFile(out + "/proxy-result.json", JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	await page.screenshot({ path: out + "/proxy-failure.png" });
	await writeFile(
		out + "/proxy-failure.json",
		JSON.stringify(
			{
				error: String(error),
				errors,
				consoleErrors,
				requests,
				stats: await page.evaluate(() => window.scramjetCacheStats),
				frames: page.frames().map((f) => f.url()),
			},
			null,
			2
		)
	);
	throw error;
} finally {
	await browser.close();
	await vite.close();
	relay.closeAllConnections();
	relay.close();
	target.closeAllConnections();
	target.close();
}
