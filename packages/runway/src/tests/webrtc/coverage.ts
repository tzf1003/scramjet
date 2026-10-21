import assert from "node:assert/strict";
import http from "node:http";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	waitForProxiedFrame,
	type WebrtcTestConfig,
} from "./helpers.ts";
import {
	initializeDataPeer,
	negotiateDataPeers,
	expectDataEcho,
	readDataPeer,
	closeDataPeers,
} from "./peers.ts";

const enforced = process.env.WEBRTC_TEST_MODE === "enforced";
const realmConfig: WebrtcTestConfig = {
	mode: enforced ? "enforced" : "relay",
	iceServers: [],
	networkIsolationVerified: enforced,
};

const tests = [
	webrtcTest({
		name: "webrtc-relay-cross-origin-and-top-level-tabs",
		hostname: "a.test",
		cleartextHosts: ["b.test"],
		scheme: "https",
		html: (url) =>
			webrtcPageHtml(
				url.pathname === "/child"
					? "<script>window.cachedRTC=RTCPeerConnection;</script>"
					: '<iframe src="https://b.test/child"></iframe>'
			),
		config: realmConfig,
		async prepare() {
			const value = await fetchTurnCredentials();
			realmConfig.iceServers = [
				{
					urls: value.urls,
					username: value.username,
					credential: value.credential,
				},
			];
		},
		async fn(ctx, frame) {
			await frame.waitForFunction(
				() => !!document.querySelector("iframe")?.contentWindow
			);
			const child = frame.childFrames()[0];
			assert.ok(child, "the cross-origin child must exist");
			await child.waitForFunction("window.__webrtcTestPage === true");
			const policies = await child.evaluate(async () => {
				const module = await import(
					"data:text/javascript,export default RTCPeerConnection"
				);
				const constructors = [
					(window as any).cachedRTC,
					eval("RTCPeerConnection"),
					new Function("return RTCPeerConnection")(),
					module.default,
				];
				return constructors.map((Constructor) => {
					const pc = new Constructor({
						iceTransportPolicy: "all",
						iceServers: [{ urls: "stun:attacker.invalid" }],
					});
					const policy = pc.getConfiguration().iceTransportPolicy;
					pc.close();
					return policy;
				});
			});
			assert.deepEqual(policies, ["relay", "relay", "relay", "relay"]);
			const mapping = await ctx.page.evaluate(() => ({
				hosts: (window as any).__runwayCleartextHttpsHosts,
				site: (window as any).__runwayCleartextSite,
			}));
			const url = await ctx.page.evaluate(() =>
				sessionStorage.getItem("__runway_last_test")
			);
			assert.ok(url);
			const opened = ctx.page.waitForEvent("popup");
			await ctx.page.evaluate(() => {
				const harnessUrl = new URL(location.href);
				harnessUrl.searchParams.set("runwayManualNavigation", "1");
				window.open(harnessUrl.href, "_blank");
			});
			const tab = await opened;
			const pageErrors: string[] = [];
			tab.on("pageerror", (error) => pageErrors.push(error.message));
			tab.on("console", (message) => {
				if (process.env.RUNWAY_WEBRTC_DEBUG === "1") {
					console.log(`[webrtc popup ${message.type()}]`, message.text());
				}
				if (message.type() === "error") pageErrors.push(message.text());
			});
			try {
				await tab.waitForLoadState("domcontentloaded");
				try {
					await tab.waitForFunction(
						"typeof window.__runwayNavigate === 'function'"
					);
				} catch {
					const serviceWorker = await tab.evaluate(async () => ({
						url: location.href,
						secure: isSecureContext,
						controller: navigator.serviceWorker?.controller?.scriptURL,
						registrations: (
							await navigator.serviceWorker?.getRegistrations()
						)?.map((registration) => ({
							scope: registration.scope,
							active: registration.active?.scriptURL,
						})),
					}));
					throw new Error(
						`second tab harness failed: ${await tab.locator("#status").textContent()} ${JSON.stringify({ pageErrors, serviceWorker })}`
					);
				}
				assert.ok(
					tab
						.frames()
						.every((candidate) => !candidate.url().includes("/~/sj/")),
					"the new tab must wait for its fixture and policy before navigation"
				);
				await tab.evaluate(
					({ config, url, mapping }) => {
						(window as any).__runwayCleartextHttpsHosts = mapping.hosts;
						(window as any).__runwayCleartextSite = mapping.site;
						(window as any).__runwaySetWebrtcConfig(config);
						(window as any).__runwayNavigate(url);
					},
					{ config: realmConfig, url, mapping }
				);
				const other = await waitForProxiedFrame(tab).catch((error) => {
					throw new Error(
						`${error.message}; tab errors=${JSON.stringify(pageErrors)}`
					);
				});
				try {
					await child.evaluate(initializeDataPeer, {
						config: { iceTransportPolicy: "all" },
						sender: true,
					});
					await other.evaluate(initializeDataPeer, {
						config: { iceTransportPolicy: "all" },
						sender: false,
					});
					await negotiateDataPeers(child, other);
					await expectDataEcho(child);
					for (const endpoint of [child, other]) {
						const state = await endpoint.evaluate(readDataPeer);
						assert.equal(state.connection, "connected");
						assert.ok(
							state.localTypes.length > 0 &&
								state.localTypes.every(
									(type) => type === "relay" || type === "prflx"
								)
						);
					}
				} finally {
					await closeDataPeers(child, other);
				}
				await child.goto(child.url());
				await child.waitForFunction("window.__webrtcTestPage === true");
				assert.equal(
					await child.evaluate(() => {
						const pc = new RTCPeerConnection();
						const policy = pc.getConfiguration().iceTransportPolicy;
						pc.close();
						return policy;
					}),
					"relay"
				);
			} finally {
				await tab.close();
			}
		},
	}),
];

// The fixture shortens the browser's expiry window; TURN itself still uses the
// real signed credentials. This exercises active refresh and client expiry denial.
for (const failure of [false, true]) {
	let server: http.Server;
	let hits = 0;
	const config: WebrtcTestConfig = {
		mode: "relay",
		iceServers: [],
		credentialRefreshRatio: 0.5,
		failClosed: true,
	};
	tests.push(
		webrtcTest({
			name: `webrtc-credentials-active-${failure ? "expiry-closes" : "refresh-restarts-ice"}`,
			html: webrtcPageHtml(),
			config,
			async prepare() {
				const value = await fetchTurnCredentials();
				config.iceServers = [
					{
						urls: value.urls,
						username: value.username,
						credential: value.credential,
					},
				];
				config.iceServersExpiresAt = Date.now() + 8000;
			},
			async onServer() {
				server = http.createServer(async (_request, response) => {
					hits++;
					response.setHeader("access-control-allow-origin", "*");
					response.setHeader("content-type", "application/json");
					if (failure) {
						response.writeHead(503);
						response.end("{}");
						return;
					}
					try {
						const value = await fetchTurnCredentials();
						response.end(JSON.stringify({ ...value, ttl: 8 }));
					} catch {
						response.writeHead(503);
						response.end("{}");
					}
				});
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve)
				);
				config.credentialEndpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/turn-credentials`;
			},
			async onStop() {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
			async fn(ctx, frame) {
				const peer = await ctx.page.context().newPage();
				try {
					await frame.evaluate(initializeDataPeer, {
						config: {},
						sender: true,
					});
					await peer.evaluate(initializeDataPeer, {
						config: {
							iceServers: config.iceServers as RTCIceServer[],
							iceTransportPolicy: "relay",
							bundlePolicy: "max-bundle",
						},
						sender: false,
					});
					await negotiateDataPeers(frame, peer);
					await expectDataEcho(frame);
					const before = await frame.evaluate(readDataPeer);
					if (failure) {
						await frame.waitForFunction(
							() => window.__webrtcPeer.pc.connectionState === "closed",
							undefined,
							{ timeout: 12000 }
						);
					} else {
						await frame.waitForFunction(
							(username) =>
								window.__webrtcPeer.pc.getConfiguration().iceServers?.[0]
									?.username !== username,
							before.username,
							{ timeout: 10000 }
						);
						const refreshed = await frame.evaluate(readDataPeer);
						assert.ok(
							refreshed.negotiations > before.negotiations,
							"fresh credentials must request native renegotiation"
						);
						const oldSdp = before.sdp.match(/a=ice-ufrag:(\S+)/)?.[1];
						const { offer } = await negotiateDataPeers(frame, peer);
						assert.notEqual(
							offer.description.sdp!.match(/a=ice-ufrag:(\S+)/)?.[1],
							oldSdp
						);
						await frame.evaluate(() =>
							window.__webrtcPeer.channel!.send("after-credential-refresh")
						);
						await expectDataEcho(frame, "after-credential-refresh");
					}
					assert.ok(hits > 0, "the real refresh endpoint must be contacted");
				} finally {
					await closeDataPeers(frame, peer);
					await peer.close();
				}
			},
		})
	);
}

export default tests;
