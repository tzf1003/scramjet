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

const config: WebrtcTestConfig = {
	mode: "relay",
	iceServers: [],
	failClosed: true,
	diagnostics: true,
};

let signaling: Signaling | undefined;

const test = webrtcTest({
	name: "webrtc-relay-media",
	browsers: ["chromium"],
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
		const signalUrl = `ws://${targetHost}:${signaling.port}/signal?role=B`;

		const peerBPage = await ctx.page.context().newPage();
		if (process.env.RUNWAY_WEBRTC_DEBUG === "1") {
			peerBPage.on("console", (message) =>
				console.log(`[peerB page ${message.type()}]`, message.text())
			);
		}
		await peerBPage.goto("http://127.0.0.1:18081/healthz");
		const peerB = peerBPage.evaluate(
			async ({ url, iceServers }) => {
				const tick = (ms: number) => {
					const done = Promise.withResolvers<void>();
					setTimeout(done.resolve, ms);
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
					if (signalHandler) {
						void signalHandler(event).catch((error) =>
							console.error("[peerB] signal handler failed", error)
						);
					} else {
						pendingSignals.push(event);
					}
				};

				const pc = new RTCPeerConnection({
					iceServers,
					iceTransportPolicy: "relay",
				});
				const remoteCandidates: RTCIceCandidateInit[] = [];
				let remoteDescriptionSet = false;
				let channel: RTCDataChannel | null = null;
				const video = document.createElement("video");
				video.muted = true;
				video.playsInline = true;
				video.style.display = "none";
				document.body.append(video);
				const done = Promise.withResolvers<{
					remoteType: string | null;
					remotePort: number | null;
					inboundBytes: number;
					framesDecoded: number;
					connectionState: string;
				}>();

				const flushCandidates = async () => {
					while (remoteCandidates.length > 0) {
						try {
							await pc.addIceCandidate(remoteCandidates.shift()!);
						} catch {
							// Late candidates are harmless.
						}
					}
				};

				pc.ontrack = (event) => {
					const stream = event.streams[0] ?? new MediaStream([event.track]);
					video.srcObject = stream;
					void video.play().catch(() => {});
				};

				pc.ondatachannel = (event) => {
					channel = event.channel;
					channel.onmessage = async (message) => {
						if (message.data !== "ready") return;
						for (let attempt = 0; attempt < 150; attempt += 1) {
							const report = await pc.getStats();
							const byId: Record<string, Record<string, unknown>> = {};
							report.forEach((stat, id) => {
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
							const remote = pair?.remoteCandidateId
								? byId[String(pair.remoteCandidateId)]
								: undefined;
							let inboundBytes = 0;
							let framesDecoded = 0;
							for (const stat of Object.values(byId)) {
								if (stat.type === "inbound-rtp") {
									inboundBytes += Number(stat.bytesReceived ?? 0);
									framesDecoded += Number(stat.framesDecoded ?? 0);
								}
							}
							if (inboundBytes > 100_000 && framesDecoded > 10) {
								channel?.send("media-ok");
								done.resolve({
									remoteType: (remote?.candidateType as string) ?? null,
									remotePort: (remote?.port as number) ?? null,
									inboundBytes,
									framesDecoded,
									connectionState: pc.connectionState,
								});
								return;
							}
							await tick(200);
						}
						throw new Error(
							`peer B received no media: ${pc.connectionState}/${pc.iceConnectionState}`
						);
					};
				};

				pc.onicecandidate = (event) => {
					ws.send(
						JSON.stringify({ type: "candidate", candidate: event.candidate })
					);
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

				const timeout = tick(35_000).then(() => {
					throw new Error(
						`peer B media timed out: ${pc.connectionState}/${pc.iceConnectionState}`
					);
				});
				return await Promise.race([done.promise, timeout]);
			},
			{ url: signalUrl, iceServers: config.iceServers }
		);

		const peerA = frame.evaluate(async () => {
			const tick = (ms: number) => {
				const done = Promise.withResolvers<void>();
				setTimeout(done.resolve, ms);
				return done.promise;
			};
			const pageWindow = window as unknown as { __webrtcSignalPort: number };
			const ws = new WebSocket(
				`ws://${location.hostname}:${pageWindow.__webrtcSignalPort}/signal?role=A`
			);
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => {
					resolve();
				};
				ws.onerror = () => reject(new Error("peer A signaling failed"));
			});
			const pendingSignals: MessageEvent[] = [];
			let signalHandler: ((event: MessageEvent) => Promise<void>) | null = null;
			ws.onmessage = (event) => {
				if (signalHandler) {
					void signalHandler(event).catch((error) =>
						console.error("[peerA] signal handler failed", error)
					);
				} else {
					pendingSignals.push(event);
				}
			};

			// Synthetic but real browser media tracks: a changing canvas and an
			// oscillator. They exercise the real encoder/SRTP path without relying
			// on a host camera/microphone or fake-device availability.
			const canvas = document.createElement("canvas");
			canvas.width = 320;
			canvas.height = 240;
			canvas.style.display = "none";
			document.body.append(canvas);
			const context = canvas.getContext("2d")!;
			let frame = 0;
			const draw = setInterval(() => {
				context.fillStyle = `hsl(${frame % 360} 80% 50%)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
				context.fillStyle = "#000";
				context.fillText(String(frame), 10, 30);
				frame += 1;
			}, 33);
			void draw;
			const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
			const audioContext = new AudioContext();
			void audioContext.resume().catch(() => {});
			const oscillator = audioContext.createOscillator();
			oscillator.frequency.value = 440;
			const destination = audioContext.createMediaStreamDestination();
			oscillator.connect(destination);
			oscillator.start();
			const stream = new MediaStream([
				videoTrack,
				destination.stream.getAudioTracks()[0],
			]);
			const pc = new RTCPeerConnection({
				iceServers: [
					{ urls: "stun:stun.l.google.com:19302" },
					{ urls: "turn:attacker.invalid:3478" },
				],
				iceTransportPolicy: "all",
			});
			for (const track of stream.getTracks()) pc.addTrack(track, stream);
			const channel = pc.createDataChannel("media", { ordered: true });
			const remoteCandidates: RTCIceCandidateInit[] = [];
			let remoteDescriptionSet = false;
			const done = Promise.withResolvers<{
				localType: string | null;
				localPort: number | null;
				localUrl: string | null;
				localRelayProtocol: string | null;
				outboundBytes: number;
				tracks: string[];
				connectionState: string;
			}>();

			const flushCandidates = async () => {
				while (remoteCandidates.length > 0) {
					try {
						await pc.addIceCandidate(remoteCandidates.shift()!);
					} catch {
						// Late candidates are harmless.
					}
				}
			};
			let offerSent = false;
			const sendOffer = async () => {
				if (offerSent) return;
				offerSent = true;
				try {
					const offer = await pc.createOffer();
					await pc.setLocalDescription(offer);
					ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
				} catch (error) {
					offerSent = false;
					throw error;
				}
			};

			channel.onopen = () => channel.send("ready");
			channel.onmessage = async (event) => {
				if (event.data !== "media-ok") return;
				const report = await pc.getStats();
				const byId: Record<string, Record<string, unknown>> = {};
				report.forEach((stat, id) => {
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
				const local = pair?.localCandidateId
					? byId[String(pair.localCandidateId)]
					: undefined;
				let outboundBytes = 0;
				for (const stat of Object.values(byId)) {
					if (stat.type === "outbound-rtp") {
						outboundBytes += Number(stat.bytesSent ?? 0);
					}
				}
				done.resolve({
					localType: (local?.candidateType as string) ?? null,
					localPort: (local?.port as number) ?? null,
					localUrl: (local?.url as string) ?? null,
					localRelayProtocol: (local?.relayProtocol as string) ?? null,
					outboundBytes,
					tracks: stream.getTracks().map((track) => track.kind),
					connectionState: pc.connectionState,
				});
			};
			pc.onicecandidate = (event) => {
				ws.send(
					JSON.stringify({ type: "candidate", candidate: event.candidate })
				);
			};
			signalHandler = async (event) => {
				const message = JSON.parse(String(event.data));
				if (message.type === "peer-ready") {
					await sendOffer();
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
			for (const event of pendingSignals) {
				void signalHandler(event).catch((error) =>
					console.error("[peerA] signal handler failed", error)
				);
			}
			void tick(3000).then(() =>
				sendOffer().catch((error) =>
					console.error("[peerA] fallback offer failed", error)
				)
			);

			const timeout = tick(30_000).then(() => {
				throw new Error(
					`peer A media timed out: ${pc.connectionState}/${pc.iceConnectionState}/${channel.readyState}`
				);
			});
			return await Promise.race([done.promise, timeout]);
		});

		const [a, b] = await Promise.all([peerA, peerB]);
		await peerBPage.close();
		const turnBacked =
			a.localType === "relay" ||
			(a.localType === "prflx" &&
				typeof a.localUrl === "string" &&
				/^turns?:/i.test(a.localUrl) &&
				a.localRelayProtocol !== null);

		assert.equal(a.tracks.includes("audio"), true, "audio track added");
		assert.equal(a.tracks.includes("video"), true, "video track added");
		assert.equal(
			turnBacked,
			true,
			`media peer is not TURN-backed: ${JSON.stringify(a)}`
		);
		assert.equal(a.connectionState, "connected");
		assert.equal(b.connectionState, "connected");
		assert.ok(a.outboundBytes > 100_000, `outbound bytes: ${a.outboundBytes}`);
		assert.ok(b.inboundBytes > 100_000, `inbound bytes: ${b.inboundBytes}`);
		assert.ok(b.framesDecoded > 10, `decoded frames: ${b.framesDecoded}`);
		assert.equal(
			b.remotePort,
			a.localPort,
			`media is not flowing through A's selected TURN relay port: ${JSON.stringify(
				{
					aLocalPort: a.localPort,
					bRemotePort: b.remotePort,
					bRemoteType: b.remoteType,
				}
			)}`
		);
	},
});

export default [test];
