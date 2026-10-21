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

type StatsFault =
	| "missing-pair"
	| "missing-local"
	| "unselected-transport"
	| "host"
	| "srflx"
	| "unknown"
	| "unauthorized-url"
	| "incomplete-unauthorized-url";

function statsFaultTest(mode: StatsFault, recovers = false) {
	return webrtcTest({
		name: "webrtc-relay-stats-" + mode + (recovers ? "-recovers" : "-closes"),
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
				const pageWindow = window as any;
				if (pageWindow.__webrtcStatsFaultInstalled) return;
				pageWindow.__webrtcStatsFaultInstalled = true;
				const getStats = RTCPeerConnection.prototype.getStats;
				const forEach = RTCStatsReport.prototype.forEach;
				const injected = new WeakMap<RTCStatsReport, any>();
				pageWindow.__webrtcNativeStats = async (pc: RTCPeerConnection) => {
					const entries: any[] = [];
					const report = await Reflect.apply(getStats, pc, []);
					Reflect.apply(forEach, report, [(entry: any) => entries.push(entry)]);
					return entries;
				};
				RTCPeerConnection.prototype.getStats = async function (...args) {
					const report = await Reflect.apply(getStats, this, args);
					const fault = pageWindow.__webrtcStatsFault;
					if (fault?.target === this) {
						fault.samples++;
						if (!fault.recovers || fault.samples <= 3) {
							fault.incompleteSamples++;
							injected.set(report, fault);
						}
					}
					return report;
				};
				RTCStatsReport.prototype.forEach = function (callback, thisArg) {
					const fault = injected.get(this);
					if (!fault) return Reflect.apply(forEach, this, [callback, thisArg]);
					const entries = new Map<string, any>();
					Reflect.apply(forEach, this, [
						(entry: any, id: string) => entries.set(id, entry),
					]);
					if (fault.mode === "missing-pair") {
						entries.set("incomplete", {
							id: "incomplete",
							type: "transport",
							dtlsState: "connected",
							selectedCandidatePairId: "unreported",
						});
					} else if (fault.mode === "unselected-transport") {
						entries.set("incomplete", {
							id: "incomplete",
							type: "transport",
							dtlsState: "connected",
						});
					} else {
						// Put the incomplete transport first to exercise unsafe-evidence precedence.
						const native = [...entries];
						entries.clear();
						entries.set("incomplete", {
							id: "incomplete",
							type: "transport",
							selectedCandidatePairId: "unreported",
						});
						for (const [id, entry] of native) entries.set(id, entry);
						entries.set("fault-transport", {
							id: "fault-transport",
							type: "transport",
							selectedCandidatePairId: "fault-pair",
						});
						entries.set("fault-pair", {
							id: "fault-pair",
							type: "candidate-pair",
							localCandidateId: "fault-local",
						});
						if (fault.mode !== "missing-local") {
							const unauthorized = fault.mode.includes("unauthorized-url");
							entries.set("fault-local", {
								id: "fault-local",
								type: "local-candidate",
								candidateType:
									fault.mode === "incomplete-unauthorized-url"
										? undefined
										: unauthorized
											? "relay"
											: fault.mode,
								url: unauthorized
									? "turn:unauthorized.invalid:3478"
									: undefined,
							});
						}
					}
					for (const [id, entry] of entries)
						callback.call(thisArg, entry, id, this);
				};
			});
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(
				async ({ mode, recovers }) => {
					const a = new RTCPeerConnection(),
						b = new RTCPeerConnection();
					const channel = a.createDataChannel("stats-retry");
					const echoes = new Set<string>();
					channel.onmessage = (event) => echoes.add(event.data);
					b.ondatachannel = (event) => {
						event.channel.onmessage = (message) =>
							event.channel.send(message.data);
					};
					const until = async (predicate: () => boolean, message: string) => {
						const deadline = Date.now() + 10_000;
						while (!predicate()) {
							if (Date.now() >= deadline) throw new Error(message);
							await new Promise((resolve) => setTimeout(resolve, 50));
						}
					};
					const pageWindow = window as any;
					try {
						await a.setLocalDescription(await a.createOffer());
						await until(
							() => a.iceGatheringState === "complete",
							"offer gathering timeout"
						);
						await b.setRemoteDescription(a.localDescription!);
						await b.setLocalDescription(await b.createAnswer());
						await until(
							() => b.iceGatheringState === "complete",
							"answer gathering timeout"
						);
						await a.setRemoteDescription(b.localDescription!);
						await until(
							() => channel.readyState === "open",
							"channel open timeout"
						);
						channel.send("before-fault");
						await until(
							() => echoes.has("before-fault"),
							"initial native echo timeout"
						);
						const nativeBefore = await pageWindow.__webrtcNativeStats(a);
						await new Promise((resolve) => setTimeout(resolve, 1100));
						const fault = (pageWindow.__webrtcStatsFault = {
							target: a,
							mode,
							recovers,
							samples: 0,
							incompleteSamples: 0,
						});
						if (recovers) {
							await until(
								() => fault.samples >= 5 || a.connectionState === "closed",
								"statistics recovery timeout"
							);
							if (a.connectionState !== "closed") {
								channel.send("after-recovery");
								await until(
									() => echoes.has("after-recovery"),
									"recovered native echo timeout"
								);
							}
						} else {
							await until(
								() => a.connectionState === "closed",
								"candidate verification did not close"
							);
						}
						const nativeAfter =
							a.connectionState === "closed"
								? []
								: await pageWindow.__webrtcNativeStats(a);
						return {
							samples: fault.samples,
							incompleteSamples: fault.incompleteSamples,
							closed: a.connectionState === "closed",
							recoveredEcho: echoes.has("after-recovery"),
							nativeBefore,
							nativeAfter,
						};
					} finally {
						delete pageWindow.__webrtcStatsFault;
						a.close();
						b.close();
					}
				},
				{ mode, recovers }
			);
			assert.ok(
				result.nativeBefore.some(
					(stat: any) =>
						stat.type === "local-candidate" && stat.candidateType === "relay"
				),
				"fault must follow an established native relay echo"
			);
			if (recovers) {
				assert.equal(
					result.closed,
					false,
					"transient incomplete statistics must keep the relay connected"
				);
				assert.equal(result.incompleteSamples, 3);
				assert.ok(
					result.samples >= 5,
					"verification must resume periodic monitoring after recovery"
				);
				assert.equal(result.recoveredEcho, true);
				assert.ok(
					result.nativeAfter.some(
						(stat: any) =>
							stat.type === "local-candidate" && stat.candidateType === "relay"
					)
				);
			} else {
				assert.equal(result.closed, true);
				assert.equal(
					result.samples,
					["missing-pair", "missing-local", "unselected-transport"].includes(
						mode
					)
						? 6
						: 1,
					"incomplete statistics exhaust bounded retries; observed unsafe evidence closes immediately"
				);
			}
		},
	});
}

export default [
	statsFaultTest("missing-pair", true),
	statsFaultTest("missing-local", true),
	statsFaultTest("unselected-transport", true),
	statsFaultTest("missing-pair"),
	statsFaultTest("missing-local"),
	statsFaultTest("unselected-transport"),
	statsFaultTest("host"),
	statsFaultTest("srflx"),
	statsFaultTest("unknown"),
	statsFaultTest("unauthorized-url"),
	statsFaultTest("incomplete-unauthorized-url"),
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
