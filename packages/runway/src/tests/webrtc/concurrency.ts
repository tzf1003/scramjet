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

const PAIRS = Number(process.env.WEBRTC_CONCURRENCY_PAIRS ?? 2);
const config: WebrtcTestConfig = {
	mode: "relay",
	iceServers: [],
	failClosed: true,
	diagnostics: true,
};

let signaling: Signaling | undefined;

const test = webrtcTest({
	name: "webrtc-relay-concurrent-peers-and-channels",
	html: webrtcPageHtml(
		"<script>window.__webrtcSignalPort = {{SIGNAL_PORT}};</script>"
	),
	config,
	async onServer() {
		signaling = await createSignaling();
		return signaling.port;
	},
	async onStop() {
		await signaling?.close();
	},
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
	async fn(ctx, frame) {
		const targetHost = process.env.RUNWAY_TEST_HOST ?? "localhost";
		if (!signaling) throw new Error("signaling server did not start");
		const signalingPort = signaling.port;

		const peerA = frame.evaluate(
			async ({ pairs, port }) => {
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					setTimeout(done.resolve, ms);
					return done.promise;
				};
				const pageWindow = window as unknown as { __webrtcSignalPort: number };

				async function runPair(index: number) {
					const ws = new WebSocket(
						`ws://${location.hostname}:${pageWindow.__webrtcSignalPort}/signal?role=A${index}`
					);
					await new Promise<void>((resolve, reject) => {
						ws.onopen = () => resolve();
						ws.onerror = () => reject(new Error(`A${index} signaling failed`));
					});
					const pendingSignals: MessageEvent[] = [];
					let signalHandler: ((event: MessageEvent) => Promise<void>) | null =
						null;
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
					const labels = [
						`ordered-${index}`,
						`unordered-${index}`,
						`negotiated-${index}`,
					];
					const channels = new Map<string, RTCDataChannel>();
					const ordered = pc.createDataChannel(labels[0], { ordered: true });
					const unordered = pc.createDataChannel(labels[1], {
						ordered: false,
						maxRetransmits: 0,
					});
					const negotiated = pc.createDataChannel(labels[2], {
						negotiated: true,
						id: 100 + index,
					});
					for (const channel of [ordered, unordered, negotiated]) {
						channels.set(channel.label, channel);
						channel.onopen = () => {
							channel.send(`hello:${channel.label}`);
						};
					}
					const big = `big-${index}:${"z".repeat(65536)}`;
					const echoes = new Set<string>();
					const pairDone = Promise.withResolvers<{
						localType: string | null;
						localPort: number | null;
						localUrl: string | null;
						localRelayProtocol: string | null;
						connectionState: string;
						channelStates: Record<string, string>;
						bufferedAmount: number;
					}>();
					let bigSent = false;
					for (const channel of channels.values()) {
						channel.onmessage = (event) => {
							if (typeof event.data !== "string") return;
							echoes.add(event.data);
							if (echoes.size === 3 && !bigSent) {
								bigSent = true;
								const bigChannel = channels.get(labels[0])!;
								bigChannel.send(big);
							}
							if (event.data === big) {
								void (async () => {
									const bufferedAmount = channels.get(
										labels[0]
									)!.bufferedAmount;
									const report = await pc.getStats();
									const byId: Record<string, Record<string, unknown>> = {};
									report.forEach((stat, id) => {
										byId[id] = stat as unknown as Record<string, unknown>;
									});
									let candidatePair: Record<string, unknown> | undefined;
									for (const stat of Object.values(byId)) {
										if (
											stat.type === "transport" &&
											typeof stat.selectedCandidatePairId === "string"
										) {
											candidatePair = byId[stat.selectedCandidatePairId];
										}
									}
									if (!candidatePair) {
										for (const stat of Object.values(byId)) {
											if (
												stat.type === "candidate-pair" &&
												(stat.selected === true ||
													(stat.state === "succeeded" &&
														stat.nominated === true))
											) {
												candidatePair = stat;
											}
										}
									}
									const local = candidatePair?.localCandidateId
										? byId[String(candidatePair.localCandidateId)]
										: undefined;
									pairDone.resolve({
										localType: (local?.candidateType as string) ?? null,
										localPort: (local?.port as number) ?? null,
										localUrl: (local?.url as string) ?? null,
										localRelayProtocol:
											(local?.relayProtocol as string) ?? null,
										connectionState: pc.connectionState,
										channelStates: Object.fromEntries(
											[...channels.values()].map((channel) => [
												channel.label,
												channel.readyState,
											])
										),
										bufferedAmount,
									});
								})();
							}
						};
					}

					const remoteCandidates: RTCIceCandidateInit[] = [];
					let remoteDescriptionSet = false;
					const flushCandidates = async () => {
						while (remoteCandidates.length > 0) {
							try {
								await pc.addIceCandidate(remoteCandidates.shift()!);
							} catch {
								// Late candidates are harmless.
							}
						}
					};
					pc.onicecandidate = (event) => {
						ws.send(
							JSON.stringify({
								type: "candidate",
								candidate: event.candidate,
							})
						);
					};
					signalHandler = async (event) => {
						const message = JSON.parse(String(event.data));
						if (message.type === "peer-ready") {
							const offer = await pc.createOffer();
							await pc.setLocalDescription(offer);
							ws.send(
								JSON.stringify({ type: "offer", sdp: pc.localDescription })
							);
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

					const timeout = tick(30_000).then(() => {
						throw new Error(
							`A${index} timed out: ${pc.connectionState}/${pc.iceConnectionState} echoes=${echoes.size}`
						);
					});
					return await Promise.race([pairDone.promise, timeout]).finally(() =>
						pc.close()
					);
				}

				return Promise.all(
					Array.from({ length: pairs }, (_, index) => runPair(index))
				);
			},
			{ pairs: PAIRS, port: signalingPort }
		);

		const peerB = ctx.page.evaluate(
			async ({ pairs, url, port, iceServers }) => {
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					setTimeout(done.resolve, ms);
					return done.promise;
				};

				async function runPair(index: number) {
					const ws = new WebSocket(`ws://${url}:${port}/signal?role=B${index}`);
					await new Promise<void>((resolve, reject) => {
						ws.onopen = () => resolve();
						ws.onerror = () => reject(new Error(`B${index} signaling failed`));
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
					const channels = new Map<string, RTCDataChannel>();
					const pairDone = Promise.withResolvers<{
						remoteType: string | null;
						remotePort: number | null;
						connectionState: string;
						received: number;
					}>();
					const addChannel = (channel: RTCDataChannel) => {
						channels.set(channel.label, channel);
						channel.onmessage = (event) => {
							if (
								typeof event.data === "string" &&
								event.data.startsWith("big-")
							) {
								void (async () => {
									const report = await pc.getStats();
									const byId: Record<string, Record<string, unknown>> = {};
									report.forEach((stat, id) => {
										byId[id] = stat as unknown as Record<string, unknown>;
									});
									let candidatePair: Record<string, unknown> | undefined;
									for (const stat of Object.values(byId)) {
										if (
											stat.type === "transport" &&
											typeof stat.selectedCandidatePairId === "string"
										) {
											candidatePair = byId[stat.selectedCandidatePairId];
										}
									}
									if (!candidatePair) {
										for (const stat of Object.values(byId)) {
											if (
												stat.type === "candidate-pair" &&
												(stat.selected === true ||
													(stat.state === "succeeded" &&
														stat.nominated === true))
											) {
												candidatePair = stat;
											}
										}
									}
									const remote = candidatePair?.remoteCandidateId
										? byId[String(candidatePair.remoteCandidateId)]
										: undefined;
									channel.send(event.data);
									setTimeout(
										() =>
											pairDone.resolve({
												remoteType: (remote?.candidateType as string) ?? null,
												remotePort: (remote?.port as number) ?? null,
												connectionState: pc.connectionState,
												received: channels.size,
											}),
										100
									);
								})();
								return;
							}
							channel.send(event.data);
						};
					};
					addChannel(
						pc.createDataChannel(`negotiated-${index}`, {
							negotiated: true,
							id: 100 + index,
						})
					);
					pc.ondatachannel = (event) => addChannel(event.channel);
					const received = new Set<string>();
					pc.onicecandidate = (event) => {
						ws.send(
							JSON.stringify({
								type: "candidate",
								candidate: event.candidate,
							})
						);
					};
					const remoteCandidates: RTCIceCandidateInit[] = [];
					let remoteDescriptionSet = false;
					const flushCandidates = async () => {
						while (remoteCandidates.length > 0) {
							try {
								await pc.addIceCandidate(remoteCandidates.shift()!);
							} catch {
								// Late candidates are harmless.
							}
						}
					};
					signalHandler = async (event) => {
						const message = JSON.parse(String(event.data));
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

					const timeout = tick(30_000).then(() => {
						throw new Error(
							`B${index} timed out: ${pc.connectionState}/${pc.iceConnectionState} channels=${channels.size}`
						);
					});
					return await Promise.race([pairDone.promise, timeout]).finally(() =>
						pc.close()
					);
				}

				return Promise.all(
					Array.from({ length: pairs }, (_, index) => runPair(index))
				);
			},
			{
				pairs: PAIRS,
				url: targetHost,
				port: signalingPort,
				iceServers: config.iceServers,
			}
		);

		const [pairsA, pairsB] = await Promise.all([peerA, peerB]);
		for (let index = 0; index < PAIRS; index += 1) {
			const a = pairsA[index];
			const b = pairsB[index];
			const turnBacked =
				a.localType === "relay" ||
				(a.localType === "prflx" &&
					typeof a.localUrl === "string" &&
					/^turns?:/i.test(a.localUrl) &&
					a.localRelayProtocol !== null);
			assert.equal(turnBacked, true, `pair ${index} is not TURN-backed`);
			assert.equal(a.connectionState, "connected");
			assert.equal(b.connectionState, "connected");
			assert.equal(b.received, 3);
			assert.equal(
				b.remotePort,
				a.localPort,
				`pair ${index} B is not using A's relay port`
			);
			assert.ok(
				a.bufferedAmount < 100_000,
				`pair ${index} DataChannel backpressure did not drain: ${JSON.stringify(
					a
				)}`
			);
			assert.deepEqual(a.channelStates, {
				[`ordered-${index}`]: "open",
				[`unordered-${index}`]: "open",
				[`negotiated-${index}`]: "open",
			});
		}
	},
});

export default [test];
