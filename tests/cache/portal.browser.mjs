import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "../../packages/runway/node_modules/playwright/index.mjs";
const root = resolve(import.meta.dirname, "../..");
const out = process.env.SCRAMJET_CACHE_OUTPUT || "/tmp/scramjet-cache-tests";
const build = process.env.SCRAMJET_CACHE_FRONTEND;
assert.ok(build, "Set SCRAMJET_CACHE_FRONTEND to the production Vite build");
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
	const path = new URL(req.url, "http://localhost").pathname;
	if (path.startsWith("/api/")) {
		res.setHeader("Content-Type", "application/json");
		res.end('{"ok":true}');
		return;
	}
	const file = path === "/" ? "home.html" : path.slice(1);
	if (file.includes("..")) {
		res.writeHead(400);
		res.end();
		return;
	}
	try {
		const source = await readFile(
			join(
				file === "cache-runtime.js" || file.startsWith("assets/")
					? build
					: root + "/deployment/public",
				file
			)
		);
		res.setHeader(
			"Content-Type",
			{
				".html": "text/html",
				".js": "application/javascript",
				".css": "text/css",
			}[extname(file)] || "application/octet-stream"
		);
		res.end(source);
	} catch {
		res.writeHead(404);
		res.end();
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
	const url = `http://localhost:${server.address().port}/`;
	await page.goto(url);
	assert.equal(await page.title(), "Scramjet 网页代理");
	await page.locator("#cache-settings summary").click();
	await page.locator("#cache-enabled:enabled").waitFor();
	const seeded = await page.evaluate(async () => {
		const { ResourceCache, gatewayCacheScope } = await import(
			"/cache-runtime.js"
		);
		const c = new ResourceCache({ scope: gatewayCacheScope });
		const { ticket } = await c.lookup({
			url: "https://fixture.test/app.js",
			topOrigin: "https://fixture.test",
			headers: new Headers(),
			credentials: "include",
			method: "GET",
			destination: "script",
			cache: "default",
		});
		await c
			.store(
				ticket,
				new Response("fixture", {
					headers: {
						"content-type": "application/javascript",
						"cache-control": "max-age=600",
					},
				})
			)
			.text();
		await c.idle();
		return (await c.usage()).entries;
	});
	assert.equal(seeded, 1);
	await page
		.getByRole("button", { name: "清理当前站点缓存", exact: true })
		.click();
	await page.locator("#cache-usage").filter({ hasText: "0 个资源" }).waitFor();
	await page.locator("#cache-enabled").uncheck();
	await page.locator("#cache-enabled:enabled").waitFor();
	await page.reload();
	await page.locator("#cache-settings summary").click();
	await page.locator("#cache-enabled:enabled").waitFor();
	assert.equal(await page.locator("#cache-enabled").isChecked(), false);
	await page.locator("#cache-enabled").check();
	await page.locator("#cache-enabled:enabled").waitFor();
	await page.screenshot({ path: out + "/portal-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: out + "/portal-mobile.png" });
	assert.equal(await page.locator("vite-error-overlay").count(), 0);
	await page.locator("#url").fill("https://example.com/path");
	await page
		.getByRole("button", { name: "本次绕过缓存打开", exact: true })
		.click();
	await page.waitForURL("**/?__scramjet_url=**");
	assert.equal(
		new URL(page.url()).searchParams.get("__scramjet_url"),
		"https://example.com/path"
	);
	assert.equal(
		await page.evaluate(() =>
			sessionStorage.getItem("__scramjet_cache_bypass")
		),
		"1"
	);
	assert.deepEqual(errors, []);
	const result = {
		title: "Scramjet 网页代理",
		controls: [
			"production runtime import",
			"clear seeded cache",
			"disable persists",
			"enable",
			"bypass target submission",
		],
		viewports: ["1280x720", "390x844"],
		errors,
	};
	await writeFile(out + "/portal-result.json", JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
} finally {
	await browser.close();
	server.closeAllConnections();
	server.close();
}
