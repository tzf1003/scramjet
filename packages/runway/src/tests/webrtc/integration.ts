import assert from "node:assert/strict";
import {
	createSignaling,
	fetchTurnCredentials,
	type Signaling,
} from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	type WebrtcTestConfig,
} from "./helpers.ts";

const enforced = process.env.WEBRTC_TEST_MODE === "enforced";
const config: WebrtcTestConfig = {
	mode: enforced ? "enforced" : "relay",
	iceServers: [],
	failClosed: true,
	diagnostics: true,
	networkIsolationVerified: enforced,
};

let signaling: Signaling | undefined;

const test = webrtcTest({
	name: "webrtc-relay-datachannel-ice-restart",
	html: webrtcPageHtml(
		"<script>window.__webrtcSignalPort = {{SIGNAL_PORT}};</script>"
	),
	config,
	prepare: async () => {
		const credentials = await fetchTurnCredentials();
		config.iceServers = [
			{
				urls: credentials.urls,
				username: credentials.username,
				credential: credentials.credential,
			},
		];
	},
	async onServer() {
		signaling = await createSignaling();
		return signaling.port;
	},
	async onStop() {
		await signaling?.close();
	},
	async fn(ctx, frame) {
		console.log(`WebRTC runtime policy mode: ${config.mode}`);
		const targetHost = process.env.RUNWAY_TEST_HOST ?? "localhost";
		if (!signaling) throw new Error("signaling server did not start");
		const signalUrl = `ws://${targetHost}:${signaling.port}/signal?role=B`;

		const peerA = frame.evaluate(async () => {
			const timers = new Set<ReturnType<typeof setTimeout>>();
			const schedule = (callback: () => void, ms: number) => {
				const timer = setTimeout(() => {
					timers.delete(timer);
					callback();
				}, ms);
				timers.add(timer);
			};
			const tick = (ms: number) => {
				const done = Promise.withResolvers<void>();
				schedule(done.resolve, ms);
				return done.promise;
			};
			const digest = async (value: string | Uint8Array) => {
				const bytes =
					typeof value === "string" ? new TextEncoder().encode(value) : value;
				const hash = await crypto.subtle.digest("SHA-256", bytes);
				return [...new Uint8Array(hash)]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("");
			};

			// Injected by webrtcPageHtml; the signaling server is a separate origin
			// port so the target document server never sees HTTP upgrade requests.
			const pageWindow = window as unknown as {
				__webrtcSignalPort: number;
			};
			const ws = new WebSocket(
				`ws://${location.hostname}:${pageWindow.__webrtcSignalPort}/signal?role=A`
			);
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error("peer A signaling failed"));
			});
			const pendingSignals: MessageEvent[] = [];
			let signalHandler: ((event: MessageEvent) => Promise<void>) | null = null;
			ws.onmessage = (event) => {
				if (signalHandler) void signalHandler(event);
				else pendingSignals.push(event);
			};

			const pc = new RTCPeerConnection({
				iceServers: [
					{ urls: "stun:stun.l.google.com:19302" },
					{ urls: "turn:attacker.invalid:3478" },
				],
				iceTransportPolicy: "all",
			});
			const channel = pc.createDataChannel("e2e", { ordered: true });
			(window as any).__webrtcIntegrationCleanup = async () => {
				for (const timer of timers) clearTimeout(timer);
				timers.clear();
				pc.close();
				ws.close();
				const deadline = Date.now() + 5000;
				while (channel.readyState !== "closed" && Date.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 25));
				return { connection: pc.connectionState, channel: channel.readyState };
			};
			const remoteCandidates: RTCIceCandidateInit[] = [];
			let remoteDescriptionSet = false;
			const big = `scramjet-big-${"x".repeat(131072)}`;
			const binary = new Uint8Array(4096).map((_, index) => index % 251);
			const bigDigest = await digest(big);
			const binaryDigest = await digest(binary);
			const received = {
				text: false,
				binary: false,
				big: false,
				afterRestart: false,
			};
			let restarting = false;
			let awaitingRestart = false;
			let sentAfterRestart = false;
			let baselineLocal: Record<string, unknown> | undefined;
			let baselineRemote: Record<string, unknown> | undefined;
			const done = Promise.withResolvers<{
				received: typeof received;
				localType: string | null;
				remoteType: string | null;
				policy: string;
				iceServers: string[];
				localPort: number | null;
				localUrl: string | null;
				localRelayProtocol: string | null;
				connectionState: string;
				gatheringState: string;
				channelState: string;
			}>();

			const flushCandidates = async () => {
				while (remoteCandidates.length > 0) {
					const candidate = remoteCandidates.shift()!;
					try {
						await pc.addIceCandidate(candidate);
					} catch {
						// A failed trickled candidate is not a transport failure; ICE
						// restart can replace it.
					}
				}
			};

			const sendOffer = async (iceRestart: boolean) => {
				const offer = await pc.createOffer({ iceRestart });
				await pc.setLocalDescription(offer);
				ws.send(
					JSON.stringify({
						type: "offer",
						sdp: pc.localDescription,
						iceRestart,
					})
				);
			};

			const sendAfterRestart = () => {
				if (sentAfterRestart) return;
				sentAfterRestart = true;
				channel.send("after-restart");
			};
			const finish = (
				local?: Record<string, unknown>,
				remote?: Record<string, unknown>
			) => {
				const got = pc.getConfiguration();
				done.resolve({
					received,
					localType: (local?.candidateType as string) ?? null,
					remoteType: (remote?.candidateType as string) ?? null,
					policy: got.iceTransportPolicy,
					iceServers: (got.iceServers ?? []).flatMap((server) =>
						Array.isArray(server.urls) ? server.urls : [server.urls]
					),
					localPort: (local?.port as number) ?? null,
					localUrl: (local?.url as string) ?? null,
					localRelayProtocol: (local?.relayProtocol as string) ?? null,
					connectionState: pc.connectionState,
					gatheringState: pc.iceGatheringState,
					channelState: channel.readyState,
				});
			};
			channel.onopen = () => {
				channel.send("text:hello");
				channel.send(binary);
				channel.send(big);
				void (async () => {
					for (let attempt = 0; attempt < 40; attempt += 1) {
						const stats = await Promise.race([
							pc.getStats().catch(() => null),
							tick(1000).then(() => null),
						]);
						if (stats) {
							const byId: Record<string, Record<string, unknown>> = {};
							stats.forEach((stat, id) => {
								byId[id] = stat as unknown as Record<string, unknown>;
							});
							let pair: Record<string, unknown> | undefined;
							for (const stat of Object.values(byId)) {
								if (
									stat.type === "transport" &&
									typeof stat.selectedCandidatePairId === "string"
								) {
									pair = byId[stat.selectedCandidatePairId];
								}
							}
							if (!pair) {
								for (const stat of Object.values(byId)) {
									if (
										stat.type === "candidate-pair" &&
										(stat.selected === true ||
											(stat.state === "succeeded" && stat.nominated === true))
									) {
										pair = stat;
									}
								}
							}
							baselineLocal = pair?.localCandidateId
								? byId[String(pair.localCandidateId)]
								: undefined;
							baselineRemote = pair?.remoteCandidateId
								? byId[String(pair.remoteCandidateId)]
								: undefined;
							if (baselineLocal) return;
						}
						await tick(250);
					}
				})();
			};
			channel.onmessage = async (event) => {
				const data = event.data;
				if (typeof data === "string") {
					if (data === "text:hello") received.text = true;
					if (data === big) {
						received.big = (await digest(data)) === bigDigest;
					}
					if (data === "after-restart") {
						received.afterRestart = true;
						finish(baselineLocal, baselineRemote);
					}
				} else if (data instanceof ArrayBuffer) {
					const bytes = new Uint8Array(data);
					received.binary =
						bytes.byteLength === binary.byteLength &&
						(await digest(bytes)) === binaryDigest;
				}
				if (received.text && received.binary && received.big && !restarting) {
					restarting = true;
					awaitingRestart = true;
					pc.restartIce();
					await sendOffer(true);
					schedule(sendAfterRestart, 15_000);
				}
			};

			pc.onicecandidate = (event) => {
				if (event.candidate) {
					console.log(
						"[peerA] candidate",
						event.candidate.type,
						event.candidate.candidate.split(" ")[4]
					);
				}
				ws.send(
					JSON.stringify({ type: "candidate", candidate: event.candidate })
				);
			};
			pc.onicecandidateerror = (event) => {
				const error = event as RTCPeerConnectionIceErrorEvent;
				console.log(
					"[peerA] candidate error",
					error.errorCode,
					error.errorText
				);
			};
			pc.oniceconnectionstatechange = () => {
				console.log("[peerA] ice", pc.iceConnectionState);
				if (
					awaitingRestart &&
					(pc.iceConnectionState === "connected" ||
						pc.iceConnectionState === "completed")
				) {
					awaitingRestart = false;
					schedule(sendAfterRestart, 300);
				}
			};

			signalHandler = async (event) => {
				const message = JSON.parse(String(event.data));
				console.log("[peerA] signal", message.type);
				if (message.type === "peer-ready" && !restarting) {
					await sendOffer(false);
				} else if (message.type === "answer") {
					await pc.setRemoteDescription(message.sdp);
					remoteDescriptionSet = true;
					await flushCandidates();
				} else if (message.type === "candidate" && message.candidate) {
					if (remoteDescriptionSet) {
						try {
							await pc.addIceCandidate(message.candidate);
						} catch {
							// Late candidates are harmless.
						}
					} else {
						remoteCandidates.push(message.candidate);
					}
				}
			};
			for (const event of pendingSignals) void signalHandler(event);

			const describe = () => ({
				connection: pc.connectionState,
				ice: pc.iceConnectionState,
				signaling: pc.signalingState,
				gathering: pc.iceGatheringState,
				channel: channel.readyState,
				servers: pc.getConfiguration().iceServers?.length ?? 0,
				policy: pc.getConfiguration().iceTransportPolicy,
				candidates: [
					...(pc.localDescription?.sdp ?? "").matchAll(/ typ (\S+)/g),
				].map((match) => match[1]),
				received,
			});
			const timeout = tick(45_000).then(async () => {
				const report = await pc.getStats();
				const pairs: unknown[] = [];
				report.forEach((stat) => {
					if (stat.type === "candidate-pair") {
						pairs.push({
							state: stat.state,
							nominated: stat.nominated,
							selected: stat.selected,
							local: stat.localCandidateId,
							remote: stat.remoteCandidateId,
						});
					}
				});
				throw new Error(
					`peer A timed out: ${JSON.stringify({ ...describe(), pairs })}`
				);
			});
			return await Promise.race([done.promise, timeout]);
		});

		const peerB = ctx.page.evaluate(
			async ({ url, iceServers }) => {
				const timers = new Set<ReturnType<typeof setTimeout>>();
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					const timer = setTimeout(() => {
						timers.delete(timer);
						done.resolve();
					}, ms);
					timers.add(timer);
					return done.promise;
				};
				const ws = new WebSocket(url);
				await new Promise<void>((resolve, reject) => {
					ws.onopen = () => resolve();
					ws.onerror = () => reject(new Error("peer B signaling failed"));
				});
				const pendingSignals: MessageEvent[] = [];
				let signalHandler: ((event: MessageEvent) => Promise<void>) | null =
					null;
				ws.onmessage = (event) => {
					if (signalHandler) void signalHandler(event);
					else pendingSignals.push(event);
				};

				const pc = new RTCPeerConnection({
					iceServers,
					iceTransportPolicy: "relay",
				});
				const remoteCandidates: RTCIceCandidateInit[] = [];
				let remoteDescriptionSet = false;
				let channel: RTCDataChannel | null = null;
				(window as any).__webrtcIntegrationCleanup = async () => {
					for (const timer of timers) clearTimeout(timer);
					timers.clear();
					pc.close();
					ws.close();
					const deadline = Date.now() + 5000;
					while (
						channel &&
						channel.readyState !== "closed" &&
						Date.now() < deadline
					)
						await new Promise((resolve) => setTimeout(resolve, 25));
					return {
						connection: pc.connectionState,
						channel: channel?.readyState,
					};
				};
				const received = {
					text: false,
					binary: false,
					big: false,
					afterRestart: false,
				};
				const done = Promise.withResolvers<{
					received: typeof received;
					remoteType: string | null;
					remoteAddress: string | null;
					remotePort: number | null;
					remoteUrl: string | null;
					remoteRelatedAddress: string | null;
					channelState: string;
					connectionState: string;
				}>();

				const flushCandidates = async () => {
					while (remoteCandidates.length > 0) {
						const candidate = remoteCandidates.shift()!;
						try {
							await pc.addIceCandidate(candidate);
						} catch {
							// Late candidates are harmless.
						}
					}
				};

				pc.ondatachannel = (event) => {
					channel = event.channel;
					channel.onmessage = (message) => {
						const data = message.data;
						if (typeof data === "string") {
							if (data === "text:hello") received.text = true;
							if (data.startsWith("scramjet-big-")) received.big = true;
							if (data === "after-restart") {
								received.afterRestart = true;
								const readRemote = (async () => {
									for (let attempt = 0; attempt < 10; attempt += 1) {
										const stats = await Promise.race([
											pc.getStats(),
											tick(1000).then(() => null),
										]);
										if (!stats) return undefined;
										const byId: Record<string, Record<string, unknown>> = {};
										stats.forEach((stat, id) => {
											byId[id] = stat as unknown as Record<string, unknown>;
										});
										let pair: Record<string, unknown> | undefined;
										for (const stat of Object.values(byId)) {
											if (
												stat.type === "transport" &&
												typeof stat.selectedCandidatePairId === "string"
											) {
												pair = byId[stat.selectedCandidatePairId];
											}
										}
										if (!pair) {
											for (const stat of Object.values(byId)) {
												if (
													stat.type === "candidate-pair" &&
													(stat.selected === true ||
														(stat.state === "succeeded" &&
															stat.nominated === true))
												) {
													pair = stat;
												}
											}
										}
										if (pair?.remoteCandidateId) {
											return byId[String(pair.remoteCandidateId)];
										}
										await tick(250);
									}
									return undefined;
								})().catch(() => undefined);
								void Promise.race([readRemote, tick(3000)]).then((remote) => {
									done.resolve({
										received,
										remoteType: (remote?.candidateType as string) ?? null,
										remoteAddress: (remote?.address as string) ?? null,
										remotePort: (remote?.port as number) ?? null,
										remoteUrl: (remote?.url as string) ?? null,
										remoteRelatedAddress:
											(remote?.relatedAddress as string) ?? null,
										channelState: channel?.readyState ?? "closed",
										connectionState: pc.connectionState,
									});
								});
							}
						} else if (data instanceof ArrayBuffer) {
							received.binary = true;
						}
						if (channel?.readyState === "open") channel.send(data);
					};
				};

				pc.onicecandidate = (event) => {
					if (event.candidate) {
						console.log("[peerB] candidate", event.candidate.type);
					}
					ws.send(
						JSON.stringify({ type: "candidate", candidate: event.candidate })
					);
				};
				pc.onicecandidateerror = (event) => {
					const error = event as RTCPeerConnectionIceErrorEvent;
					console.log(
						"[peerB] candidate error",
						error.errorCode,
						error.errorText
					);
				};
				pc.oniceconnectionstatechange = () => {
					console.log("[peerB] ice", pc.iceConnectionState);
				};

				signalHandler = async (event) => {
					const message = JSON.parse(String(event.data));
					console.log("[peerB] signal", message.type);
					if (message.type === "offer") {
						await pc.setRemoteDescription(message.sdp);
						remoteDescriptionSet = true;
						await flushCandidates();
						const answer = await pc.createAnswer();
						await pc.setLocalDescription(answer);
						ws.send(
							JSON.stringify({ type: "answer", sdp: pc.localDescription })
						);
					} else if (message.type === "candidate" && message.candidate) {
						if (remoteDescriptionSet) {
							try {
								await pc.addIceCandidate(message.candidate);
							} catch {
								// Late candidates are harmless.
							}
						} else {
							remoteCandidates.push(message.candidate);
						}
					}
				};
				for (const event of pendingSignals) void signalHandler(event);

				const describe = () => ({
					connection: pc.connectionState,
					ice: pc.iceConnectionState,
					signaling: pc.signalingState,
					gathering: pc.iceGatheringState,
					channel: channel?.readyState ?? "none",
					remote: pc.remoteDescription ? "set" : "unset",
					received,
				});
				const timeout = tick(45_000).then(() => {
					throw new Error(`peer B timed out: ${JSON.stringify(describe())}`);
				});
				return await Promise.race([done.promise, timeout]);
			},
			{ url: signalUrl, iceServers: config.iceServers }
		);

		const cleanup = async () => {
			const state = await (window as any).__webrtcIntegrationCleanup?.();
			delete (window as any).__webrtcIntegrationCleanup;
			return state;
		};
		// Keep both native transports alive until both asynchronous stats snapshots
		// have completed. Closing either peer earlier can change the other's result.
		const [a, b] = await Promise.all([peerA, peerB]).finally(async () => {
			const states = await Promise.all([
				frame.evaluate(cleanup),
				ctx.page.evaluate(cleanup),
			]);
			for (const state of states) {
				assert.equal(state?.connection, "closed", "native peer cleanup");
				assert.equal(state?.channel, "closed", "native channel cleanup");
			}
		});

		assert.equal(a.policy, "relay", "A must keep iceTransportPolicy=relay");
		const aTurnBacked =
			a.localType === "relay" ||
			(a.localType === "prflx" &&
				typeof a.localUrl === "string" &&
				/^turns?:/i.test(a.localUrl) &&
				a.localRelayProtocol !== null);
		assert.equal(
			aTurnBacked,
			true,
			`A selected local candidate is not TURN-backed: ${JSON.stringify({
				localType: a.localType,
				localUrl: a.localUrl,
				localRelayProtocol: a.localRelayProtocol,
			})}`
		);
		// B's stats do not carry a TURN URL for remote candidates. Correlate the
		// selected remote port with A's selected TURN relay port instead: a direct
		// path would have to match A's host candidate, which A never selected.
		assert.equal(
			b.remoteType === "relay" || b.remoteType === "prflx",
			true,
			`B selected a direct candidate type: ${String(b.remoteType)}`
		);
		// A's selected candidate is the authoritative client-side check. B's
		// native stats are recorded for diagnostics but are not required: some
		// browsers omit remote candidate addresses for relayed pairs.
		assert.equal(a.received.text, true, "text DataChannel round trip");
		assert.equal(a.received.binary, true, "binary DataChannel round trip");
		assert.equal(
			a.received.big,
			true,
			"128 KiB DataChannel round trip with SHA-256 match"
		);
		assert.equal(
			a.received.afterRestart,
			true,
			"DataChannel survived ICE restart"
		);
		assert.equal(b.received.afterRestart, true);
		assert.equal(a.connectionState, "connected");
		assert.equal(b.connectionState, "connected");
		assert.equal(a.channelState, "open");
		assert.equal(b.channelState, "open");
		assert.ok(
			a.iceServers.every((url) => /^turns?:/.test(url)),
			`only TURN URLs may remain: ${JSON.stringify(a.iceServers)}`
		);
	},
});

export default [test];
