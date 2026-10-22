import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Test } from "../testcommon.ts";
import { stopHttpFixture } from "../http-fixture.ts";

const bytes = readFileSync(
	new URL("../../../core/assets/fonts/Twemoji.Mozilla.ttf", import.meta.url)
).toString("base64");

function canvasSnapshot(reference = false) {
	const canvas = new OffscreenCanvas(250, 80);
	const ctx = canvas.getContext("2d")!;
	ctx.font = '40px "PingFang SC", serif';
	const width = ctx.measureText("mmmmmmmmmmlli中文😀").width;
	ctx.font = reference
		? '40px "Scramjet Twemoji 14", serif'
		: '40px "Apple Color Emoji", serif';
	ctx.fillText("😀🇺🇸👩‍💻", 0, 50);
	const data = ctx.getImageData(0, 0, 250, 80).data;
	let hash = 2166136261;
	for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
	return { width, hash, timezone: new Date(0).getTimezoneOffset() };
}

export default [true, false].map((protectFonts): Test => {
	let server: http.Server;
	const test: Test = {
		name: `fonts-${protectFonts ? "protected" : "native"}`,
		port: 0,
		scramjetOnly: true,
		reloadHarness: true,
		async start() {
			server = http.createServer((req, res) => {
				if (req.url === "/worker.js") {
					res.setHeader("content-type", "application/javascript");
					res.end(`postMessage((${canvasSnapshot.toString()})())`);
				} else if (req.url === "/fixture.ttf") {
					res.setHeader("content-type", "font/ttf");
					res.end(Buffer.from(bytes, "base64"));
				} else if (req.url === "/fonts.css") {
					res.setHeader("content-type", "text/css");
					res.end("#external {font-family:'STSong', serif}");
				} else {
					res.setHeader("content-type", "text/html");
					res.end(`<!doctype html><html><head><link rel="stylesheet" href="/fonts.css"><style>
      #inline,#escaped {display:block;width:max-content}
      #inline {font-family: 'PingFang SC', monospace;}
      #escaped {font-family: PingFang\\20 SC, monospace;}
      #pseudo::after {content:'PingFang SC';font-family:'Microsoft YaHei',monospace;}
      @font-face {font-family: Alias;src:local('Arial');}
     </style></head><body><h1>Fonts</h1>
      <span id="inline">mmmmmmmmmmlli中文😀</span><span id="escaped">mmmmmmmmmmlli中文😀</span><span id="pseudo"></span>
      <svg><text id="svg" font-family="STSong">text</text></svg>
      <span id="external">external CSS</span>
     </body></html>`);
				}
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve)
			);
			test.port = (server.address() as AddressInfo).port;
		},
		async stop() {
			await stopHttpFixture(server);
		},
		async playwrightFn(ctx) {
			await ctx.page.evaluate((protectFonts) => {
				(window as any).__runwayController.scramjetConfig.environment = {
					protectFonts,
					timezone: "Asia/Tokyo",
				};
			}, protectFonts);
			await ctx.navigate(`http://127.0.0.1:${test.port}/`);
			await ctx.frame.locator("h1").waitFor();
			const frame = ctx.page
				.frames()
				.find((f) => f.url().includes("/~/sj/"))!;
			const result = await frame.evaluate(async () => {
				const span = document.createElement("span");
				document.body.append(span);
				span.style.fontFamily = '"微软雅黑", monospace';
				const property = span.style.fontFamily;
				span.style.fontFamily = "";
				const cleared = span.style.fontFamily;
				span.style.setProperty(
					"font-family",
					'"Hiragino Sans GB", monospace'
				);
				const setProperty = span.style.fontFamily;
				span.style.cssText = 'font:italic 16px "STHeiti", monospace';
				const cssText = span.style.fontFamily;
				const sheet = new CSSStyleSheet();
				sheet.insertRule('.x {font-family: "PingFang TC", serif}');
				const rule = (sheet.cssRules[0] as CSSStyleRule).style.fontFamily;
				const face = new FontFace("LocalProbe", 'local("Arial")');
				let localLoaded = false;
				try {
					await face.load();
					localLoaded = true;
				} catch {}
				const remote = new FontFace(
					"RemoteProbe",
					'local("UnavailableFixtureFont"), url("/fixture.ttf")'
				);
				await remote.load();
				const fonts = [...document.fonts].map((f) => ({
					family: f.family.replace(/^"|"$/g, ""),
					status: f.status,
				}));
				const localFonts =
					typeof (window as any).queryLocalFonts === "function"
						? await (window as any).queryLocalFonts().then(
								(x: any[]) => x.length,
								() => -1
							)
						: null;
				const canvas = document.createElement("canvas").getContext("2d")!;
				const widths = [
					"PingFang SC",
					"Hiragino Sans GB",
					"STHeiti",
					"STSong",
					"Microsoft YaHei",
					"微软雅黑",
					"苹方",
					"PingFang\\20 SC",
					"NonexistentFixtureFont",
				].map((f) => {
					canvas.font = `16px "${f}", monospace`;
					return canvas.measureText("mmmmmmmmmmlli中文").width;
				});
				const baseline = document.createElement("span");
				baseline.textContent = "mmmmmmmmmmlli中文😀";
				baseline.style.fontFamily =
					'"Scramjet Twemoji 14", "Scramjet Unavailable Font", monospace';
				baseline.style.display = "block";
				baseline.style.width = "max-content";
				document.body.append(baseline);
				const domWidths = ["inline", "escaped"].map(
					(id) => document.getElementById(id)!.getBoundingClientRect().width
				);
				const baselineWidth = baseline.getBoundingClientRect().width;
				const check =
					document.fonts.check('16px "PingFang SC"') ===
					document.fonts.check('16px "NonexistentFixtureFont"');
				let aliasLoaded = false;
				try {
					await document.fonts.load("16px Alias");
					aliasLoaded = true;
				} catch {}
				const family = (id: string) =>
					getComputedStyle(document.getElementById(id)!).fontFamily;
				return {
					cleared,
					remote: remote.status,
					domWidths,
					baselineWidth,
					check,
					aliasLoaded,
					property,
					setProperty,
					cssText,
					rule,
					localLoaded,
					fonts,
					localFonts,
					widths,
					inline: family("inline"),
					escaped: family("escaped"),
					svg: family("svg"),
					external: family("external"),
					content: getComputedStyle(
						document.getElementById("pseudo")!,
						"::after"
					).content,
				};
			});
			if (protectFonts) {
				for (const key of [
					"property",
					"setProperty",
					"cssText",
					"rule",
					"inline",
					"escaped",
					"svg",
					"external",
				] as const) {
					assert.match(result[key], /Scramjet Twemoji 14/, key);
					assert.match(result[key], /Scramjet Unavailable Font/, key);
				}
				assert.equal(result.localLoaded, false);
				assert.equal(result.aliasLoaded, false);
				assert.equal(result.check, true);
				for (const width of result.domWidths)
					assert.equal(width, result.baselineWidth);
				assert.ok(
					result.fonts.some(
						(f) => f.family === "Scramjet Twemoji 14" && f.status === "loaded"
					)
				);
				if (result.localFonts !== null) assert.equal(result.localFonts, 0);
				for (const width of result.widths)
					assert.equal(width, result.widths.at(-1));
			} else {
				assert.match(result.property, /微软雅黑/);
				assert.ok(
					!result.fonts.some((f) => f.family === "Scramjet Twemoji 14")
				);
			}
			assert.equal(result.cleared, "");
			assert.equal(result.remote, "loaded");
			assert.equal(result.content, '"PingFang SC"');
			if (!protectFonts) return;
			const reference = await ctx.page
				.context()
				.browser()!
				.newContext({ timezoneId: "Asia/Tokyo" });
			try {
				const page = await reference.newPage();
				await page.evaluate(async (bytes) => {
					const face = new FontFace(
						"Scramjet Twemoji 14",
						Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
						{
							unicodeRange:
								"U+200D,U+20E3,U+2300-23FF,U+2600-27BF,U+2B00-2BFF,U+FE0F,U+1F000-1FAFF,U+E0020-E007F",
						}
					);
					document.fonts.add(face);
					await face.loaded;
				}, bytes);
				const expected = await page.evaluate(canvasSnapshot, true);
				// The reference uses the same fallback after removing the restricted face.
				expected.width = await page.evaluate(() => {
					const c = new OffscreenCanvas(250, 80).getContext("2d")!;
					c.font =
						'40px "Scramjet Twemoji 14", "Scramjet Unavailable Font", serif';
					return c.measureText("mmmmmmmmmmlli中文😀").width;
				});
				assert.deepEqual(await frame.evaluate(canvasSnapshot), expected);
				const child = await frame.evaluate(() => {
					const f = document.createElement("iframe");
					document.body.append(f);
					return [...f.contentDocument!.fonts].map((x) => x.family.replace(/^"|"$/g, ""));
				});
				assert.ok(child.includes("Scramjet Twemoji 14"));
				if ((process.env.RUNWAY_BROWSER ?? "chromium") !== "firefox") {
					for (const type of ["classic", "module"] as const) {
						const worker = await frame.evaluate(
							(type) =>
								new Promise((resolve, reject) => {
									const w = new Worker("/worker.js", { type });
									const timer = setTimeout(() => {
										w.terminate();
										reject(Error("font worker timeout"));
									}, 10000);
									w.onmessage = (e) => {
										clearTimeout(timer);
										w.terminate();
										resolve(e.data);
									};
									w.onerror = (e) => {
										clearTimeout(timer);
										w.terminate();
										reject(Error(e.message));
									};
								}),
							type
						);
						assert.deepEqual(worker, expected);
					}
				}
			} finally {
				await reference.close();
			}
		},
	};
	return test;
});
