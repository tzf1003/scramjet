import assert from "node:assert/strict";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	type WebrtcTestConfig,
} from "./helpers.ts";

const config: WebrtcTestConfig = {
	mode: "relay",
	iceServers: [],
	failClosed: true,
};

export default [
	webrtcTest({
		name: "webrtc-relay-media-and-channel-lifecycle",
		browsers: ["chromium"],
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
				});
				const state: any = {
					pc,
					channels: {},
					echoes: [],
					streams: [],
					senders: [],
					resources: [],
					tracks: [],
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
				pc.ontrack = (event) => state.tracks.push(event.track.kind);
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
				await frame.evaluate(() => {
					const state = (window as any).__rtcLifecycle;
					const audio = state.audio.createMediaStreamDestination();
					state.oscillator.connect(audio);
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
				await peer.waitForFunction(
					async () => {
						const report = await (window as any).__rtcLifecycle.pc.getStats();
						let audio = 0,
							video = 0;
						report.forEach((stat: any) => {
							if (stat.type === "inbound-rtp" && stat.kind === "audio")
								audio += stat.totalSamplesReceived ?? 0;
							if (stat.type === "inbound-rtp" && stat.kind === "video")
								video += stat.framesDecoded ?? 0;
						});
						return (
							audio > 1000 &&
							video > 20 &&
							(window as any).__rtcLifecycle.tracks.filter(
								(kind: string) => kind === "video"
							).length >= 2
						);
					},
					{ timeout: 20000 }
				);
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
