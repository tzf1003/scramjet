import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { webrtcPageHtml, webrtcTest } from "./helpers.ts";

const TURN = "turn:127.0.0.1:13478?transport=udp";
const ATTACKER = "turn:127.0.0.1:9?transport=udp";

const tests = (["relay", "enforced"] as const).map((mode) =>
	webrtcTest({
		name: `webrtc-hook-protected-policy-${mode}`,
		html: webrtcPageHtml(),
		config: {
			mode,
			iceServers: [{ urls: TURN, username: "authorised", credential: "test" }],
			failClosed: true,
			networkIsolationVerified: true,
		},
		async fn(_ctx, frame) {
			const result = await frame.evaluate(
				({ attacker }) => {
					const apply = Reflect.apply;
					const map = Array.prototype.map;
					const iterator = Array.prototype[Symbol.iterator];
					const weakGet = WeakMap.prototype.get;
					const setHas = Set.prototype.has;
					const call = Function.prototype.call;
					const outputs: Array<{ policy: string | undefined; urls: string[] }> =
						[];
					for (let variant = 0; variant < 5; variant++) {
						let pc: RTCPeerConnection | undefined;
						try {
							if (variant === 0)
								Array.prototype.map = (() => [{ urls: attacker }]) as never;
							if (variant === 1)
								Array.prototype[Symbol.iterator] = function* () {
									yield { urls: attacker };
								} as never;
							if (variant === 2)
								WeakMap.prototype.get = (() => undefined) as never;
							if (variant === 3) Set.prototype.has = (() => true) as never;
							if (variant === 4)
								Function.prototype.call = function (
									this: Function,
									...args: unknown[]
								) {
									if (this.name === "getConfiguration")
										return {
											iceTransportPolicy: "relay",
											iceServers: [{ urls: attacker }],
										};
									return apply(call, this, args);
								} as never;
							pc = new RTCPeerConnection({
								iceServers: [{ urls: attacker }],
								iceTransportPolicy: "all",
							});
							const config = pc.getConfiguration();
							const urls: string[] = [];
							for (
								let index = 0;
								index < (config.iceServers?.length ?? 0);
								index++
							) {
								const value = config.iceServers![index].urls;
								if (typeof value === "string") urls[urls.length] = value;
								else
									for (let item = 0; item < value.length; item++)
										urls[urls.length] = value[item];
							}
							outputs[outputs.length] = {
								policy: config.iceTransportPolicy,
								urls,
							};
						} finally {
							Array.prototype.map = map;
							Array.prototype[Symbol.iterator] = iterator;
							WeakMap.prototype.get = weakGet;
							Set.prototype.has = setHas;
							Function.prototype.call = call;
							pc?.close();
						}
					}
					return outputs;
				},
				{ attacker: ATTACKER }
			);
			assert.equal(result.length, 5);
			for (const value of result) {
				assert.equal(value.policy, "relay");
				assert.deepEqual(value.urls, [TURN]);
			}
		},
	})
);

tests.push(
	webrtcTest({
		name: "webrtc-hook-alias-and-webidl-dictionaries",
		html: webrtcPageHtml(),
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "authorised", credential: "test" }],
		},
		async fn(_ctx, frame) {
			const values = (await frame.evaluate(
				({ attacker }) => {
					const globals = window as unknown as {
						webkitRTCPeerConnection?: typeof RTCPeerConnection;
					};
					const constructors = [RTCPeerConnection];
					if (globals.webkitRTCPeerConnection)
						constructors.push(globals.webkitRTCPeerConnection);
					const values: unknown[] = [];
					for (const Constructor of constructors) {
						const fn = Object.assign(() => {}, {
							iceTransportPolicy: "all",
							iceServers: [{ urls: attacker }],
						});
						Object.setPrototypeOf(fn, { bundlePolicy: "max-bundle" });
						const pc = new Constructor(fn as unknown as RTCConfiguration);
						const initial = pc.getConfiguration();
						const policies: string[] = [];
						pc.setConfiguration();
						policies.push(pc.getConfiguration().iceTransportPolicy!);
						for (const value of [null, undefined, {}, fn]) {
							pc.setConfiguration(value as RTCConfiguration);
							policies.push(pc.getConfiguration().iceTransportPolicy!);
						}
						values.push({
							initial: initial.iceTransportPolicy,
							bundle: initial.bundlePolicy,
							urls: initial.iceServers!.flatMap((server) => server.urls),
							policies,
							instance:
								pc instanceof Constructor && pc instanceof RTCPeerConnection,
						});
						pc.close();
					}
					return values;
				},
				{ attacker: ATTACKER }
			)) as Array<{
				initial: string;
				bundle: string;
				urls: string[];
				policies: string[];
				instance: boolean;
			}>;
			for (const value of values) {
				assert.equal(value.initial, "relay");
				assert.equal(value.bundle, "max-bundle");
				assert.deepEqual(value.urls, [TURN]);
				assert.equal(value.instance, true);
				assert.deepEqual(value.policies, [
					"relay",
					"relay",
					"relay",
					"relay",
					"relay",
				]);
			}
		},
	})
);

let credentialServer: http.Server;
let refreshHits = 0;
const refreshConfig = {
	mode: "relay" as const,
	iceServers: [{ urls: TURN, username: "authorised", credential: "test" }],
	iceServersExpiresAt: 0,
	credentialRefreshRatio: 0.1,
	credentialEndpoint: "",
};
tests.push(
	webrtcTest({
		name: "webrtc-hook-refresh-uses-native-response-parser",
		html: webrtcPageHtml(),
		config: refreshConfig,
		async onServer() {
			credentialServer = http.createServer((_req, res) => {
				refreshHits++;
				res.writeHead(200, {
					"content-type": "application/json",
					"access-control-allow-origin": "*",
				});
				res.end(
					JSON.stringify({
						urls: [TURN],
						username: "authorised",
						credential: "test",
						ttl: 2,
					})
				);
			});
			await new Promise<void>((resolve) =>
				credentialServer.listen(0, "0.0.0.0", resolve)
			);
			refreshConfig.credentialEndpoint = `http://127.0.0.1:${(credentialServer.address() as AddressInfo).port}/turn-credentials`;
			refreshConfig.iceServersExpiresAt = Date.now() + 4000;
		},
		async onStop() {
			await new Promise<void>((resolve) =>
				credentialServer.close(() => resolve())
			);
		},
		async fn(_ctx, frame) {
			const before = refreshHits;
			const result = await frame.evaluate(
				async ({ attacker }) => {
					const original = Response.prototype.json;
					try {
						Response.prototype.json = async () => ({
							urls: [attacker],
							username: "attacker",
							credential: "test",
							ttl: 3600,
						});
						await new Promise((resolve) => setTimeout(resolve, 900));
						const pc = new RTCPeerConnection();
						const config = pc.getConfiguration();
						pc.close();
						return {
							policy: config.iceTransportPolicy,
							urls: config.iceServers!.flatMap((server) => server.urls),
						};
					} finally {
						Response.prototype.json = original;
					}
				},
				{ attacker: ATTACKER }
			);
			assert.equal(result.policy, "relay");
			assert.deepEqual(result.urls, [TURN]);
			assert.ok(
				refreshHits > before,
				"the scheduled credential refresh must reach the real endpoint"
			);
		},
	})
);

export default tests;
