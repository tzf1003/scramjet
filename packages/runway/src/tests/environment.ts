import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Test } from "../testcommon.ts";
import { stopHttpFixture } from "../http-fixture.ts";

function snapshot() {
	const dates = [
		"2026-01-01T00:00:00Z",
		"2026-07-01T00:00:00Z",
		"2026-03-08T06:30:00Z",
		"2026-11-01T05:30:00Z",
	].map((value) => {
		const d = new Date(value);
		const changed = new Date(value);
		changed.setHours(2, 30);
		return [
			d.getTime(),
			d.toString(),
			d.toDateString(),
			d.toTimeString(),
			d.getTimezoneOffset(),
			d.getFullYear(),
			d.getMonth(),
			d.getDate(),
			d.getDay(),
			d.getHours(),
			d.toLocaleString(),
			d.toLocaleDateString(),
			d.toLocaleTimeString(),
			changed.toISOString(),
		];
	});
	const setters = [
		"setFullYear",
		"setMonth",
		"setDate",
		"setHours",
		"setMinutes",
		"setSeconds",
		"setMilliseconds",
		"setYear",
	].map((name) =>
		[0, NaN, Date.parse("2026-03-08T06:30:00Z")].map((time) => {
			const date = new Date(time);
			const result = (date as any)[name](name === "setFullYear" ? 2026 : 1);
			return [result, date.getTime()];
		})
	);
	return {
		setters,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		locale: new Intl.DateTimeFormat().resolvedOptions().locale,
		constructorTimezone: new (Intl.DateTimeFormat.prototype
			.constructor as typeof Intl.DateTimeFormat)().resolvedOptions()
			.timeZone,
		language: navigator.language,
		languages: [...navigator.languages],
		dates,
		construction: [
			new Date(2026, 0, 1).toISOString(),
			new Date(26, 0, 1).toISOString(),
			new Date("2026-01-01T00:00:00").toISOString(),
			new Date("2026-01-01").toISOString(),
			new Date("January 1, 2026 00:00:00").toISOString(),
			new Date({
				valueOf() {
					return "2026-01-01T00:00:00";
				},
			} as any).toISOString(),
			new (Date.prototype.constructor as DateConstructor)(
				2026,
				0,
				1
			).toISOString(),
			new Date(2026, 2, 8, 2, 30).toISOString(),
			new Date(2026, 10, 1, 1, 30).toISOString(),
			Date.parse("2026-01-01T00:00:00"),
		],
		explicit: new Intl.DateTimeFormat(
			"de-DE",
			Object.create({ timeZone: "UTC", year: "numeric", month: "long" })
		).format(0),
		undefinedZone: new Intl.DateTimeFormat(undefined, {
			timeZone: undefined,
		}).resolvedOptions().timeZone,
		number: (123456.78).toLocaleString(),
		lower: "I".toLocaleLowerCase(),
		invalid: new Date(NaN).toString(),
	};
}

const profiles = [
	{
		name: "timezone-only",
		config: { timezone: "UTC" },
		timezoneId: "UTC",
		locale: undefined,
	},
	{
		name: "locale-only",
		config: { locale: "tr-TR" },
		timezoneId: undefined,
		locale: "tr-TR",
	},
	{
		name: "japan",
		config: { timezone: "Asia/Tokyo", languages: ["ja-JP", "ja", "en"] },
		timezoneId: "Asia/Tokyo",
		locale: "ja-JP",
	},
	{
		name: "dst",
		config: { timezone: "America/New_York", locale: "en-US" },
		timezoneId: "America/New_York",
		locale: "en-US",
	},
	{
		name: "fractional",
		config: { timezone: "Asia/Kathmandu", locale: "en-GB" },
		timezoneId: "Asia/Kathmandu",
		locale: "en-GB",
	},
	{ name: "native", config: {}, timezoneId: undefined, locale: undefined },
];

export default profiles.map((profile) => {
	let server: http.Server;
	let receivedLanguage: string | undefined;
	const test: Test = {
		name: `environment-${profile.name}`,
		port: 0,
		scramjetOnly: true,
		reloadHarness: true,
		async start() {
			server = http.createServer((req, res) => {
				receivedLanguage = req.headers["accept-language"];
				if (req.url?.startsWith("/worker")) {
					res.setHeader("content-type", "application/javascript");
					res.end(`postMessage((${snapshot.toString()})())`);
				} else {
					res.setHeader("content-type", "text/html");
					res.end(
						`<!doctype html><script>window.environmentReady = true;</script><h1>Environment fixture</h1>`
					);
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
			if (profile.name === "japan") {
				const validation = await ctx.page.evaluate(() => {
					const api = (window as any).$scramjet;
					return {
						normalized: api.normalizeEnvironment({
							locale: "ja-jp",
							languages: ["ja", "ja-JP", "en"],
						}),
						errors: [
							{ timezone: "invalid/timezone" },
							{ locale: "invalid_locale" },
							{ languages: [] },
						].map((config) => {
							try {
								api.normalizeEnvironment(config);
								return false;
							} catch {
								return true;
							}
						}),
					};
				});
				assert.deepEqual(validation, {
					normalized: { locale: "ja-JP", languages: ["ja-JP", "ja", "en"] },
					errors: [true, true, true],
				});
			}
			await ctx.page.evaluate((config) => {
				(window as any).__runwayController.scramjetConfig.environment =
					config;
			}, profile.config);
			const browser = ctx.page.context().browser()!;
			const reference = await browser.newContext({
				timezoneId: profile.timezoneId,
				locale: profile.locale,
			});
			try {
				const page = await reference.newPage();
				const expected = await page.evaluate(snapshot);
				if (profile.locale) {
					expected.lower = await page.evaluate(
						(locale) => "I".toLocaleLowerCase(locale),
						profile.locale
					);
					expected.language = profile.locale;
					expected.languages =
						profile.name === "japan"
							? ["ja-JP", "ja", "en"]
							: [profile.locale];
					expected.locale = await page.evaluate(
						(locale) =>
							new Intl.DateTimeFormat(locale).resolvedOptions().locale,
						profile.locale
					);
				}
				await ctx.navigate(`http://127.0.0.1:${test.port}/`);
				await ctx.frame.locator("h1").waitFor();
				const frame = ctx.page
					.frames()
					.find((frame) => frame.url().includes("/~/sj/"))!;
				await frame.waitForFunction(
					() => (window as any).environmentReady === true
				);
				assert.deepEqual(await frame.evaluate(snapshot), expected);
				if (profile.locale)
					assert.equal(
						receivedLanguage,
						profile.name === "japan"
							? "ja-JP,ja;q=0.9,en;q=0.8"
							: profile.locale
					);
				assert.equal(
					await frame.evaluate(() => Object.isFrozen(navigator.languages)),
					true
				);
				if (profile.name === "japan") {
					const child = await frame.evaluate(() => {
						const iframe = document.createElement("iframe");
						document.body.append(iframe);
						const win = iframe.contentWindow!;
						return [
							win.navigator.language,
							new win.Intl.DateTimeFormat().resolvedOptions().timeZone,
							new win.Date(0).getTimezoneOffset(),
						];
					});
					assert.deepEqual(child, ["ja-JP", "Asia/Tokyo", -540]);
					// Firefox's existing workers-classic-scope control also times out
					// with an empty environment profile in this harness.
					if ((process.env.RUNWAY_BROWSER ?? "chromium") === "firefox")
						return;
					for (const type of ["classic", "module"] as const) {
						const worker = await frame.evaluate(
							(type) =>
								new Promise((resolve, reject) => {
									const worker = new Worker("/worker.js", { type });
									const timer = setTimeout(() => {
										worker.terminate();
										reject(new Error(`worker ${type} environment timeout`));
									}, 10000);
									worker.onmessage = (event) => {
										clearTimeout(timer);
										worker.terminate();
										resolve(event.data);
									};
									worker.onerror = (event) => {
										clearTimeout(timer);
										worker.terminate();
										reject(new Error(event.message));
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
