import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateSelectedCandidatePair,
	evaluateSelectedCandidatePairs,
	cloneIceServers,
	hasNonRelayCandidates,
	normalizeWebrtcConfig,
	parseWebrtcCredentialPayload,
	sanitizeRtcConfiguration,
	snapshotWebrtcConfig,
	sdpCandidateTypes,
} from "../../../packages/core/src/shared/webrtc.ts";

const TURN_A = "turn:relay.example:3478?transport=udp";
const TURN_B = "turns:relay.example:5349?transport=tcp";

test("snapshot: freezes a cloned policy and reuses its inherited identity", () => {
	const input = {
		mode: "relay" as const,
		iceServers: [{ urls: [TURN_A], username: "test", credential: "test" }],
	};
	const config = snapshotWebrtcConfig(input);
	input.iceServers[0].urls[0] = TURN_B;
	assert.equal(config.iceServers[0].urls[0], TURN_A);
	assert.equal(snapshotWebrtcConfig(config), config);
	assert.equal(Object.isFrozen(config), true);
	assert.equal(Object.isFrozen(config.iceServers), true);
	assert.equal(Object.isFrozen(config.iceServers[0]), true);
	assert.equal(Object.isFrozen(config.iceServers[0].urls), true);
	assert.throws(() => {
		config.mode = "off";
	}, TypeError);
});

test("normalize: defaults to off with no servers", () => {
	const config = normalizeWebrtcConfig(undefined);
	assert.equal(config.mode, "off");
	assert.deepEqual(config.iceServers, []);
	assert.equal(config.credentialEndpoint, null);
	assert.equal(config.failClosed, true);
	assert.equal(config.networkIsolationVerified, false);
});

test("normalize: off mode ignores malformed policy fields", () => {
	const config = normalizeWebrtcConfig({
		mode: "off",
		iceServers: [{ urls: "stun:stun.example" }],
		credentialEndpoint: "javascript:alert(1)",
	});
	assert.equal(config.mode, "off");
	assert.deepEqual(config.iceServers, []);
});

test("normalize: rejects unknown modes and non-TURN servers", () => {
	assert.throws(
		() => normalizeWebrtcConfig({ mode: "direct" as never }),
		/unknown webrtc\.mode/
	);
	assert.throws(
		() =>
			normalizeWebrtcConfig({
				mode: "relay",
				iceServers: [{ urls: "stun:stun.example:3478" }],
			}),
		/only turn:/
	);
	assert.throws(
		() =>
			normalizeWebrtcConfig({
				mode: "relay",
				iceServers: [{ urls: [TURN_A, "http://evil.example"] }],
			}),
		/only turn:/
	);
});

test("normalize: validates endpoint, expiry and clamps refresh ratio", () => {
	const config = normalizeWebrtcConfig({
		mode: "relay",
		iceServers: [{ urls: TURN_A, username: "u", credential: "c" }],
		credentialEndpoint: "/turn-credentials",
		iceServersExpiresAt: 1_700_000_000_000,
		credentialRefreshRatio: 0.999,
	});
	assert.equal(config.credentialEndpoint, "/turn-credentials");
	assert.equal(config.iceServersExpiresAt, 1_700_000_000_000);
	assert.equal(config.credentialRefreshRatio, 0.95);
	assert.throws(
		() =>
			normalizeWebrtcConfig({
				mode: "relay",
				credentialEndpoint: "javascript:alert(1)",
			}),
		/credentialEndpoint/
	);
	assert.throws(
		() => normalizeWebrtcConfig({ mode: "relay", iceServersExpiresAt: -1 }),
		/iceServersExpiresAt/
	);
});

test("sanitize: replaces page ICE config and preserves non-network fields", () => {
	const servers = [
		{ urls: [TURN_A, TURN_B], username: "user", credential: "secret" },
	];
	const input = {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "turn:attacker.example:3478" },
		],
		iceTransportPolicy: "all",
		bundlePolicy: "max-bundle",
		rtcpMuxPolicy: "require",
		iceCandidatePoolSize: 2,
	};
	const result = sanitizeRtcConfiguration(input, servers);

	assert.equal(result.iceTransportPolicy, "relay");
	assert.deepEqual(
		Array.from(result.iceServers!, (server) => ({ ...server })),
		servers
	);
	assert.equal(Object.getPrototypeOf(result), null);
	assert.equal(Object.getPrototypeOf(result.iceServers![0]), null);
	assert.equal(result.bundlePolicy, "max-bundle");
	assert.equal(result.rtcpMuxPolicy, "require");
	assert.equal(result.iceCandidatePoolSize, 2);
	assert.ok(!result.iceServers.some((s) => String(s.urls).includes("stun:")));
	assert.ok(
		!result.iceServers.some((s) => String(s.urls).includes("attacker"))
	);

	// The authorised server list is cloned, not shared with the page-facing object.
	result.iceServers![0].username = "mutated";
	assert.equal(servers[0].username, "user");
});

test("sanitize: non-object input is left for the native TypeError", () => {
	const value = "not-a-config";
	assert.equal(sanitizeRtcConfiguration(value, []), value);
});

test("sdp: parses candidate types without rewriting", () => {
	const sdp = [
		"v=0",
		"a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0",
		"a=candidate:2 1 udp 1686052607 203.0.113.9 50001 typ srflx raddr 192.168.1.5 rport 50000",
		"a=candidate:3 1 udp 41885439 198.51.100.7 50002 typ relay raddr 203.0.113.9 rport 50001",
		"a=candidate:4 1 tcp 1518280447 203.0.113.9 9 typ prflx",
		"a=end-of-candidates",
	].join("\r\n");
	assert.deepEqual(sdpCandidateTypes(sdp), ["host", "srflx", "relay", "prflx"]);
	assert.equal(hasNonRelayCandidates(sdp), true);
	assert.equal(
		hasNonRelayCandidates(
			"a=candidate:3 1 udp 41885439 198.51.100.7 50002 typ relay"
		),
		false
	);
	assert.equal(hasNonRelayCandidates(""), false);
});

test("credentials: parses coturn REST payload", () => {
	const now = 1_700_000_000_000;
	const parsed = parseWebrtcCredentialPayload(
		{
			urls: [TURN_A],
			username: "1700003600:test",
			credential: "abc",
			ttl: 3600,
		},
		now
	);
	assert.deepEqual(
		Array.from(parsed.iceServers, (server) => ({ ...server })),
		[{ urls: [TURN_A], username: "1700003600:test", credential: "abc" }]
	);
	assert.equal(parsed.ttlMs, 3_600_000);
	assert.equal(parsed.expiresAt, now + 3_600_000);

	const fromList = parseWebrtcCredentialPayload(
		{
			iceServers: [{ urls: TURN_B, username: "u", credential: "c" }],
			ttl: 60,
		},
		now
	);
	assert.equal(fromList.iceServers.length, 1);
	assert.equal(fromList.expiresAt, now + 60_000);
});

test("policy cloning is independent of page-owned array, string and regexp methods", () => {
	const servers = [{ urls: [TURN_A, TURN_B], username: "u", credential: "c" }];
	const originals = {
		map: Array.prototype.map,
		some: Array.prototype.some,
		slice: Array.prototype.slice,
		iterator: Array.prototype[Symbol.iterator],
		exec: RegExp.prototype.exec,
		trim: String.prototype.trim,
		lower: String.prototype.toLowerCase,
	};
	let cloned: ReturnType<typeof cloneIceServers>;
	let sanitized: RTCConfiguration;
	let nonRelay: boolean;
	try {
		Array.prototype.map = (() => [{ urls: "turn:attacker.invalid" }]) as never;
		Array.prototype.some = (() => false) as never;
		Array.prototype.slice = (() => []) as never;
		Array.prototype[Symbol.iterator] = function* () {
			yield { urls: "turn:attacker.invalid" };
		} as never;
		RegExp.prototype.exec = (() => null) as never;
		String.prototype.trim = (() => "turn:attacker.invalid") as never;
		String.prototype.toLowerCase = (() => "relay") as never;
		cloned = cloneIceServers(servers);
		sanitized = sanitizeRtcConfiguration({}, servers);
		nonRelay = hasNonRelayCandidates(
			"a=candidate:1 1 udp 1 192.0.2.1 1234 typ host"
		);
	} finally {
		Array.prototype.map = originals.map;
		Array.prototype.some = originals.some;
		Array.prototype.slice = originals.slice;
		Array.prototype[Symbol.iterator] = originals.iterator;
		RegExp.prototype.exec = originals.exec;
		String.prototype.trim = originals.trim;
		String.prototype.toLowerCase = originals.lower;
	}
	assert.equal(cloned![0].urls[0], TURN_A);
	assert.deepEqual(Array.from(sanitized!.iceServers![0].urls), [
		TURN_A,
		TURN_B,
	]);
	assert.equal(nonRelay!, true);
	assert.deepEqual(
		Array.from(cloned![Symbol.iterator]()).map((server) => server.username),
		["u"]
	);
});

test("dictionary sanitization accepts function objects, inherited fields and null defaults", () => {
	const fn = Object.assign(() => {}, {
		iceTransportPolicy: "all",
		iceServers: [{ urls: "turn:attacker.invalid" }],
	});
	Object.setPrototypeOf(fn, { bundlePolicy: "max-bundle" });
	const configured = sanitizeRtcConfiguration(fn, [{ urls: TURN_A }]);
	assert.equal(configured.iceTransportPolicy, "relay");
	assert.equal(configured.iceServers![0].urls, TURN_A);
	assert.equal(configured.bundlePolicy, "max-bundle");
	for (const input of [null, undefined]) {
		assert.equal(
			sanitizeRtcConfiguration(input, [{ urls: TURN_A }]).iceTransportPolicy,
			"relay"
		);
	}
	assert.throws(
		() =>
			normalizeWebrtcConfig({
				mode: "enforced",
				networkIsolationVerified: "true" as never,
			}),
		/must be a boolean/
	);
});

test("stats checks every transport and retains broken references", () => {
	const report = statsReport([
		{ id: "T1", type: "transport", selectedCandidatePairId: "P1" },
		{ id: "T2", type: "transport", selectedCandidatePairId: "P2" },
		{ id: "P1", type: "candidate-pair", localCandidateId: "L1" },
		{ id: "P2", type: "candidate-pair", localCandidateId: "L2" },
		{ id: "L1", type: "local-candidate", candidateType: "relay" },
		{ id: "L2", type: "local-candidate", candidateType: "host" },
	]);
	assert.deepEqual(
		evaluateSelectedCandidatePairs(report).map((pair) => pair.localType),
		["relay", "host"]
	);
	const missing = evaluateSelectedCandidatePairs(
		statsReport([
			{ id: "T", type: "transport", selectedCandidatePairId: "missing" },
		])
	);
	assert.equal(missing.length, 1);
	assert.equal(missing[0].localType, null);
	const unreported = evaluateSelectedCandidatePairs(
		statsReport([
			{
				id: "T1",
				type: "transport",
				dtlsState: "connected",
				selectedCandidatePairId: "P1",
			},
			{ id: "T2", type: "transport", dtlsState: "connected" },
			{
				id: "P1",
				type: "candidate-pair",
				transportId: "T1",
				localCandidateId: "L1",
			},
			{
				id: "stale",
				type: "candidate-pair",
				transportId: "T1",
				state: "succeeded",
				nominated: true,
				localCandidateId: "L1",
			},
			{ id: "L1", type: "local-candidate", candidateType: "relay" },
		])
	);
	assert.deepEqual(
		unreported.map((pair) => pair.localType),
		["relay", null]
	);
	const compatible = evaluateSelectedCandidatePairs(
		statsReport([
			{ id: "T1", type: "transport", dtlsState: "connected" },
			{
				id: "P1",
				type: "candidate-pair",
				transportId: "T1",
				state: "succeeded",
				nominated: true,
				localCandidateId: "L1",
			},
			{ id: "L1", type: "local-candidate", candidateType: "relay" },
		])
	);
	assert.equal(compatible[0].localType, "relay");
});

test("credentials: rejects missing ttl, missing auth and non-TURN URLs", () => {
	assert.throws(
		() =>
			parseWebrtcCredentialPayload(
				{ urls: TURN_A, username: "u", credential: "c" },
				0
			),
		/positive ttl/
	);
	assert.throws(
		() => parseWebrtcCredentialPayload({ urls: TURN_A, ttl: 60 }, 0),
		/username and credential/
	);
	assert.throws(
		() =>
			parseWebrtcCredentialPayload(
				{ urls: "stun:stun.example", username: "u", credential: "c", ttl: 60 },
				0
			),
		/only turn:/
	);
});

function statsReport(entries: Array<Record<string, unknown>>) {
	const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
	return {
		forEach(callback: (stat: Record<string, unknown>, id: string) => void) {
			for (const [id, stat] of byId) callback(stat, id);
		},
	};
}

test("stats: finds the transport-selected pair", () => {
	const report = statsReport([
		{
			id: "T1",
			type: "transport",
			selectedCandidatePairId: "P1",
		},
		{
			id: "P1",
			type: "candidate-pair",
			state: "succeeded",
			nominated: true,
			selected: true,
			localCandidateId: "L1",
			remoteCandidateId: "R1",
		},
		{
			id: "L1",
			type: "local-candidate",
			candidateType: "relay",
			address: "198.51.100.7",
			protocol: "udp",
		},
		{
			id: "R1",
			type: "remote-candidate",
			candidateType: "srflx",
			address: "203.0.113.9",
			protocol: "udp",
		},
	]);
	const pair = evaluateSelectedCandidatePair(report);
	assert.equal(pair?.localType, "relay");
	assert.equal(pair?.remoteType, "srflx");
	assert.equal(pair?.localAddress, "198.51.100.7");
	assert.equal(pair?.state, "succeeded");
});

test("stats: detects a host selected pair and handles no pair", () => {
	const report = statsReport([
		{
			id: "P1",
			type: "candidate-pair",
			state: "succeeded",
			nominated: true,
			selected: true,
			localCandidateId: "L1",
			remoteCandidateId: "R1",
		},
		{ id: "L1", type: "local-candidate", candidateType: "host" },
		{ id: "R1", type: "remote-candidate", candidateType: "host" },
	]);
	assert.equal(evaluateSelectedCandidatePair(report)?.localType, "host");
	assert.equal(
		evaluateSelectedCandidatePair(statsReport([{ id: "X", type: "codec" }])),
		null
	);
});
