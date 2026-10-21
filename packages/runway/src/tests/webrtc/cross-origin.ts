import assert from "node:assert/strict";
import { webrtcTest } from "./helpers.ts";

const TURN = "turn:127.0.0.1:13478?transport=udp";

const parentHtml = `<!doctype html>
<html>
	<head>
		<script>
			window.__webrtcTestPage = true;
			window.addEventListener("message", (event) => {
				if (event.data && event.data.type === "webrtc-cross-origin") {
					window.__crossOriginResult = event.data;
				}
			});
		</script>
	</head>
	<body><iframe id="child" src="https://b.test/frame"></iframe></body>
</html>`;

const childHtml = `<!doctype html>
<html>
	<head><script>window.__webrtcTestPage = true;</script></head>
	<body>
		<script>
			try {
				const pc = new RTCPeerConnection({
					iceServers: [
						{ urls: "stun:stun.l.google.com:19302" },
						{ urls: "turn:attacker.invalid:3478" },
					],
					iceTransportPolicy: "all",
				});
				const config = pc.getConfiguration();
				parent.postMessage({
					type: "webrtc-cross-origin",
					policy: config.iceTransportPolicy,
					urls: (config.iceServers || []).flatMap((server) =>
						Array.isArray(server.urls) ? server.urls : [server.urls]
					),
				}, "*");
				pc.close();
			} catch (error) {
				parent.postMessage({
					type: "webrtc-cross-origin",
					error: String(error),
				}, "*");
			}
		</script>
	</body>
</html>`;

export default [
	webrtcTest({
		name: "webrtc-hook-cross-origin-iframe",
		hostname: "a.test",
		cleartextHosts: ["b.test"],
		scheme: "https",
		html: (url) => (url.pathname === "/frame" ? childHtml : parentHtml),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
			failClosed: true,
		},
		async fn(_ctx, frame) {
			await frame.waitForFunction("window.__crossOriginResult", {
				timeout: 15_000,
			});
			const result = await frame.evaluate(() => {
				const pageWindow = window as unknown as {
					__crossOriginResult?: {
						error?: string;
						policy?: string;
						urls?: string[];
					};
				};
				return pageWindow.__crossOriginResult;
			});
			assert.ok(result, "cross-origin child did not post a result");
			assert.equal(result.error, undefined, result.error);
			assert.equal(result.policy, "relay");
			assert.deepEqual(result.urls, [TURN]);
		},
	}),
];
