import assert from "node:assert/strict";
import { webrtcPageHtml, webrtcTest } from "./helpers.ts";

const CREDENTIALS_URL =
	process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081/turn-credentials";

export default [
	webrtcTest({
		name: "webrtc-credentials-client-fetch",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [],
			credentialEndpoint: CREDENTIALS_URL,
			failClosed: true,
			diagnostics: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(async () => {
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					setTimeout(done.resolve, ms);
					return done.promise;
				};
				let lastError = "";
				for (let attempt = 0; attempt < 50; attempt += 1) {
					try {
						const pc = new RTCPeerConnection();
						const config = pc.getConfiguration();
						const urls = (config.iceServers ?? []).flatMap((server) =>
							Array.isArray(server.urls) ? server.urls : [server.urls]
						);
						pc.close();
						return { policy: config.iceTransportPolicy, urls, lastError };
					} catch (error) {
						lastError = String(error);
						await tick(100);
					}
				}
				throw new Error(`credentials never resolved: ${lastError}`);
			});
			assert.equal(result.policy, "relay");
			assert.ok(result.urls.length > 0, "no TURN URLs from the client fetch");
			assert.ok(result.urls.every((url) => /^turns?:/.test(url)));
		},
	}),

	webrtcTest({
		name: "webrtc-credentials-controller-prefetch",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [],
			credentialEndpoint: CREDENTIALS_URL,
			failClosed: true,
			diagnostics: true,
		},
		async preparePage(page) {
			await page.evaluate(() => {
				const harnessWindow = window as unknown as {
					__runwayRefreshWebrtcCredentials?: () => Promise<void>;
				};
				if (
					typeof harnessWindow.__runwayRefreshWebrtcCredentials !== "function"
				) {
					throw new Error("harness does not expose credential prefetch");
				}
				return harnessWindow.__runwayRefreshWebrtcCredentials();
			});
		},
		async fn(ctx, frame) {
			const controllerServers = await ctx.page.evaluate(() => {
				const harnessWindow = window as unknown as {
					__runwayController?: {
						scramjetConfig: { webrtc: { iceServers: unknown[] } };
					};
				};
				return harnessWindow.__runwayController?.scramjetConfig.webrtc
					.iceServers.length;
			});
			assert.ok(
				typeof controllerServers === "number" && controllerServers > 0,
				"controller did not prefetch credentials"
			);

			const result = await frame.evaluate(() => {
				const pc = new RTCPeerConnection();
				const config = pc.getConfiguration();
				const urls = (config.iceServers ?? []).flatMap((server) =>
					Array.isArray(server.urls) ? server.urls : [server.urls]
				);
				pc.close();
				return { policy: config.iceTransportPolicy, urls };
			});
			assert.equal(result.policy, "relay");
			assert.ok(result.urls.length > 0, "no prefetched TURN URLs");
			assert.ok(result.urls.every((url) => /^turns?:/.test(url)));
		},
	}),
];
