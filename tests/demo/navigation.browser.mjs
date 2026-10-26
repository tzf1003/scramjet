import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import {
	chromium,
	firefox,
	webkit,
} from "../../packages/runway/node_modules/playwright/index.mjs";
const engineName = process.env.SCRAMJET_TEST_BROWSER || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
assert.ok(engine, `unknown SCRAMJET_TEST_BROWSER ${engineName}`);

const root = resolve(import.meta.dirname, "../..");
const out =
	process.env.SCRAMJET_NAVIGATION_OUTPUT ||
	resolve(tmpdir(), "scramjet-navigation-browser");
await mkdir(out, { recursive: true });
process.env.VITE_PROXY_DOMAIN = "localhost";
process.env.VITE_GATEWAY_HOST = "my.localhost";
process.env.VITE_GATEWAY_ACCESS = "1";
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
				server.middlewares.use("/api/config", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ webrtc: { mode: "off", iceServers: [] } }));
				});
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
							"poison=blocked; Domain=com; Path=/; SameSite=None; Secure",
						]);
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
					if (url.pathname.startsWith("/files/")) {
						// downloads: a plain file, and one the server names itself
						const attached = url.pathname === "/files/attached.md";
						res.setHeader("Content-Type", "application/json");
						res.end(
							JSON.stringify({
								status: 200,
								headers: [
									["Content-Type", "text/markdown; charset=utf-8"],
									...(attached
										? [
												[
													"Content-Disposition",
													'attachment; filename="server.md"',
												],
											]
										: []),
								],
								body: attached ? "# attached\n" : "# plain\n",
							})
						);
						return;
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
  <a id="dl-plain" href="/files/plain.md" download>Download</a>
  <a id="dl-named" href="/files/attached.md" download="asked.md">Download named</a>
  <button id="dl-late" onclick="const a=document.createElement('a');a.href='/files/stale.md';a.download='';a.onclick=()=>{a.href='/files/fresh.md'};a.click()">Download late</button>
  <button id="dl-flat" onclick="document.getElementById('dl-plain').dispatchEvent(new MouseEvent('click',{cancelable:true}))">Download flat</button>
  <a id="dl-live" href="/files/stale.md" download onclick="this.href='/files/fresh2.md'">Download live</a>
  <div onclick="event.stopPropagation()"><a id="dl-stop" href="/files/stale.md" download onclick="this.href='/files/fresh3.md'">Download stopped</a></div>
  <map name="m"><area id="dl-area" shape="rect" coords="0,0,200,200" href="/files/area.md" download></map>
  <img usemap="#m" width="200" height="200" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'/%3E">
  <button id="dl-blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['# made in the page\\n']));a.download='made.md';document.body.append(a);a.click()">Download blob</button>
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
const browser = await engine.launch({
	...(engineName === "chromium" && {
		channel: process.env.BROWSER_CHANNEL || "chrome",
	}),
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
async function crossFromForeignShell() {
	const offset = requests.length;
	await page.frameLocator("#app > iframe").locator("#cross").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "accounts.example.com/login" })
		.waitFor();
	assert.equal(new URL(page.url()).hostname, "www-example-com.localhost");
	assert.equal(
		new URL(page.url()).searchParams.get("__scramjet_url"),
		"https://accounts.example.com/login?next=%2Fhome#part"
	);
	const request = requests
		.slice(offset)
		.find((r) => r.url.startsWith("https://accounts.example.com/login"));
	assert.ok(request);
	assert.ok(
		!request.headers.some(
			([k, v]) => k.toLowerCase() === "cookie" && v.includes("strict=private")
		)
	);
	assert.ok(
		request.headers.some(
			([k, v]) => k.toLowerCase() === "sec-fetch-site" && v === "cross-site"
		)
	);
}
try {
	await reset();
	const frame = await (
		await page.locator("#app > iframe").elementHandle()
	).contentFrame();
	const uploadOffset = requests.length;
	await frame.evaluate(async () => {
		const form = new FormData();
		form.append(
			"file",
			new File(["A".repeat(5000)], "pic.png", { type: "image/png" })
		);
		form.append("client_upload_id", "abc");
		const res = await fetch("/upload", { method: "POST", body: form });
		await res.text();
		// wrappers such as Datadog's hand fetch a ready-made Request instead
		const form2 = new FormData();
		form2.append(
			"file",
			new File(["B".repeat(5000)], "pic2.png", { type: "image/png" })
		);
		const res2 = await fetch(
			new Request("/upload", { method: "POST", body: form2 })
		);
		await res2.text();
		// and uploads with progress events go through XMLHttpRequest
		const form3 = new FormData();
		form3.append(
			"file",
			new File(["C".repeat(5000)], "pic3.png", { type: "image/png" })
		);
		await new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", "/upload");
			xhr.onload = resolve;
			xhr.onerror = reject;
			xhr.send(form3);
		});
	});
	const upload = requests
		.slice(uploadOffset)
		.find((r) => r.url === "https://www.example.com/upload");
	assert.ok(upload, "file upload requested");
	const contentType = upload.headers.find(
		([k]) => k.toLowerCase() === "content-type"
	)[1];
	const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(
		contentType
	)?.[1];
	assert.ok(boundary, contentType);
	assert.ok(upload.body.includes(`--${boundary}`));
	assert.ok(upload.body.includes('filename="pic.png"'));
	assert.ok(
		upload.body.includes("A".repeat(5000)),
		`file content missing from ${upload.body.length} byte body`
	);
	assert.ok(upload.body.includes('name="client_upload_id"'));
	const upload2 = requests
		.slice(uploadOffset)
		.filter((r) => r.url === "https://www.example.com/upload")[1];
	assert.ok(upload2, "Request upload requested");
	assert.ok(
		upload2.body.includes("B".repeat(5000)),
		`Request file content missing from ${upload2.body.length} byte body`
	);
	const upload3 = requests
		.slice(uploadOffset)
		.filter((r) => r.url === "https://www.example.com/upload")[2];
	assert.ok(upload3, "XHR upload requested");
	assert.ok(
		upload3.body.includes("C".repeat(5000)),
		`XHR file content missing from ${upload3.body.length} byte body`
	);
	results.push("file upload keeps its content and multipart boundary");
	// The browser saves a download link itself, without asking the service
	// worker, so the proxy URL it would be given leads to the loader page.
	const saveFrom = async (selector, position) => {
		const [saved] = await Promise.all([
			page.waitForEvent("download"),
			page.frameLocator("#app > iframe").locator(selector).click({ position }),
		]);
		return {
			name: saved.suggestedFilename(),
			text: await readFile(await saved.path(), "utf8"),
		};
	};
	assert.deepEqual(await saveFrom("#dl-plain"), {
		name: "plain.md",
		text: "# plain\n",
	});
	assert.deepEqual(await saveFrom("#dl-named"), {
		name: "server.md",
		text: "# attached\n",
	});
	assert.deepEqual(await saveFrom("#dl-blob"), {
		name: "made.md",
		text: "# made in the page\n",
	});
	// a click handler may still change where the link points
	assert.deepEqual(await saveFrom("#dl-late"), {
		name: "fresh.md",
		text: "# plain\n",
	});
	assert.deepEqual(await saveFrom("#dl-flat"), {
		name: "plain.md",
		text: "# plain\n",
	});
	assert.deepEqual(await saveFrom("#dl-live"), {
		name: "fresh2.md",
		text: "# plain\n",
	});
	assert.deepEqual(await saveFrom("#dl-stop"), {
		name: "fresh3.md",
		text: "# plain\n",
	});
	assert.deepEqual(await saveFrom("img[usemap]", { x: 50, y: 50 }), {
		name: "area.md",
		text: "# plain\n",
	});
	results.push("download links save the file, not the proxy loader page");
	if (process.env.SCRAMJET_NAVIGATION_FOCUS === "upload") {
		console.log(JSON.stringify({ results, errors }, null, 2));
		await browser.close();
		await vite.close();
		process.exit(0);
	}
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
	assert.ok(!cookies.includes("poison="), cookies);
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
	await crossFromForeignShell();
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
	await crossFromForeignShell();
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
	for (const referrer of ["", "https://accounts.example.com/private"]) {
		await page.goto(source);
		await page.frameLocator("#app > iframe").locator("#path").waitFor();
		const attackOffset = requests.length;
		await page.evaluate(
			async ({ port, referrer }) => {
				const { prepareHandoff } = await import("/src/handoff.ts");
				const destination = new URL(
					`http://accounts-example-com.localhost:${port}/attack`
				);
				const ready = await prepareHandoff(destination, {
					source: location.origin,
					target: "https://accounts.example.com/attack",
					cookies: "{}",
					referrer,
					initiator: "https://accounts.example.com",
					fetchSite: "same-origin",
					crossSiteRedirect: false,
					createdAt: Date.now(),
				});
				if (!ready) throw new Error("Attack fixture handoff was not accepted");
				location.assign(destination);
			},
			{ port, referrer }
		);
		await page.waitForURL(
			`http://accounts-example-com.localhost:${port}/attack`
		);
		await page.frameLocator("#app > iframe").locator("#path").waitFor();
		const attack = requests
			.slice(attackOffset)
			.find((r) => r.url === "https://accounts.example.com/attack");
		assert.ok(attack);
		assert.ok(
			!attack.headers.some(
				([k, v]) => k.toLowerCase() === "cookie" && v.includes("strict=private")
			)
		);
		assert.ok(
			!attack.headers.some(
				([k, v]) =>
					k.toLowerCase() === "referer" &&
					v.startsWith("https://accounts.example.com")
			)
		);
		assert.ok(
			attack.headers.some(
				([k, v]) => k.toLowerCase() === "sec-fetch-site" && v === "cross-site"
			)
		);
	}
	results.push(
		"forged handoff metadata and empty referrer preserve cross-site cookie restrictions"
	);
	for (const target of [
		"https://unrelated.test/source",
		"http://unrelated.test/source",
	]) {
		const fallback = new URL(start);
		fallback.searchParams.set("__scramjet_url", target);
		await page.goto(fallback.href);
		await page.frameLocator("#app > iframe").locator("#path").waitFor();
		await crossFromForeignShell();
	}
	results.push(
		"foreign explicit targets retain their controller and actual cross-site context"
	);
	const portal = new URL(`http://my.localhost:${port}/`);
	portal.searchParams.set(
		"__scramjet_url",
		"https://example.com/start?q=portal#part"
	);
	await page.goto(portal.href);
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "example.com/start?q=portal" })
		.waitFor();
	assert.equal(new URL(page.url()).hostname, "my.localhost");
	await page.reload();
	await page.frameLocator("#app > iframe").locator("#path").waitFor();
	await page.frameLocator("#app > iframe").locator("#other").click();
	await page
		.frameLocator("#app > iframe")
		.locator("#path")
		.filter({ hasText: "unrelated.test/home" })
		.waitFor();
	assert.equal(new URL(page.url()).hostname, "my.localhost");
	assert.equal(
		new URL(page.url()).searchParams.get("__scramjet_url"),
		"https://unrelated.test/home"
	);
	results.push(
		"separate portal hostname retains explicit targets across refresh and navigation"
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
