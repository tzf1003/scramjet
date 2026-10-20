import assert from "node:assert/strict";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	type WebrtcTestConfig,
} from "./helpers.ts";
import {
	initializeDataPeer,
	negotiateDataPeers,
	expectDataEcho,
	closeDataPeers,
} from "./peers.ts";

const enforced = process.env.WEBRTC_TEST_MODE === "enforced";
const config: WebrtcTestConfig = {
	mode: enforced ? "enforced" : "relay",
	iceServers: [],
	networkIsolationVerified: enforced,
};

export default [
	webrtcTest({
		name: "webrtc-relay-local-device-and-display-capture",
		browsers: ["chromium"],
		html: webrtcPageHtml(
			'<button id="start-capture">Share camera and screen</button>'
		),
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
			try {
				await frame.evaluate(initializeDataPeer, { config: {}, sender: true });
				await peer.evaluate(initializeDataPeer, {
					config: {
						iceServers: config.iceServers as RTCIceServer[],
						iceTransportPolicy: "relay",
						bundlePolicy: "max-bundle",
					},
					sender: false,
				});
				await frame.evaluate(() => {
					(window as any).__captureResult = null;
					document.getElementById("start-capture")!.onclick = async () => {
						try {
							const camera = await navigator.mediaDevices.getUserMedia({
								audio: true,
								video: true,
							});
							const screen = await navigator.mediaDevices.getDisplayMedia({
								video: true,
							});
							(window as any).__captureStreams = [camera, screen];
							for (const stream of [camera, screen])
								for (const track of stream.getTracks())
									window.__webrtcPeer.pc.addTrack(track, stream);
							(window as any).__captureResult = {
								audio: camera.getAudioTracks().length,
								camera: camera.getVideoTracks().length,
								screen: screen.getVideoTracks().length,
							};
						} catch (error) {
							(window as any).__captureResult = { error: String(error) };
						}
					};
				});
				await frame.locator("#start-capture").click();
				await frame.waitForFunction(
					"window.__captureResult !== null",
					undefined,
					{ timeout: 20000 }
				);
				const capture = await frame.evaluate(
					() => (window as any).__captureResult
				);
				assert.equal(capture.error, undefined, JSON.stringify(capture));
				assert.deepEqual(capture, { audio: 1, camera: 1, screen: 1 });
				await negotiateDataPeers(frame, peer);
				await expectDataEcho(frame);
				await peer.waitForFunction(
					async () => {
						const report = await window.__webrtcPeer.pc.getStats();
						const videos: any[] = [],
							audio: any[] = [];
						report.forEach((row) => {
							if (row.type === "inbound-rtp")
								(row.kind === "video" ? videos : audio).push(row);
						});
						return (
							videos.length === 2 &&
							videos.every((row) => row.framesDecoded > 3) &&
							audio.some((row) => row.packetsReceived > 3)
						);
					},
					undefined,
					{ timeout: 20000 }
				);
			} finally {
				await frame
					.evaluate(() => {
						for (const stream of (window as any).__captureStreams ?? [])
							for (const track of stream.getTracks()) track.stop();
					})
					.catch(() => {});
				await closeDataPeers(frame, peer);
				await peer.close();
			}
		},
	}),
];
