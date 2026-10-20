import assert from "node:assert/strict";
import { fetchTurnCredentials } from "./fixtures.ts";
import {
	webrtcPageHtml,
	webrtcTest,
	type WebrtcTestConfig,
} from "./helpers.ts";

const config: WebrtcTestConfig = {
	mode: "enforced",
	iceServers: [],
	failClosed: true,
	networkIsolationVerified: true,
};

export default [
	webrtcTest({
		name: "webrtc-relay-stats-failure-closes-real-connection",
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
		async preparePage(page) {
			await page.addInitScript(() => {
				const original = RTCPeerConnection.prototype.getStats;
				RTCPeerConnection.prototype.getStats = function (...args) {
					if ((window as any).__webrtcBreakStats)
						return Promise.reject(new Error("injected statistics failure"));
					return Reflect.apply(original, this, args);
				};
			});
		},
		async fn(_ctx, frame) {
			const value = await frame.evaluate(async () => {
				const a = new RTCPeerConnection(),
					b = new RTCPeerConnection();
				const channel = a.createDataChannel("verification");
				const received = Promise.withResolvers<void>();
				b.ondatachannel = (event) => {
					event.channel.onmessage = () => received.resolve();
				};
				const gather = async (pc: RTCPeerConnection) => {
					if (pc.iceGatheringState === "complete") return;
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error("gathering timeout")),
							10000
						);
						pc.addEventListener("icegatheringstatechange", () => {
							if (pc.iceGatheringState === "complete") {
								clearTimeout(timer);
								resolve();
							}
						});
					});
				};
				try {
					await a.setLocalDescription(await a.createOffer());
					await gather(a);
					await b.setRemoteDescription(a.localDescription!);
					await b.setLocalDescription(await b.createAnswer());
					await gather(b);
					await a.setRemoteDescription(b.localDescription!);
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error("data channel timeout")),
							10000
						);
						channel.onopen = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					channel.send("real-network-control");
					await received.promise;
					(window as any).__webrtcBreakStats = true;
					for (let attempt = 0; attempt < 100; attempt++) {
						if (
							a.connectionState === "closed" &&
							b.connectionState === "closed"
						)
							return true;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					return false;
				} finally {
					a.close();
					b.close();
				}
			});
			assert.equal(
				value,
				true,
				"a real established connection must close when candidate verification fails"
			);
		},
	}),
];
