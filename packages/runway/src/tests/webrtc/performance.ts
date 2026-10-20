import { turnAction } from "./control.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright";
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

async function measure() {
	const state = window.__webrtcPeer;
	const channel = state.channel!;
	state.echoes.length = 0;
	const rttMs: number[] = [];
	for (let index = 0; index < 30; index++) {
		const value = `rtt-${index}`;
		const started = performance.now();
		channel.send(value);
		while (!state.echoes.includes(value)) {
			if (performance.now() - started > 10000)
				throw new Error("RTT sample timed out");
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		rttMs.push(performance.now() - started);
	}
	state.echoes.length = 0;
	const messages = Array.from(
		{ length: 64 },
		(_, index) => `${index}:` + "payload".repeat(2340)
	);
	const started = performance.now();
	for (const message of messages) {
		while (channel.bufferedAmount > 262144) {
			if (performance.now() - started > 30000)
				throw new Error("DataChannel backpressure did not drain");
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		channel.send(message);
	}
	while (state.echoes.length < messages.length) {
		if (performance.now() - started > 30000)
			throw new Error("throughput sample timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	const elapsedMs = performance.now() - started;
	if (messages.some((value, index) => state.echoes[index] !== value))
		throw new Error("benchmark data integrity mismatch");
	const hash = async (value: string) =>
		Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
			),
			(item) => item.toString(16).padStart(2, "0")
		).join("");
	const expectedSha256 = await hash(messages.join(""));
	const receivedSha256 = await hash(state.echoes.join(""));
	const payloadBytes = messages.reduce((sum, value) => sum + value.length, 0);
	state.echoes.length = 0;
	return {
		rttMs,
		payloadBytes,
		elapsedMs,
		roundTripMiBPerSecond: (payloadBytes * 2) / 1048576 / (elapsedMs / 1000),
		expectedSha256,
		receivedSha256,
	};
}

const enforced = process.env.WEBRTC_TEST_MODE === "enforced";
let ttlSeconds = 0;
const config: WebrtcTestConfig = {
	mode: enforced ? "enforced" : "relay",
	iceServers: [],
	credentialEndpoint:
		process.env.TURN_CREDENTIALS_URL ??
		"http://127.0.0.1:18081/turn-credentials",
	networkIsolationVerified: enforced,
};

export default [
	webrtcTest({
		name: "webrtc-relay-performance-and-resource-lifecycle",
		browsers: ["chromium"],
		html: webrtcPageHtml(),
		config,
		async prepare() {
			const value = await fetchTurnCredentials();
			ttlSeconds = value.ttl;
			config.iceServers = [
				{
					urls: value.urls,
					username: value.username,
					credential: value.credential,
				},
			];
			config.iceServersExpiresAt = Date.now() + value.ttl * 1000;
		},
		async fn(ctx, frame) {
			const seconds = Number(process.env.WEBRTC_SOAK_SECONDS ?? 15);
			assert.ok(
				Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400,
				"WEBRTC_SOAK_SECONDS must be 1..86400"
			);
			const outside = await chromium.launch({
				executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
				args: [
					"--no-sandbox",
					"--disable-features=WebRtcHideLocalIpsWithMdns",
					"--unsafely-treat-insecure-origin-as-secure=http://10.200.0.1:18081",
				],
			});
			const a = await outside.newPage(),
				b = await outside.newPage();
			const cdp = await ctx.page.context().newCDPSession(ctx.page);
			try {
				const url = new URL(
					"/healthz",
					process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081"
				).href;
				await a.goto(url);
				await b.goto(url);
				await a.evaluate(initializeDataPeer, { config: {}, sender: true });
				await b.evaluate(initializeDataPeer, { config: {}, sender: false });
				await negotiateDataPeers(a, b);
				await expectDataEcho(a);
				const baseline = await a.evaluate(measure);
				const initialSockets = await turnAction("snapshot");
				const socketsBefore = initialSockets.ownedRelaySockets;
				await closeDataPeers(a, b);
				await cdp.send("Performance.enable");
				const before = await cdp.send("Performance.getMetrics");
				await frame.evaluate(initializeDataPeer, { config: {}, sender: true });
				// Peer B lives outside the isolated client namespace, so its observed
				// remote address can be compared with A's Linux relay allocation.
				await b.evaluate(initializeDataPeer, {
					config: {
						iceServers: config.iceServers as RTCIceServer[],
						iceTransportPolicy: "relay",
						bundlePolicy: "max-bundle",
					},
					sender: false,
				});
				await negotiateDataPeers(frame, b);
				await expectDataEcho(frame);
				const relay = await frame.evaluate(measure);
				const liveSockets = await turnAction("snapshot");
				const socketsLive = liveSockets.ownedRelaySockets;
				const allocatedIds = liveSockets.relaySocketIds.filter(
					(id: string) => !initialSockets.relaySocketIds.includes(id)
				);
				assert.ok(
					allocatedIds.length > 0,
					"real relay sockets must be allocated"
				);
				assert.equal(relay.expectedSha256, relay.receivedSha256);
				const selected = async () => {
					const stats = await window.__webrtcPeer.pc.getStats();
					const transport = [...stats.values()].find(
						(row: any) =>
							row.type === "transport" && row.selectedCandidatePairId
					);
					const pair: any = transport
						? stats.get((transport as any).selectedCandidatePairId)
						: [...stats.values()].find(
								(row: any) =>
									row.type === "candidate-pair" &&
									row.nominated &&
									row.state === "succeeded"
							);
					return {
						relayCandidates: window.__webrtcPeer.candidates
							.filter((line) => / typ relay(?: |$)/.test(line))
							.map((line) => {
								const parts = line.split(/\s+/);
								return { address: parts[4], port: Number(parts[5]) };
							}),
						local: stats.get(pair.localCandidateId),
						remote: stats.get(pair.remoteCandidateId),
						bytesSent: pair.bytesSent,
						bytesReceived: pair.bytesReceived,
						currentRoundTripTime: pair.currentRoundTripTime,
					};
				};
				const clientPair = await frame.evaluate(selected),
					peerPair = await b.evaluate(selected);
				assert.ok(
					clientPair.relayCandidates.some(
						(candidate) =>
							candidate.address === peerPair.remote.address &&
							candidate.port === peerPair.remote.port
					),
					`outside peer must observe an actual TURN allocation: ${JSON.stringify({ clientPair, peerPair })}`
				);
				assert.ok(clientPair.bytesSent > 0 && clientPair.bytesReceived > 0);
				let currentUsername = (await frame.evaluate(readDataPeer)).username;
				let credentialRotations = 0;
				for (let index = 0; index < seconds; index++) {
					const username = (await frame.evaluate(readDataPeer)).username;
					if (username !== currentUsername) {
						const value = await fetchTurnCredentials();
						await b.evaluate(
							(servers) =>
								window.__webrtcPeer.pc.setConfiguration({
									...window.__webrtcPeer.pc.getConfiguration(),
									iceTransportPolicy: "relay",
									iceServers: servers,
								}),
							[
								{
									urls: value.urls,
									username: value.username,
									credential: value.credential,
								},
							]
						);
						await negotiateDataPeers(frame, b);
						currentUsername = username;
						credentialRotations++;
					}
					const value = `soak-${index}`;
					await frame.evaluate(
						(message) => window.__webrtcPeer.channel!.send(message),
						value
					);
					await expectDataEcho(frame, value);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
				if (seconds >= ttlSeconds)
					assert.ok(
						credentialRotations > 0,
						"a long run must exercise real credential rotation"
					);
				await closeDataPeers(frame, b);
				for (let cycle = 0; cycle < 3; cycle++) {
					const fresh = await fetchTurnCredentials();
					await frame.evaluate(initializeDataPeer, {
						config: {},
						sender: true,
					});
					await b.evaluate(initializeDataPeer, {
						config: {
							iceServers: [
								{
									urls: fresh.urls,
									username: fresh.username,
									credential: fresh.credential,
								},
							],
							iceTransportPolicy: "relay",
							bundlePolicy: "max-bundle",
						},
						sender: false,
					});
					await negotiateDataPeers(frame, b);
					await expectDataEcho(frame);
					await closeDataPeers(frame, b);
					await frame.waitForFunction(
						() =>
							window.__webrtcPeer.pc.connectionState === "closed" &&
							window.__webrtcPeer.channel?.readyState === "closed"
					);
				}
				let socketsAfter = Infinity;
				let retainedIds = allocatedIds;
				for (let attempt = 0; attempt < 100; attempt++) {
					const snapshot = await turnAction("snapshot");
					socketsAfter = snapshot.ownedRelaySockets;
					retainedIds = snapshot.relaySocketIds.filter(
						(id: string) => !initialSockets.relaySocketIds.includes(id)
					);
					if (socketsAfter <= socketsBefore && retainedIds.length === 0) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				assert.ok(
					socketsAfter <= socketsBefore && retainedIds.length === 0,
					`relay sockets were not released: ${socketsBefore} -> ${socketsAfter}`
				);
				const after = await cdp.send("Performance.getMetrics");
				const metrics = (rows: {
					metrics: Array<{ name: string; value: number }>;
				}) =>
					Object.fromEntries(
						rows.metrics
							.filter((item) =>
								["JSHeapUsedSize", "JSHeapTotalSize", "TaskDuration"].includes(
									item.name
								)
							)
							.map((item) => [item.name, item.value])
					);
				console.log(
					"WebRTC measured baseline/relay:",
					JSON.stringify({
						baseline,
						relay,
						soakSeconds: seconds,
						credentialRotations,
						socketsBefore,
						socketsLive,
						socketsAfter,
						reconstructions: 3,
						clientPair,
						peerPair,
						pageMetricsBefore: metrics(before),
						pageMetricsAfter: metrics(after),
					})
				);
			} finally {
				await closeDataPeers(frame, a, b);
				await cdp.detach();
				await outside.close();
			}
		},
	}),
];
