import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Frame, Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { stopHttpFixture } from "../../http-fixture.ts";
import {
	runwayTestTargetUrl,
	type Test,
	type TestContext,
} from "../../testcommon.ts";

export type WebrtcTestConfig = {
	mode?: "off" | "relay" | "enforced";
	iceServers?: Array<{
		urls: string | string[];
		username?: string;
		credential?: string;
	}>;
	credentialEndpoint?: string | null;
	iceServersExpiresAt?: number | null;
	credentialRefreshRatio?: number;
	failClosed?: boolean;
	diagnostics?: boolean;
	networkIsolationVerified?: boolean;
};

export const DEFAULT_WEBRTC_OFF: WebrtcTestConfig = {
	mode: "off",
	iceServers: [],
	credentialEndpoint: null,
	iceServersExpiresAt: null,
};

type WebrtcTestOptions = {
	name: string;
	browsers?: string[];
	html: string | ((url: URL) => string);
	hostname?: string;
	cleartextHosts?: string[];
	scheme?: "http" | "https";
	config: WebrtcTestConfig;
	fn: (ctx: TestContext, frame: Frame) => Promise<void>;
	/**
	 * Start an auxiliary signaling server and return its port. The target HTML
	 * may reference it as `{{SIGNAL_PORT}}`.
	 */
	onServer?: () => number | Promise<number> | void;
	/** Close auxiliary servers before the target server shuts down. */
	onStop?: () => Promise<void> | void;
	/** Resolve credentials or other fixtures before the browser navigates. */
	prepare?: () => Promise<void>;
	/** Configure the harness page after the WebRTC policy is set. */
	preparePage?: (page: Page) => Promise<void>;
};

function findProxiedFrame(page: Page): Frame | undefined {
	return page
		.frames()
		.find(
			(frame) =>
				frame.url().includes("/~/sj/") &&
				!frame.url().includes("/runway-cleartext")
		);
}

export async function waitForProxiedFrame(page: Page): Promise<Frame> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const frame = findProxiedFrame(page);
		if (frame) {
			try {
				await frame.waitForFunction(
					"window.__webrtcTestPage === true",
					undefined,
					{ timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) }
				);
				return frame;
			} catch {
				// The frame exists but the document is still loading.
			}
		}
		await sleep(100);
	}
	const status = await page
		.locator("#status")
		.textContent()
		.catch(() => null);
	throw new Error(
		`timed out waiting for the proxied test frame: status=${status} frames=${JSON.stringify(
			page.frames().map((frame) => frame.url())
		)}`
	);
}

/**
 * A Playwright test whose target page is served locally but loaded through the
 * Scramjet harness. The controller's WebRTC policy is set before navigation so
 * every injected realm receives the intended snapshot.
 */
function setHarnessWebrtcConfig(page: Page, config: WebrtcTestConfig) {
	return page.evaluate((value) => {
		// Harness-only global installed by harness/scramjet/public/index.html.
		const harnessWindow = window as unknown as {
			__runwaySetWebrtcConfig?: (config: unknown) => void;
		};
		if (typeof harnessWindow.__runwaySetWebrtcConfig !== "function") {
			throw new Error("runway harness does not expose __runwaySetWebrtcConfig");
		}
		harnessWindow.__runwaySetWebrtcConfig(value);
	}, config);
}

export function webrtcTest(options: WebrtcTestOptions): Test {
	let server: http.Server;
	const test: Test = {
		name: options.name,
		browsers: options.browsers,
		hostname: options.hostname,
		cleartextHosts: options.cleartextHosts,
		scheme: options.scheme,
		port: 0,
		scramjetOnly: true,
		async start() {
			const { promise, resolve } = Promise.withResolvers<void>();
			let signalPort = 0;
			server = http.createServer((req, res) => {
				if (process.env.RUNWAY_WEBRTC_DEBUG === "1") {
					console.log("[webrtc test server request]", req.method, req.url);
				}
				const html =
					typeof options.html === "function"
						? options.html(new URL(req.url ?? "/", "http://localhost"))
						: options.html;
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(html.replaceAll("{{SIGNAL_PORT}}", String(signalPort)));
			});
			server.listen(0, "0.0.0.0", () => {
				test.port = (server.address() as AddressInfo).port;
				if (process.env.RUNWAY_WEBRTC_DEBUG === "1") {
					console.log("[webrtc test server listening]", server.address());
				}
				resolve();
			});
			await promise;
			signalPort = (await options.onServer?.()) ?? 0;
			await options.prepare?.();
		},
		async stop() {
			try {
				await options.onStop?.();
			} finally {
				await stopHttpFixture(server);
			}
		},
		async playwrightFn(ctx: TestContext) {
			if (process.env.RUNWAY_WEBRTC_DEBUG === "1") {
				ctx.page.on("console", (message) =>
					console.log(`[webrtc harness ${message.type()}]`, message.text())
				);
				ctx.page.on("pageerror", (error) =>
					console.log("[webrtc harness pageerror]", error.message)
				);
				ctx.page.on("requestfailed", (request) =>
					console.log(
						"[webrtc harness requestfailed]",
						request.url(),
						request.failure()?.errorText
					)
				);
			}
			await setHarnessWebrtcConfig(ctx.page, options.config);
			await options.preparePage?.(ctx.page);
			const targetHost = process.env.RUNWAY_TEST_HOST ?? "localhost";
			for (const frame of ctx.page.frames()) {
				if (frame.url().includes("/~/sj/")) {
					await frame
						.evaluate(() => {
							// Test marker set by webrtcPageHtml.
							const pageWindow = window as unknown as {
								__webrtcTestPage?: boolean;
							};
							pageWindow.__webrtcTestPage = false;
						})
						.catch(() => {});
				}
			}
			try {
				const targetUrl = process.env.RUNWAY_TEST_HOST
					? `http://${targetHost}:${test.port}/`
					: runwayTestTargetUrl(test);
				await ctx.navigate(targetUrl);
				const frame = await waitForProxiedFrame(ctx.page);
				await options.fn(ctx, frame);
			} finally {
				await setHarnessWebrtcConfig(ctx.page, DEFAULT_WEBRTC_OFF).catch(
					() => {}
				);
			}
		},
	};
	return test;
}

export function webrtcPageHtml(extra = ""): string {
	return `<!doctype html>
<html>
	<head><script>window.__webrtcTestPage = true;</script></head>
	<body>${extra}</body>
</html>`;
}
