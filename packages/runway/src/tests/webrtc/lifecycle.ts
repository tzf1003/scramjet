import assert from "node:assert/strict";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	type WebrtcTestConfig,
} from "./helpers.ts";

const config: WebrtcTestConfig = {
	mode: process.env.WEBRTC_TEST_MODE === "enforced" ? "enforced" : "relay",
	networkIsolationVerified: process.env.WEBRTC_TEST_MODE === "enforced",
	iceServers: [],
	failClosed: true,
};

export default [
	webrtcTest({
		name: "webrtc-relay-media-and-channel-lifecycle",
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
		},
		async fn(ctx, frame) {
			const peer = await ctx.page.context().newPage();
			await peer.goto(
				new URL(
					"/healthz",
					process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081"
				).href
			);
			const initialize = async ({
				servers,
				sender,
			}: {
				servers: RTCIceServer[];
				sender: boolean;
			}) => {
				const pc = new RTCPeerConnection({
					iceServers: servers,
					iceTransportPolicy: "relay",
					bundlePolicy: "max-bundle",
				});
				const state: any = {
					pc,
					channels: {},
					echoes: [],
					streams: [],
					senders: [],
					resources: [],
					tracks: [],
					receivers: [],
					audioNodes: [],
				};
				(window as any).__rtcLifecycle = state;
				const channel = (dc: RTCDataChannel) => {
					dc.binaryType = "arraybuffer";
					state.channels[dc.label] = dc;
					dc.onmessage = async (event) => {
						const data =
							event.data instanceof Blob
								? await event.data.arrayBuffer()
								: event.data;
						if (!sender) dc.send(data);
						else if (typeof data === "string") state.echoes.push(data);
						else {
							const digest = await crypto.subtle.digest("SHA-256", data);
							state.echoes.push(
								[...new Uint8Array(digest)]
									.map((value) => value.toString(16).padStart(2, "0"))
									.join("")
							);
						}
					};
				};
				pc.ondatachannel = (event) => channel(event.channel);
				pc.ontrack = (event) => {
					state.tracks.push(event.track.kind);
					const item: any = {
						receiver: event.receiver,
						transceiver: event.transceiver,
						track: event.track,
					};
					if (event.track.kind === "video") {
						const video = document.createElement("video");
						video.muted = true;
						video.autoplay = true;
						video.playsInline = true;
						video.width = 160;
						video.height = 120;
						video.srcObject = new MediaStream([event.track]);
						document.body.append(video);
						void video.play().catch(() => {});
						item.video = video;
						item.media = video;
						item.canvas = document.createElement("canvas");
						item.canvas.width = item.canvas.height = 8;
					} else {
						const playback = document.createElement("audio");
						playback.srcObject = new MediaStream([event.track]);
						playback.autoplay = true;
						playback.volume = 0;
						document.body.append(playback);
						item.media = playback;
						void playback.play().catch(() => {});
						state.audio ??= new AudioContext();
						const source = state.audio.createMediaStreamSource(
							new MediaStream([event.track])
						);
						item.analyser = state.audio.createAnalyser();
						item.analyser.fftSize = 2048;
						source.connect(item.analyser);
						const mute = state.audio.createGain();
						mute.gain.value = 0;
						item.analyser.connect(mute);
						mute.connect(state.audio.destination);
						state.audioNodes.push(source, item.analyser, mute);
					}
					state.receivers.push(item);
				};
				const unlock = document.createElement("button");
				unlock.id = "webrtc-unlock-audio";
				unlock.textContent = "Start media";
				unlock.onclick = () => {
					const active = state.receivers.filter((item: any) =>
						["recvonly", "sendrecv"].includes(item.transceiver.currentDirection)
					);
					let timer: ReturnType<typeof setTimeout>;
					state.activation = Promise.race([
						Promise.all([
							state.audio?.resume(),
							...active.map((item: any) => item.media.play()),
						]),
						new Promise((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error(
											"media activation timed out: " +
												JSON.stringify({
													audioState: state.audio?.state,
													tracks: active.map((item: any) => ({
														kind: item.track.kind,
														trackState: item.track.readyState,
														muted: item.track.muted,
														paused: item.media.paused,
														readyState: item.media.readyState,
													})),
												})
										)
									),
								10000
							);
						}),
					])
						.then(() => {
							state.activationError = null;
						})
						.catch((error) => {
							state.activationError = String(error);
						})
						.finally(() => clearTimeout(timer));
				};
				document.body.append(unlock);
				if (sender) {
					channel(pc.createDataChannel("initial"));
					const canvas = document.createElement("canvas");
					canvas.width = 320;
					canvas.height = 240;
					const painter = canvas.getContext("2d")!;
					let index = 0;
					state.resources.push(
						setInterval(() => {
							painter.fillStyle = `hsl(${index++ % 360} 80% 50%)`;
							painter.fillRect(0, 0, 320, 240);
						}, 33)
					);
					const video = canvas.captureStream(30);
					const audio = new AudioContext();
					void audio.resume().catch(() => {});
					const oscillator = audio.createOscillator();
					oscillator.frequency.value = 440;
					const destination = audio.createMediaStreamDestination();
					oscillator.connect(destination);
					oscillator.start();
					state.audio = audio;
					state.oscillator = oscillator;
					state.audioNodes.push(oscillator, destination);
					state.streams.push(video, destination.stream);
					for (const stream of state.streams)
						for (const track of stream.getTracks())
							state.senders.push(pc.addTrack(track, stream));
					state.canvas = canvas;
				}
			};
			try {
				await peer.evaluate(initialize, {
					servers: config.iceServers as RTCIceServer[],
					sender: false,
				});
				await frame.evaluate(initialize, {
					servers: config.iceServers as RTCIceServer[],
					sender: true,
				});
				await frame.locator("#webrtc-unlock-audio").click();
				await frame.evaluate(async () => {
					const state = (window as any).__rtcLifecycle;
					await state.activation;
					if (state.activationError) throw new Error(state.activationError);
					if (state.audio.state !== "running")
						throw new Error(`sender audio is ${state.audio.state}`);
				});
				const mediaSeconds = Number(
					process.env.WEBRTC_MEDIA_SOAK_SECONDS ?? 2.5
				);
				assert.ok(
					Number.isFinite(mediaSeconds) &&
						mediaSeconds >= 2.5 &&
						mediaSeconds <= 86400
				);
				const verifyMedia = async (expected: {
					audio: number;
					video: number;
				}) => {
					await peer.bringToFront();
					await peer.locator("#webrtc-unlock-audio").click();
					const observed = await peer.evaluate(async (seconds) => {
						const state = (window as any).__rtcLifecycle;
						await state.activation;
						if (state.activationError) throw new Error(state.activationError);
						const active = state.receivers.filter((item: any) =>
							["recvonly", "sendrecv"].includes(
								item.transceiver.currentDirection
							)
						);
						const before = new Map<string, { bytes: number; units: number }>();
						const content = new Map<any, Set<string>>();
						let audioRms = 0;
						const rows: any[] = [];
						for (let sample = 0; sample < Math.ceil(seconds * 10); sample++) {
							rows.length = 0;
							for (const item of active) {
								const report = await item.receiver.getStats();
								report.forEach((stat: any) => {
									if (stat.type !== "inbound-rtp") return;
									const units =
										item.track.kind === "video"
											? stat.framesDecoded
											: stat.packetsReceived;
									if (!before.has(stat.id))
										before.set(stat.id, {
											bytes: stat.bytesReceived ?? 0,
											units: units ?? 0,
										});
									const first = before.get(stat.id)!;
									rows.push({
										id: stat.id,
										kind: item.track.kind,
										bytesDelta: (stat.bytesReceived ?? 0) - first.bytes,
										unitsDelta: (units ?? 0) - first.units,
										jitterSeconds: stat.jitter ?? null,
										packetsLost: stat.packetsLost ?? null,
									});
								});
								if (item.video?.readyState >= 2) {
									const painter = item.canvas.getContext("2d");
									painter.drawImage(item.video, 0, 0, 8, 8);
									const data = painter.getImageData(0, 0, 8, 8).data;
									const colors = content.get(item) ?? new Set<string>();
									colors.add(`${data[0]},${data[1]},${data[2]}`);
									content.set(item, colors);
								}
								if (item.analyser) {
									const values = new Float32Array(2048);
									item.analyser.getFloatTimeDomainData(values);
									audioRms = Math.max(
										audioRms,
										Math.sqrt(
											values.reduce((sum, value) => sum + value * value, 0) /
												values.length
										)
									);
								}
							}
							await new Promise((resolve) => setTimeout(resolve, 100));
						}
						return {
							rows,
							audioRms,
							audioState: state.audio?.state,
							videoColorCounts: active
								.filter((item: any) => item.video)
								.map((item: any) => content.get(item)?.size ?? 0),
						};
					}, mediaSeconds);
					assert.equal(
						observed.rows.filter((row: any) => row.kind === "audio").length,
						expected.audio
					);
					assert.equal(
						observed.rows.filter((row: any) => row.kind === "video").length,
						expected.video
					);
					for (const row of observed.rows) {
						assert.ok(
							row.bytesDelta > 0 && row.unitsDelta > 0,
							`active track stalled: ${JSON.stringify(row)}`
						);
					}
					assert.equal(observed.videoColorCounts.length, expected.video);
					assert.ok(
						observed.videoColorCounts.every((count: number) => count >= 3),
						`received video must change: ${JSON.stringify(observed)}`
					);
					if (expected.audio)
						assert.ok(
							observed.audioRms > 0.01,
							`received audio must contain signal: ${observed.audioRms}`
						);
					console.log(
						"WebRTC per-track media:",
						JSON.stringify({ expected, ...observed })
					);
				};
				const localDescription = async (offer: boolean) => {
					const pc = (window as any).__rtcLifecycle.pc as RTCPeerConnection;
					await pc.setLocalDescription(
						offer ? await pc.createOffer() : await pc.createAnswer()
					);
					await new Promise<void>((resolve, reject) => {
						const timeout = setTimeout(
							() => reject(new Error("ICE gathering timed out")),
							10000
						);
						const check = () => {
							if (pc.iceGatheringState === "complete") {
								clearTimeout(timeout);
								resolve();
							}
						};
						pc.addEventListener("icegatheringstatechange", check);
						check();
					});
					return pc.localDescription!.toJSON();
				};
				const negotiate = async () => {
					const offer = await frame.evaluate(localDescription, true);
					await peer.evaluate(
						(description) =>
							(window as any).__rtcLifecycle.pc.setRemoteDescription(
								description
							),
						offer
					);
					const answer = await peer.evaluate(localDescription, false);
					await frame.evaluate(
						(description) =>
							(window as any).__rtcLifecycle.pc.setRemoteDescription(
								description
							),
						answer
					);
				};
				await negotiate();
				try {
					await frame.waitForFunction(
						() =>
							(window as any).__rtcLifecycle.channels.initial.readyState ===
							"open",
						{ timeout: 20000 }
					);
				} catch (error) {
					const state = await frame.evaluate(() => {
						const value = (window as any).__rtcLifecycle;
						return {
							connection: value.pc.connectionState,
							ice: value.pc.iceConnectionState,
							signaling: value.pc.signalingState,
							gathering: value.pc.iceGatheringState,
							channels: Object.keys(value.channels),
							remote: value.pc.remoteDescription ? "set" : "unset",
						};
					});
					throw new Error(
						`initial DataChannel did not open: ${JSON.stringify(state)} (${String(error)})`
					);
				}
				await verifyMedia({ audio: 1, video: 1 });
				const blob = await frame.evaluate(async () => {
					const state = (window as any).__rtcLifecycle;
					const bytes = new Uint8Array(32768).map((_, index) => index % 251);
					const digest = await crypto.subtle.digest("SHA-256", bytes);
					const hash = [...new Uint8Array(digest)]
						.map((value) => value.toString(16).padStart(2, "0"))
						.join("");
					state.channels.initial.send(new Blob([bytes]));
					return hash;
				});
				await frame.waitForFunction(
					(hash) => (window as any).__rtcLifecycle.echoes.includes(hash),
					blob
				);
				await frame.evaluate(async () => {
					const state = (window as any).__rtcLifecycle;
					const sender = state.senders.find(
						(value: RTCRtpSender) => value.track?.kind === "video"
					);
					const replacement = state.canvas
						.captureStream(20)
						.getVideoTracks()[0];
					state.streams.push(new MediaStream([replacement]));
					await sender.replaceTrack(replacement);
					state.pc.removeTrack(
						state.senders.find(
							(value: RTCRtpSender) => value.track?.kind === "audio"
						)
					);
				});
				await negotiate();
				await verifyMedia({ audio: 0, video: 1 });
				await frame.evaluate(() => {
					const state = (window as any).__rtcLifecycle;
					const audio = state.audio.createMediaStreamDestination();
					state.oscillator.connect(audio);
					state.audioNodes.push(audio);
					state.streams.push(audio.stream);
					state.pc.addTrack(audio.stream.getAudioTracks()[0], audio.stream);
					const extra = state.canvas.captureStream(15);
					state.streams.push(extra);
					state.pc.addTransceiver(extra.getVideoTracks()[0], {
						direction: "sendonly",
						streams: [extra],
					});
				});
				await negotiate();
				await verifyMedia({ audio: 1, video: 2 });
				await frame.evaluate(() => {
					const state = (window as any).__rtcLifecycle;
					state.channels.initial.close();
					const channel = state.pc.createDataChannel("rebuilt", {
						ordered: false,
						maxPacketLifeTime: 1000,
					});
					state.channels.rebuilt = channel;
					channel.onopen = () => channel.send("rebuilt-channel");
					channel.onmessage = (event: MessageEvent) =>
						state.echoes.push(event.data);
				});
				await frame.waitForFunction(() =>
					(window as any).__rtcLifecycle.echoes.includes("rebuilt-channel")
				);
				const metrics = await frame.evaluate(async () => {
					const state = (window as any).__rtcLifecycle;
					const samples: number[] = [];
					for (let index = 0; index < 10; index++) {
						const message = `latency-${index}`;
						const started = performance.now();
						state.channels.rebuilt.send(message);
						while (!state.echoes.includes(message))
							await new Promise((resolve) => setTimeout(resolve, 1));
						samples.push(performance.now() - started);
					}
					return {
						applicationRttMs: samples,
						meanRttMs: samples.reduce((a, b) => a + b) / samples.length,
					};
				});
				console.log("WebRTC lifecycle measurements:", JSON.stringify(metrics));
				const result = await frame.evaluate(() => {
					const state = (window as any).__rtcLifecycle;
					return {
						policy: state.pc.getConfiguration().iceTransportPolicy,
						state: state.pc.connectionState,
						partial: state.channels.rebuilt.maxPacketLifeTime,
						old: state.channels.initial.readyState,
					};
				});
				assert.equal(result.policy, "relay");
				assert.equal(result.state, "connected");
				assert.equal(result.partial, 1000);
				assert.equal(result.old, "closed");
			} finally {
				const cleanup = () => {
					const state = (window as any).__rtcLifecycle;
					if (!state) return;
					state.pc.close();
					for (const id of state.resources) clearInterval(id);
					for (const stream of state.streams)
						for (const track of stream.getTracks()) track.stop();
					state.oscillator?.stop();
					void state.audio?.close();
				};
				await frame.evaluate(cleanup).catch(() => {});
				await peer.evaluate(cleanup).catch(() => {});
				await peer.close();
			}
		},
	}),
];
