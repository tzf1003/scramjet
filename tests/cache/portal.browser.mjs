import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "../../packages/runway/node_modules/playwright/index.mjs";
const root = resolve(import.meta.dirname, "../..");
const out = process.env.SCRAMJET_CACHE_OUTPUT || "/tmp/scramjet-cache-tests";
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
		const source = await readFile(join(root + "/deployment/public", file));
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
	assert.equal(
		await page.locator("#cache-settings, .resource-cache").count(),
		0
	);
	assert.equal(
		await page.getByRole("button", { name: "打开网页", exact: true }).count(),
		1
	);
	await page.screenshot({ path: out + "/portal-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: out + "/portal-mobile.png" });
	assert.equal(await page.locator("vite-error-overlay").count(), 0);
	await page.locator("#url").fill("https://example.com/path");
	await page.getByRole("button", { name: "打开网页", exact: true }).click();
	await page.waitForURL("**/?__scramjet_url=**");
	assert.equal(
		new URL(page.url()).searchParams.get("__scramjet_url"),
		"https://example.com/path"
	);
	assert.deepEqual(errors, []);
	const result = {
		title: "Scramjet 网页代理",
		controls: ["target URL submission"],
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
