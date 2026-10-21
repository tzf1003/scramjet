import assert from "node:assert/strict";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	initializeDataPeer,
	negotiateDataPeers,
	expectDataEcho,
	readDataPeer,
	closeDataPeers,
} from "./peers.ts";
import { webrtcPageHtml, webrtcTest } from "./helpers.ts";

const TURN = "turn:127.0.0.1:13478?transport=udp";
const DEAD_TURN = "turn:127.0.0.1:13479?transport=udp";

const invalidConfig = {
	mode: "relay" as const,
	iceServers: [] as RTCIceServer[],
	failClosed: true,
};
const verifyFailure: Parameters<typeof webrtcTest>[0]["fn"] = async (
	ctx,
	frame
) => {
	const nativeA = await ctx.page.context().newPage();
	const nativeB = await ctx.page.context().newPage();
	try {
		const directConfig = { iceServers: [] };
		const directHost = process.env.WEBRTC_DIRECT_HOST;
		const health = new URL(
			"/healthz",
			process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081"
		).href;
		await Promise.all([nativeA.goto(health), nativeB.goto(health)]);
		// Prove this topology can expose a missing hook before testing denial.
		await nativeA.evaluate(initializeDataPeer, {
			config: directConfig,
			sender: true,
		});
		await nativeB.evaluate(initializeDataPeer, {
			config: directConfig,
			sender: false,
		});
		await negotiateDataPeers(nativeA, nativeB, false, directHost);
		await expectDataEcho(nativeA);
		await closeDataPeers(nativeA, nativeB);
		await frame.evaluate(initializeDataPeer, {
			config: {
				iceServers: directConfig.iceServers,
				iceTransportPolicy: "all",
			},
			sender: true,
		});
		await nativeB.evaluate(initializeDataPeer, {
			config: directConfig,
			sender: false,
		});
		for (const restart of [false, true]) {
			const { offer } = await negotiateDataPeers(
				frame,
				nativeB,
				restart,
				directHost
			);
			assert.match(offer.description.sdp!, /^m=application/m);
			assert.notEqual(
				offer.gathering,
				"new",
				"ICE gathering must actually run"
			);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			const result = await frame.evaluate(readDataPeer);
			assert.notEqual(
				result.connection,
				"connected",
				"an unreachable TURN must never connect to the reachable direct peer"
			);
			assert.notEqual(result.channel, "open");
			assert.deepEqual(result.echoes, []);
			assert.deepEqual(
				result.localTypes.filter((type) => type !== "relay"),
				[]
			);
			assert.ok(
				result.candidates.every((line) => / typ relay(?: |$)/.test(line))
			);
		}
		console.log(
			"TURN-down control: native direct echo passed; proxied direct path and ICE restart blocked"
		);
	} finally {
		await closeDataPeers(frame, nativeA, nativeB);
		await nativeA.close();
		await nativeB.close();
	}
};

export default [
	webrtcTest({
		name: "webrtc-hook-control-detects-direct-mode",
		html: webrtcPageHtml(),
		config: { mode: "off" },
		async fn(ctx, frame) {
			await assert.rejects(
				() => verifyFailure(ctx, frame),
				(error: unknown) =>
					error instanceof assert.AssertionError &&
					error.message.includes("unreachable TURN must never connect")
			);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-fail-closed-invalid-credentials",
		html: webrtcPageHtml(),
		config: invalidConfig,
		async prepare() {
			const value = await fetchTurnCredentials();
			invalidConfig.iceServers = [
				{
					urls: value.urls,
					username: "1:expired",
					credential: "invalid-authentication",
				},
			];
		},
		fn: verifyFailure,
	}),

	webrtcTest({
		name: "webrtc-hook-forces-relay-and-authorised-turn",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			failClosed: true,
			diagnostics: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(() => {
				const nativeProto = RTCPeerConnection.prototype;
				const pc = new RTCPeerConnection({
					iceServers: [
						{ urls: "stun:stun.l.google.com:19302" },
						{ urls: "turn:attacker.invalid:3478" },
					],
					iceTransportPolicy: "all",
					bundlePolicy: "max-bundle",
				});
				const initial = pc.getConfiguration();
				pc.setConfiguration({
					iceServers: [{ urls: "stun:stun.example.org:3478" }],
					iceTransportPolicy: "all",
				});
				const overridden = pc.getConfiguration();
				const proto = Object.getPrototypeOf(pc) === nativeProto;
				const instance = pc instanceof RTCPeerConnection;
				pc.close();
				return {
					initialPolicy: initial.iceTransportPolicy,
					initialUrls: (initial.iceServers ?? []).flatMap((server) =>
						Array.isArray(server.urls) ? server.urls : [server.urls]
					),
					overriddenPolicy: overridden.iceTransportPolicy,
					overriddenUrls: (overridden.iceServers ?? []).flatMap((server) =>
						Array.isArray(server.urls) ? server.urls : [server.urls]
					),
					proto,
					instance,
				};
			});

			assert.equal(result.initialPolicy, "relay");
			assert.equal(result.overriddenPolicy, "relay");
			assert.deepEqual(result.initialUrls, [TURN]);
			assert.deepEqual(result.overriddenUrls, [TURN]);
			assert.equal(result.proto, true, "prototype identity must be preserved");
			assert.equal(result.instance, true, "instanceof must be preserved");
		},
	}),

	webrtcTest({
		name: "webrtc-hook-fail-closed-without-credentials",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [],
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(() => {
				try {
					const pc = new RTCPeerConnection();
					pc.close();
					return { created: true, error: "" };
				} catch (error) {
					const err = error as DOMException;
					return { created: false, error: `${err.name}: ${err.message}` };
				}
			});
			assert.equal(result.created, false);
			assert.match(result.error, /NotSupportedError/);
			assert.match(result.error, /TURN credentials/);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-enforced-requires-attestation",
		html: webrtcPageHtml(),
		config: {
			mode: "enforced",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			networkIsolationVerified: false,
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(() => {
				try {
					const pc = new RTCPeerConnection();
					pc.close();
					return { created: true, error: "" };
				} catch (error) {
					const err = error as DOMException;
					return { created: false, error: `${err.name}: ${err.message}` };
				}
			});
			assert.equal(result.created, false);
			assert.match(result.error, /NotSupportedError/);
			assert.match(result.error, /networkIsolationVerified/);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-enforced-with-attestation",
		html: webrtcPageHtml(),
		config: {
			mode: "enforced",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			networkIsolationVerified: true,
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const policy = await frame.evaluate(() => {
				const pc = new RTCPeerConnection({
					iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
					iceTransportPolicy: "all",
				});
				const policy = pc.getConfiguration().iceTransportPolicy;
				pc.close();
				return policy;
			});
			assert.equal(policy, "relay");
		},
	}),

	webrtcTest({
		name: "webrtc-hook-local-sdp-has-no-direct-candidates",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [{ urls: DEAD_TURN, username: "user", credential: "pass" }],
			failClosed: true,
			diagnostics: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(async () => {
				const pc = new RTCPeerConnection();
				pc.createDataChannel("gathering-probe");
				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				const settle = Promise.withResolvers<void>();
				setTimeout(settle.resolve, 1500);
				await settle.promise;
				const sdp = pc.localDescription?.sdp ?? "";
				const types = [...sdp.matchAll(/ typ (host|srflx|prflx|relay)/g)].map(
					(match) => match[1]
				);
				const gathering = pc.iceGatheringState;
				const pairTypes = await pc.getStats().then((report) => {
					const types: string[] = [];
					report.forEach((stat) => {
						if (stat.type === "local-candidate") {
							types.push(String(stat.candidateType));
						}
					});
					return types;
				});
				pc.close();
				return {
					types,
					gathering,
					pairTypes,
					media: /^m=application/m.test(sdp),
				};
			});
			assert.equal(
				result.media,
				true,
				"the offer must contain a real ICE workload"
			);
			assert.notEqual(result.gathering, "new");
			assert.deepEqual(
				result.types.filter((type) => type !== "relay"),
				[],
				`local SDP leaked a direct candidate: ${JSON.stringify(result.types)}`
			);
			assert.deepEqual(
				result.pairTypes.filter((type) => type !== "relay"),
				[],
				`local candidates leaked: ${JSON.stringify(result.pairTypes)}`
			);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-fail-closed-when-turn-unreachable",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [{ urls: DEAD_TURN, username: "user", credential: "pass" }],
			failClosed: true,
			diagnostics: true,
		},
		fn: verifyFailure,
	}),

	webrtcTest({
		name: "webrtc-hook-applies-in-same-origin-iframe",
		html: webrtcPageHtml('<iframe id="child" src="/child"></iframe>'),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(async () => {
				const iframe = document.getElementById("child") as HTMLIFrameElement;
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const win = iframe.contentWindow as
						| (Window & {
								__webrtcTestPage?: boolean;
								RTCPeerConnection?: typeof RTCPeerConnection;
						  })
						| null;
					if (win?.__webrtcTestPage && win.RTCPeerConnection) {
						const pc = new win.RTCPeerConnection({
							iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
							iceTransportPolicy: "all",
						});
						const config = pc.getConfiguration();
						const urls = (config.iceServers ?? []).flatMap((server) =>
							Array.isArray(server.urls) ? server.urls : [server.urls]
						);
						pc.close();
						return { policy: config.iceTransportPolicy, urls };
					}
					const tick = Promise.withResolvers<void>();
					setTimeout(tick.resolve, 100);
					await tick.promise;
				}
				throw new Error("child iframe did not install the WebRTC hook");
			});
			assert.equal(result.policy, "relay");
			assert.deepEqual(result.urls, [TURN]);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-about-blank-and-srcdoc",
		html: webrtcPageHtml(
			'<iframe id="blank"></iframe><iframe id="srcdoc" srcdoc="<p>srcdoc child</p>"></iframe>'
		),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(async () => {
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					setTimeout(done.resolve, ms);
					return done.promise;
				};
				const read = (win: Window): { policy: string; urls: string[] } => {
					const pc = new win.RTCPeerConnection({
						iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
						iceTransportPolicy: "all",
					});
					const config = pc.getConfiguration();
					const urls = (config.iceServers ?? []).flatMap((server) =>
						Array.isArray(server.urls) ? server.urls : [server.urls]
					);
					pc.close();
					return { policy: config.iceTransportPolicy, urls };
				};
				await tick(1000);
				const blank = (document.getElementById("blank") as HTMLIFrameElement)
					.contentWindow;
				const srcdoc = (document.getElementById("srcdoc") as HTMLIFrameElement)
					.contentWindow;
				if (!blank || !srcdoc) throw new Error("iframe realms unavailable");
				return { blank: read(blank), srcdoc: read(srcdoc) };
			});
			assert.equal(result.blank.policy, "relay");
			assert.deepEqual(result.blank.urls, [TURN]);
			assert.equal(result.srcdoc.policy, "relay");
			assert.deepEqual(result.srcdoc.urls, [TURN]);
		},
	}),

	webrtcTest({
		name: "webrtc-hook-worker-realm",
		browsers: ["chromium"],
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			failClosed: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(async () => {
				// Chromium exposes RTCDataChannel but not RTCPeerConnection in
				// dedicated workers. If a future browser exposes it, the injected
				// client must apply the same relay policy.
				const code = `
					if (typeof RTCPeerConnection !== "function") {
						postMessage({
							rtcDefined: false,
							dataChannelDefined: typeof RTCDataChannel === "function",
						});
					} else {
						try {
							const pc = new RTCPeerConnection({
								iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
								iceTransportPolicy: "all",
							});
							const config = pc.getConfiguration();
							postMessage({
								rtcDefined: true,
								ok: true,
								policy: config.iceTransportPolicy,
								urls: (config.iceServers ?? []).flatMap((s) =>
									Array.isArray(s.urls) ? s.urls : [s.urls]
								),
							});
							pc.close();
						} catch (error) {
							postMessage({
								rtcDefined: true,
								ok: false,
								error: String(error),
								name: error?.name,
							});
						}
					}
				`;
				const worker = new Worker(
					URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
				);
				const reply = Promise.withResolvers<unknown>();
				const timer = setTimeout(
					() => reply.reject(new Error("worker did not respond")),
					10_000
				);
				worker.onmessage = (event) => {
					clearTimeout(timer);
					reply.resolve(event.data);
					worker.terminate();
				};
				worker.onerror = (event) => {
					clearTimeout(timer);
					reply.reject(new Error(`worker error: ${event.message}`));
				};
				const result = await reply.promise;
				return result as {
					rtcDefined: boolean;
					dataChannelDefined?: boolean;
					ok?: boolean;
					policy?: string;
					urls?: string[];
					error?: string;
				};
			});
			if (!result.rtcDefined) {
				assert.equal(
					result.dataChannelDefined,
					true,
					"the worker realm loaded without the RTC API"
				);
				return;
			}
			assert.equal(result.ok, true, result.error);
			assert.equal(result.policy, "relay");
			assert.deepEqual(result.urls, [TURN]);
		},
	}),
];
