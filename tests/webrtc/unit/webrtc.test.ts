import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateSelectedCandidatePair,
	hasNonRelayCandidates,
	normalizeWebrtcConfig,
	parseWebrtcCredentialPayload,
	sanitizeRtcConfiguration,
	sdpCandidateTypes,
} from "../../../packages/core/src/shared/webrtc.ts";

const TURN_A = "turn:relay.example:3478?transport=udp";
const TURN_B = "turns:relay.example:5349?transport=tcp";

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
	assert.deepEqual(result.iceServers, servers);
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
	assert.deepEqual(parsed.iceServers, [
		{ urls: [TURN_A], username: "1700003600:test", credential: "abc" },
	]);
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
