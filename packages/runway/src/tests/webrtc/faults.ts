import { turnAction } from "./control.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
	readDataPeer,
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
		name: "webrtc-relay-turn-interruption-and-restart",
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
			let paused = false;
			let linkDown = false;
			try {
				await frame.evaluate(initializeDataPeer, {
					config: { iceTransportPolicy: "all" },
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
				await turnAction("pause");
				paused = true;
				const { offer } = await negotiateDataPeers(frame, peer, true);
				assert.match(offer.description.sdp!, /^m=application/m);
				const message = "while-turn-paused-" + randomUUID();
				await frame.evaluate((value) => {
					if (window.__webrtcPeer.channel?.readyState === "open")
						window.__webrtcPeer.channel.send(value);
				}, message);
				await new Promise((resolve) => setTimeout(resolve, 2500));
				const stopped = await frame.evaluate(readDataPeer);
				assert.equal(
					stopped.echoes.includes(message),
					false,
					"paused TURN must not be bypassed by direct traffic"
				);
				assert.ok(
					stopped.candidates.every((candidate) =>
						/ typ relay(?: |$)/.test(candidate)
					)
				);
				await turnAction("unpause");
				paused = false;
				// Applications rebuild after a failed ICE/SCTP generation. This
				// uses fresh native peers and the same enforced relay boundary.
				await closeDataPeers(frame, peer);
				await frame.evaluate(initializeDataPeer, { config: {}, sender: true });
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
				await frame.evaluate(() =>
					window.__webrtcPeer.channel!.send("after-turn-resume")
				);
				await expectDataEcho(frame, "after-turn-resume");
				await turnAction("restart");
				// A restarted TURN loses its allocations. Rebuild the native
				// session explicitly; callers must not reuse a failed SCTP channel.
				await closeDataPeers(frame, peer);
				await frame.evaluate(initializeDataPeer, { config: {}, sender: true });
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
				await frame.evaluate(() =>
					window.__webrtcPeer.channel!.send("after-turn-restart")
				);
				await expectDataEcho(frame, "after-turn-restart");
				if (enforced) {
					await turnAction("link-down");
					linkDown = true;
					await frame.evaluate(() => {
						const state = window.__webrtcPeer;
						if (state.channel?.readyState === "open")
							state.channel.send("during-network-failure");
						if (state.pc.signalingState !== "closed") state.pc.restartIce();
					});
					await new Promise((resolve) => setTimeout(resolve, 2500));
					assert.equal(
						(await frame.evaluate(readDataPeer)).echoes.includes(
							"during-network-failure"
						),
						false
					);
					await turnAction("link-up");
					linkDown = false;
					// Chromium's network-change notification is asynchronous to netlink.
					await new Promise((resolve) => setTimeout(resolve, 3000));
					await ctx.page.evaluate(() =>
						(window as any).__runwayReconnectTransport()
					);
					await closeDataPeers(frame, peer);
					await frame.evaluate(initializeDataPeer, {
						config: {},
						sender: true,
					});
					await peer.evaluate(initializeDataPeer, {
						config: {
							iceServers: config.iceServers as RTCIceServer[],
							iceTransportPolicy: "relay",
						},
						sender: false,
					});
					await negotiateDataPeers(frame, peer);
					await expectDataEcho(frame);
				}
				assert.equal(
					(await frame.evaluate(readDataPeer)).connection,
					"connected"
				);
			} finally {
				if (linkDown) await turnAction("link-up");
				if (paused) await turnAction("unpause");
				await closeDataPeers(frame, peer);
				await peer.close();
			}
		},
	}),
];
