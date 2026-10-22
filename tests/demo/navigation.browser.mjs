import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import { chromium } from "../../packages/runway/node_modules/playwright/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const out =
	process.env.SCRAMJET_NAVIGATION_OUTPUT ||
	resolve(tmpdir(), "scramjet-navigation-browser");
await mkdir(out, { recursive: true });
process.env.VITE_PROXY_DOMAIN = "localhost";
const requests = [];
const fixtureTransport = `export default class FixtureTransport {
 ready=true;
 async init() {}
 async meta() {}
 async request(remote,method,body,headers) {
  const text=body ? await new Response(body).text() : '';
  const res=await fetch('/__fixture',{method:'POST',body:JSON.stringify({url:remote.href,method,body:text,headers})});
  const value=await res.json();
  return {body:new TextEncoder().encode(value.body).buffer,headers:value.headers,status:value.status,statusText:'OK'};
 }
}`;
const vite = await createServer({
	root: root + "/packages/demo",
	configFile: root + "/packages/demo/vite.config.ts",
	cacheDir: out + "/vite-cache",
	resolve: {
		alias: [
			{
				find: "@mercuryworkshop/libcurl-transport",
				replacement: "\0fixture-transport",
			},
		],
	},
	plugins: [
		{
			name: "fixture-transport",
			resolveId(id) {
				if (id === "\0fixture-transport") return id;
			},
			load(id) {
				if (id === "\0fixture-transport") return fixtureTransport;
			},
			configureServer(server) {
				server.middlewares.use("/__fixture", async (req, res) => {
					let text = "";
					for await (const chunk of req) text += chunk;
					const request = JSON.parse(text);
					requests.push(request);
					const url = new URL(request.url);
					const headers = [["Content-Type", "text/html; charset=utf-8"]];
					if (url.pathname === "/start" || url.pathname === "/seed") {
						headers.push([
							"Set-Cookie",
							"shared=keep; Domain=example.com; Path=/; SameSite=Lax; HttpOnly",
						]);
						headers.push([
							"Set-Cookie",
							"strict=private; Domain=example.com; Path=/; SameSite=Strict; HttpOnly",
						]);
						headers.push([
							"Set-Cookie",
							"sourceOnly=private; Path=/; SameSite=Lax; HttpOnly",
						]);
					}
					const body = `<!doctype html><title>Navigation fixture</title><h1 id="path">${url.host}${url.pathname}${url.search}</h1>
  <a id="cross" href="https://accounts.example.com/login?next=%2Fhome#part">Cross</a>
  <a id="port" href="https://accounts.example.com:9443/test/?q=port">Port</a>
  <a id="other" href="https://unrelated.test/home">Unrelated</a>
  <a id="nested" href="/nested">Nested page</a>
  <a id="reserved" href="/assets/page.html">Reserved</a>
  <a id="http" href="http://accounts.example.com/plain">HTTP</a>
  <a id="popup" target="_blank" href="https://accounts.example.com:9443/popup">Popup</a>
  <a id="redirect" href="/redirect">Redirect</a>
  <form method="post" action="https://unrelated.test/posted"><input name="message" value="hello"><button id="submit">Submit</button></form>
  <button id="script" onclick="location.href='https://unrelated.test/scripted'">Script</button>
  ${url.pathname === "/nested" ? '<iframe src="https://unrelated.test/child"></iframe>' : ""}${url.pathname === "/source" ? '<iframe src="https://seed.example.com/seed"></iframe>' : ""}`;
					let status = 200;
					if (url.pathname === "/redirect") {
						status = 302;
						headers.push(["Location", "https://unrelated.test/redirected"]);
					}
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ status, headers, body }));
				});
			},
		},
	],
	server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const port = vite.httpServer.address().port;
const browser = await chromium.launch({
	channel: process.env.BROWSER_CHANNEL || "chrome",
	headless: true,
});
const context = await browser.newContext();
const errors = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
const page = await context.newPage();
page.setDefaultTimeout(15000);
const start = `http://www-example-com.localhost:${port}/start`;
const results = [];
async function reset() {
	await page.goto(start);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
}
try {
	await reset();
	await page.frameLocator("#app > iframe").locator("#cross").click();
	await page.waitForURL(
		`http://accounts-example-com.localhost:${port}/login?next=%2Fhome#part`
	);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	assert.equal(new URL(page.url()).searchParams.has("__scramjet_url"), false);
	let req = requests.find((r) =>
		r.url.startsWith("https://accounts.example.com/login?next=%2Fhome")
	);
	assert.ok(req, "destination requested");
	const cookies = req.headers
		.filter(([k]) => k.toLowerCase() === "cookie")
		.map(([, v]) => v)
		.join(";");
	assert.ok(cookies.includes("shared=keep"), cookies);
	assert.ok(!cookies.includes("sourceOnly"), cookies);
	await page.goBack();
	await page.waitForURL(start);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	await page.goForward();
	await page.waitForURL(
		`http://accounts-example-com.localhost:${port}/login?next=%2Fhome#part`
	);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	await page.reload();
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	results.push(
		"cross-host clean URL, fragment/query, scoped cookie transfer, refresh"
	);
	await page.frameLocator("#app > iframe").locator("#port").click();
	await page.waitForURL(
		`http://accounts-example-com-9443.localhost:${port}/test/?q=port`
	);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	await page.reload();
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	results.push("custom HTTPS target port and refresh");
	await reset();
	await page.frameLocator("#app > iframe").locator("#other").click();
	await page.waitForURL(`http://unrelated-test.localhost:${port}/home`);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	req = requests.find((r) => r.url === "https://unrelated.test/home");
	assert.equal(
		req.headers.some(
			([k, v]) => k.toLowerCase() === "cookie" && v.includes("shared=")
		),
		false
	);
	results.push("unrelated target receives no source cookies");
	await reset();
	await page.frameLocator("#app > iframe").locator("#submit").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "unrelated.test/posted" })
		.waitFor();
	await page.waitForFunction(
		() =>
			new URL(location.href).searchParams.get("__scramjet_url") ===
			"https://unrelated.test/posted"
	);
	assert.equal(new URL(page.url()).hostname, "www-example-com.localhost");
	assert.ok(
		requests.some(
			(r) =>
				r.url === "https://unrelated.test/posted" &&
				r.method === "POST" &&
				r.body === "message=hello"
		)
	);
	results.push("cross-host POST retains body and controller");
	await reset();
	await page.frameLocator("#app > iframe").locator("#nested").click();
	await page
		.frameLocator("#app > iframe")
		.frameLocator("iframe")
		.locator("#path")
		.waitFor();
	assert.equal(new URL(page.url()).hostname, "www-example-com.localhost");
	results.push("nested iframe navigation keeps top-level host");
	await page.frameLocator("#app > iframe").locator("#reserved").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "/assets/page.html" })
		.waitFor();
	assert.ok(page.url().includes("__scramjet_url="));
	await page.frameLocator("#app > iframe").locator("#http").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "/plain" })
		.waitFor();
	assert.ok(page.url().includes("__scramjet_url="));
	results.push("reserved paths and HTTP retain explicit fallback");
	await reset();
	const pop = page.waitForEvent("popup");
	await page.frameLocator("#app > iframe").locator("#popup").click();
	const popup = await pop;
	await popup.waitForURL(
		`http://accounts-example-com-9443.localhost:${port}/popup`
	);
	await popup.frameLocator("#app > iframe").locator("#path").waitFor();
	await popup.close();
	results.push("new tab uses clean custom-port hostname");
	await reset();
	await page.frameLocator("#app > iframe").locator("#redirect").click();
	await page.waitForURL(`http://unrelated-test.localhost:${port}/redirected`);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	results.push("cross-host server redirect");
	await reset();
	await page.frameLocator("#app > iframe").locator("#script").click();
	await page.waitForURL(`http://unrelated-test.localhost:${port}/scripted`);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	await page.goBack();
	await page.waitForURL(start);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	results.push("scripted cross-host navigation and back");
	await context.route("**/__scramjet_handoff?*", (route) => route.abort());
	await reset();
	await page.frameLocator("#app > iframe").locator("#other").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "unrelated.test/home" })
		.waitFor();
	assert.equal(new URL(page.url()).hostname, "www-example-com.localhost");
	assert.equal(
		new URL(page.url()).searchParams.get("__scramjet_url"),
		"https://unrelated.test/home"
	);
	await context.unroute("**/__scramjet_handoff?*");
	results.push("blocked handoff retains functional original controller");
	const source = `http://unrelated-test.localhost:${port}/source`;
	await page.goto(source);
	await page
		.frameLocator("#app > iframe")
		.frameLocator("iframe")
		.locator("#path")
		.waitFor();
	const offset = requests.length;
	await page.frameLocator("#app > iframe").locator("#cross").click();
	await page.waitForURL(
		`http://accounts-example-com.localhost:${port}/login?next=%2Fhome#part`
	);
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	req = requests
		.slice(offset)
		.find((r) => r.url.startsWith("https://accounts.example.com/login"));
	const crossCookies = req.headers
		.filter(([k]) => k.toLowerCase() === "cookie")
		.map(([, v]) => v)
		.join(";");
	// Destination storage retains its existing cookies; unrelated sources cannot import them.
	assert.ok(crossCookies.includes("shared=keep"), crossCookies);
	assert.ok(!crossCookies.includes("strict=private"), crossCookies);
	assert.ok(
		req.headers.some(
			([k, v]) => k.toLowerCase() === "sec-fetch-site" && v === "cross-site"
		)
	);
	assert.equal(
		requests
			.slice(offset)
			.filter((r) => r.url.startsWith("https://accounts.example.com/login"))
			.length,
		1
	);
	results.push(
		"cross-site handoff retains Lax cookies and blocks Strict on first request"
	);
	await page.screenshot({ path: out + "/navigation.png" });
	assert.deepEqual(errors, []);
	await writeFile(
		out + "/result.json",
		JSON.stringify({ results, errors, requests }, null, 2)
	);
	console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
	await writeFile(
		out + "/failure.json",
		JSON.stringify(
			{
				results,
				errors,
				requests,
				url: page.url(),
				frames: page.frames().map((f) => f.url()),
			},
			null,
			2
		)
	);
	await page.screenshot({ path: out + "/failure.png" });
	console.error(error);
	process.exitCode = 1;
} finally {
	await browser.close();
	await vite.close();
}
