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
	readDataPeer,
	closeDataPeers,
} from "./peers.ts";

const TURN = "turn:127.0.0.1:13478?transport=udp";
const requested: RTCConfiguration = {
	// Keep the off-mode control configuration valid in Firefox as well as
	// Chromium/WebKit. The relay policy supplies the dynamic TURN servers.
	iceServers: [],
	iceTransportPolicy: "all",
	bundlePolicy: "max-bundle",
};

// Passed to Playwright evaluate; keep browser code self-contained.
function probeConstructors(config: RTCConfiguration) {
	return ["RTCPeerConnection", "webkitRTCPeerConnection"].flatMap((name) => {
		const Ctor = (window as any)[name] as typeof RTCPeerConnection | undefined;
		if (!Ctor) return [];
		const descriptor = Object.getOwnPropertyDescriptor(
			Ctor.prototype,
			"constructor"
		)!;
		const PrototypeCtor = Ctor.prototype
			.constructor as typeof RTCPeerConnection;
		class Child extends PrototypeCtor {}
		const paths = [
			["global", () => new Ctor(config)],
			["prototype", () => new PrototypeCtor(config)],
			["descriptor", () => new descriptor.value(config)],
			["reflect", () => Reflect.construct(PrototypeCtor, [config])],
			["bound", () => new (PrototypeCtor.bind(null))(config)],
			["subclass", () => new Child(config)],
			[
				"reflect-subclass",
				() => Reflect.construct(PrototypeCtor, [config], Child),
			],
		] as const;
		const sources: Array<readonly [string, () => RTCPeerConnection]> = [
			...paths,
		];
		const client = (window as any)[Symbol.for("scramjet client global")];
		if (client) {
			sources.push([
				"native-store",
				() => new client.natives.store[name](config),
			]);
			sources.push([
				"native-construct",
				() => client.natives.construct(name, config),
			]);
			const unwrapped = client.box.unproxy.get(Ctor);
			if (unwrapped) sources.push(["unproxy", () => new unwrapped(config)]);
			for (const [index, cached] of (client.box.ctors[name] ?? []).entries()) {
				sources.push([`cached-${index}`, () => new cached(config)]);
			}
			sources.push([
				"native-set-configuration",
				() => {
					const pc = new Ctor(config);
					try {
						Reflect.apply(
							client.natives.store[`${name}.prototype.setConfiguration`],
							pc,
							[config]
						);
						return pc;
					} catch (error) {
						pc.close();
						throw error;
					}
				},
			]);
		}
		const results = sources.map(([path, create]) => {
			let pc: RTCPeerConnection | undefined;
			try {
				pc = create();
				const actual = pc.getConfiguration();
				return {
					path,
					created: true,
					policy: actual.iceTransportPolicy,
					urls: actual.iceServers?.flatMap((server) => server.urls),
					bundle: actual.bundlePolicy,
					instance: pc instanceof Ctor,
					prototype:
						Object.getPrototypeOf(pc) ===
						(path.includes("subclass") ? Child.prototype : Ctor.prototype),
					constructor: path.includes("subclass")
						? pc.constructor === Child
						: pc.constructor === Ctor,
				};
			} catch (error) {
				return { path, created: false, error: (error as Error).name };
			} finally {
				pc?.close();
			}
		});
		const errorName = (fn: () => unknown) => {
			try {
				fn();
				return "none";
			} catch (error) {
				return (error as Error).name;
			}
		};
		return [
			{
				name,
				sources: [
					Ctor,
					...[
						"setConfiguration",
						"setLocalDescription",
						"restartIce",
						"close",
					].map((method) => (Ctor.prototype as any)[method]),
				].map((fn) => Function.prototype.toString.call(fn)),
				identity: PrototypeCtor === Ctor && descriptor.value === Ctor,
				guardedMethods: client
					? [
							"setConfiguration",
							"setLocalDescription",
							"restartIce",
							"close",
						].every(
							(method) =>
								client.natives.store[`${name}.prototype.${method}`] ===
									(Ctor.prototype as any)[method] &&
								!client.box.unproxy.has((Ctor.prototype as any)[method])
						)
					: true,
				descriptor: [
					descriptor.writable,
					descriptor.enumerable,
					descriptor.configurable,
				],
				callError: errorName(() =>
					Reflect.apply(PrototypeCtor, null, [config])
				),
				invalidError: errorName(() => {
					const pc = new PrototypeCtor({
						...config,
						bundlePolicy: "invalid" as RTCBundlePolicy,
					});
					pc.close();
				}),
				results,
			},
		];
	});
}

const modes: Array<{
	name: string;
	config: WebrtcTestConfig;
	denied?: boolean;
}> = [
	{ name: "off", config: { mode: "off" } },
	{
		name: "relay",
		config: {
			mode: "relay",
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
		},
	},
	{
		name: "enforced",
		config: {
			mode: "enforced",
			networkIsolationVerified: true,
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
		},
	},
	{
		name: "missing-credentials",
		config: { mode: "relay", iceServers: [], failClosed: true },
		denied: true,
	},
	{
		name: "missing-isolation",
		config: {
			mode: "enforced",
			networkIsolationVerified: false,
			iceServers: [{ urls: TURN, username: "user", credential: "pass" }],
		},
		denied: true,
	},
];

const tests = modes.map(({ name, config, denied }) =>
	webrtcTest({
		name: `webrtc-hook-constructor-${name}`,
		html: webrtcPageHtml(),
		config,
		async fn(ctx, frame) {
			const native = await ctx.page.context().newPage();
			try {
				const baseline = await native.evaluate(probeConstructors, requested);
				const actual = await frame.evaluate(probeConstructors, requested);
				console.log("constructor boundary", JSON.stringify(actual));
				assert.ok(actual.length > 0);
				for (const entry of actual) {
					const control = baseline.find((value) => value.name === entry.name)!;
					assert.ok(control);
					assert.equal(
						entry.identity,
						true,
						`${entry.name} constructor identity`
					);
					assert.deepEqual(entry.descriptor, control.descriptor);
					assert.deepEqual(entry.sources, control.sources);
					if (name !== "off") assert.equal(entry.guardedMethods, true);
					assert.equal(entry.callError, control.callError);
					if (!denied) assert.equal(entry.invalidError, control.invalidError);
					for (const result of entry.results) {
						assert.equal(
							result.created,
							!denied,
							`${entry.name}.${result.path}`
						);
						if (denied) {
							assert.equal(result.error, "NotSupportedError");
							continue;
						}
						assert.equal(result.policy, name === "off" ? "all" : "relay");
						assert.deepEqual(
							result.urls,
							name === "off"
								? requested.iceServers!.flatMap((s) => s.urls)
								: [TURN]
						);
						assert.equal(result.bundle, "max-bundle");
						assert.equal(result.instance, true);
						assert.equal(result.prototype, true);
						assert.equal(result.constructor, true);
					}
				}
			} finally {
				await native.close();
			}
		},
	})
);

const policy: WebrtcTestConfig = {
	mode: process.env.WEBRTC_TEST_MODE === "enforced" ? "enforced" : "relay",
	networkIsolationVerified: process.env.WEBRTC_TEST_MODE === "enforced",
	iceServers: [],
};
const directHost = process.env.WEBRTC_DIRECT_HOST;
tests.push(
	webrtcTest({
		name: "webrtc-relay-constructor-datachannel-and-restart",
		html: webrtcPageHtml(),
		config: policy,
		async prepare() {
			const value = await fetchTurnCredentials();
			policy.iceServers = [
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
				await peer.goto(
					new URL(
						"/healthz",
						process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081"
					).href
				);
				await frame.evaluate(initializeDataPeer, {
					config: requested,
					sender: true,
					prototypeConstructor: true,
				});
				await peer.evaluate(initializeDataPeer, {
					config: {
						iceServers: policy.iceServers,
						iceTransportPolicy: "relay",
					},
					sender: false,
				});
				for (const restart of [false, true]) {
					await negotiateDataPeers(frame, peer, restart, directHost);
					await expectDataEcho(frame);
					const message = `constructor-echo-${restart}`;
					await frame.evaluate(
						(value) => window.__webrtcPeer.channel!.send(value),
						message
					);
					await expectDataEcho(frame, message);
					// Candidate entries can change between native stats snapshots
					// during ICE restart. Assert the sample that satisfied polling.
					const deadline = Date.now() + 5_000;
					let state = await frame.evaluate(readDataPeer);
					while (state.localTypes.length === 0 && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						state = await frame.evaluate(readDataPeer);
					}
					assert.ok(state.localTypes.length > 0);
					assert.ok(
						state.localTypes.every(
							(type) => type === "relay" || type === "prflx"
						)
					);
					assert.ok(
						state.candidates.every((line) => / typ relay(?: |$)/.test(line))
					);
				}
			} finally {
				await closeDataPeers(frame, peer);
				await peer.close();
			}
		},
	})
);

export default tests;
