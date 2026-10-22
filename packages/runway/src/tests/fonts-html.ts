import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Test } from "../testcommon.ts";
import { stopHttpFixture } from "../http-fixture.ts";

// CSS string decoding must not create HTML raw-text end tags on serialization.
const payload = String.raw`\3c /StYlE>\3c script>window.fontStyleEscape=1\3c /script>\3c style>`;
const css = `#probe::after{font-family:serif;content:"${payload}"}@media (width < 99999px){#probe{color:rgb(1,2,3)}}`;
const html = `<!doctype html><html><head><style>${css}</style></head><body><h1 id="probe">Font serialization</h1></body></html>`;
let server: http.Server;
const test: Test = {
	name: "fonts-html-raw-text",
	port: 0,
	scramjetOnly: true,
	reloadHarness: true,
	async start() {
		server = http.createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(html);
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
		await ctx.page.evaluate(() => {
			(window as any).__runwayController.scramjetConfig.environment = {
				protectFonts: true,
			};
		});
		const reference = await ctx.page.context().browser()!.newContext();
		try {
			const page = await reference.newPage();
			await page.setContent(html);
			const snapshot = () => ({
				escaped: (window as any).fontStyleEscape ?? null,
				content: getComputedStyle(
					document.querySelector("#probe")!,
					"::after"
				).content,
				color: getComputedStyle(document.querySelector("#probe")!).color,
			});
			const expected = await page.evaluate(snapshot);
			assert.equal(expected.escaped, null);
			await ctx.navigate(`http://127.0.0.1:${test.port}/`);
			await ctx.frame.locator("#probe").waitFor();
			const frame = ctx.page
				.frames()
				.find((f) => f.url().includes("/~/sj/"))!;
			assert.deepEqual(await frame.evaluate(snapshot), expected);
			// innerHTML uses the same HTML rewriting path; compare structure as scripts
			// inserted through innerHTML are inert even when serialization is vulnerable.
			const dynamic = await frame.evaluate((css) => {
				const box = document.createElement("div");
				box.innerHTML = `<style>${css}</style><b>tail</b>`;
				document.body.append(box);
				return {
					scripts: box.querySelectorAll("script").length,
					styles: box.querySelectorAll("style").length,
				};
			}, css);
			assert.deepEqual(dynamic, { scripts: 0, styles: 1 });
		} finally {
			await reference.close();
		}
	},
};
export default [test];
