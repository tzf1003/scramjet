/**
 * WebRTC policy helpers shared by the controller (credential prefetch) and the
 * client hook. This file must stay free of browser-only side effects so it can be
 * unit tested with Node's type stripping.
 */

export type WebrtcMode = "off" | "relay" | "enforced";

export type WebrtcIceServer = {
	urls: string | string[];
	username?: string;
	credential?: string;
};

export type ScramjetWebrtcConfig = {
	/** off: leave native WebRTC alone. relay/enforced: force TURN relay. */
	mode: WebrtcMode;
	/** Authorised TURN servers. Replaced/resolved by the trusted controller. */
	iceServers: WebrtcIceServer[];
	/** Same-origin endpoint that issues coturn REST credentials. */
	credentialEndpoint: string | null;
	/** Epoch ms when iceServers expire; null for static credentials. */
	iceServersExpiresAt: number | null;
	/** Refresh credentials at ttl * ratio (0.1..0.95). */
	credentialRefreshRatio: number;
	/** Throw on PeerConnection creation when no valid credentials exist. */
	failClosed: boolean;
	/** Log policy decisions (never credentials) for debugging. */
	diagnostics: boolean;
	/**
	 * Deployment attestation that the network layer blocks non-TURN egress.
	 * Required for enforced mode; the client cannot verify the kernel itself.
	 */
	networkIsolationVerified: boolean;
};

export const defaultWebrtcConfig: ScramjetWebrtcConfig = {
	mode: "off",
	iceServers: [],
	credentialEndpoint: null,
	iceServersExpiresAt: null,
	credentialRefreshRatio: 0.8,
	failClosed: true,
	diagnostics: false,
	networkIsolationVerified: false,
};

const WEBRTC_MODES: WebrtcMode[] = ["off", "relay", "enforced"];

export function isTurnUrl(url: string): boolean {
	return /^turns?:/i.test(url.trim());
}

export function cloneIceServers(
	servers: readonly WebrtcIceServer[]
): WebrtcIceServer[] {
	return servers.map((server) => ({
		urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
		...(server.username !== undefined ? { username: server.username } : {}),
		...(server.credential !== undefined
			? { credential: server.credential }
			: {}),
	}));
}

function validateIceServer(server: unknown, index: number): WebrtcIceServer {
	if (!server || typeof server !== "object") {
		throw new TypeError(`webrtc.iceServers[${index}] must be an object`);
	}
	const value = server as Record<string, unknown>;
	const rawUrls = value.urls;
	const urls =
		typeof rawUrls === "string"
			? [rawUrls]
			: Array.isArray(rawUrls)
				? rawUrls
				: null;
	if (
		!urls ||
		urls.length === 0 ||
		urls.some((url) => typeof url !== "string" || !isTurnUrl(url))
	) {
		throw new TypeError(
			`webrtc.iceServers[${index}].urls must contain only turn:/turns: URLs`
		);
	}
	if (value.username !== undefined && typeof value.username !== "string") {
		throw new TypeError(
			`webrtc.iceServers[${index}].username must be a string`
		);
	}
	if (value.credential !== undefined && typeof value.credential !== "string") {
		throw new TypeError(
			`webrtc.iceServers[${index}].credential must be a string`
		);
	}
	return {
		urls: typeof rawUrls === "string" ? rawUrls : (rawUrls as string[]).slice(),
		...(typeof value.username === "string" ? { username: value.username } : {}),
		...(typeof value.credential === "string"
			? { credential: value.credential }
			: {}),
	};
}

/**
 * Validate and clone a controller-provided WebRTC policy. Unknown/invalid values
 * throw: a mistyped policy must not silently degrade to direct ICE.
 */
export function normalizeWebrtcConfig(
	input: Partial<ScramjetWebrtcConfig> | null | undefined
): ScramjetWebrtcConfig {
	if (input == null) {
		return { ...defaultWebrtcConfig, iceServers: [] };
	}
	if (typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError("webrtc must be an object");
	}

	const mode = input.mode ?? defaultWebrtcConfig.mode;
	if (!WEBRTC_MODES.includes(mode)) {
		throw new TypeError(`unknown webrtc.mode: ${String(mode)}`);
	}
	if (mode === "off") {
		// Off mode must not validate or activate any policy fields.
		return { ...defaultWebrtcConfig, iceServers: [] };
	}

	const rawServers = input.iceServers ?? [];
	if (!Array.isArray(rawServers)) {
		throw new TypeError("webrtc.iceServers must be an array");
	}
	const iceServers = rawServers.map(validateIceServer);

	const credentialEndpoint = input.credentialEndpoint ?? null;
	if (
		credentialEndpoint !== null &&
		(typeof credentialEndpoint !== "string" ||
			credentialEndpoint.length === 0 ||
			!/^(https?:\/\/|\/)/i.test(credentialEndpoint))
	) {
		throw new TypeError(
			"webrtc.credentialEndpoint must be an /path or http(s) URL"
		);
	}

	const ratio = input.credentialRefreshRatio;
	const credentialRefreshRatio =
		typeof ratio === "number" && Number.isFinite(ratio)
			? Math.min(0.95, Math.max(0.1, ratio))
			: defaultWebrtcConfig.credentialRefreshRatio;

	const rawExpiresAt = input.iceServersExpiresAt ?? null;
	if (
		rawExpiresAt !== null &&
		(typeof rawExpiresAt !== "number" ||
			!Number.isFinite(rawExpiresAt) ||
			rawExpiresAt <= 0)
	) {
		throw new TypeError("webrtc.iceServersExpiresAt must be epoch ms or null");
	}

	return {
		mode,
		iceServers,
		credentialEndpoint,
		iceServersExpiresAt: rawExpiresAt,
		credentialRefreshRatio,
		failClosed: input.failClosed ?? defaultWebrtcConfig.failClosed,
		diagnostics: input.diagnostics ?? defaultWebrtcConfig.diagnostics,
		networkIsolationVerified:
			input.networkIsolationVerified ??
			defaultWebrtcConfig.networkIsolationVerified,
	};
}

/**
 * TS lib.dom omits `RTCConfiguration.peerIdentity` even though browsers accept
 * it. Keep the field so the native constructor sees the original identity.
 */
type RtcConfigurationWithIdentity = RTCConfiguration & {
	peerIdentity?: unknown;
};

/**
 * Build a native RTCConfiguration from a page-supplied config. Only non-network
 * fields survive; ICE servers and policy always come from the trusted policy.
 */
export function sanitizeRtcConfiguration(
	input: unknown,
	servers: readonly WebrtcIceServer[]
): RTCConfiguration {
	if (input != null && typeof input !== "object") {
		// Preserve native TypeError behaviour for non-object arguments.
		return input as RTCConfiguration;
	}
	const source = (input ?? {}) as RtcConfigurationWithIdentity;
	const result: RtcConfigurationWithIdentity = {
		iceTransportPolicy: "relay",
		iceServers: cloneIceServers(servers) as RTCIceServer[],
	};
	if (source.bundlePolicy !== undefined)
		result.bundlePolicy = source.bundlePolicy;
	if (source.iceCandidatePoolSize !== undefined)
		result.iceCandidatePoolSize = source.iceCandidatePoolSize;
	if (source.rtcpMuxPolicy !== undefined)
		result.rtcpMuxPolicy = source.rtcpMuxPolicy;
	if (source.certificates !== undefined)
		result.certificates = source.certificates;
	if (source.peerIdentity !== undefined)
		result.peerIdentity = source.peerIdentity;
	return result;
}

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

const SDP_CANDIDATE_RE =
	/(?:^|\n)(?:a=)?candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/g;

/** Extract every ICE candidate type from an SDP body. */
export function sdpCandidateTypes(sdp: string): CandidateType[] {
	if (typeof sdp !== "string" || sdp.length === 0) return [];
	const types: CandidateType[] = [];
	SDP_CANDIDATE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SDP_CANDIDATE_RE.exec(sdp)) !== null) {
		const type = match[7].toLowerCase();
		types.push(type as CandidateType);
	}
	return types;
}

/** True when the SDP contains a candidate that did not come from TURN. */
export function hasNonRelayCandidates(sdp: string): boolean {
	return sdpCandidateTypes(sdp).some((type) => type !== "relay");
}

export type WebRtcCredentialPayload = {
	urls?: string | string[];
	username?: string;
	credential?: string;
	ttl?: number;
	iceServers?: unknown;
};

export type ParsedWebrtcCredentials = {
	iceServers: WebrtcIceServer[];
	ttlMs: number;
	expiresAt: number;
};

/**
 * Parse a credential endpoint response. Accepts either
 * `{urls, username, credential, ttl}` or `{iceServers: [...], ttl}`.
 * `ttl` is seconds and must be positive.
 */
export function parseWebrtcCredentialPayload(
	payload: unknown,
	now: number
): ParsedWebrtcCredentials {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new TypeError("WebRTC credential response must be an object");
	}
	const data = payload as WebRtcCredentialPayload;
	const ttl = data.ttl;
	if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
		throw new TypeError("WebRTC credential response needs a positive ttl");
	}

	let iceServers: WebrtcIceServer[];
	if (data.iceServers !== undefined) {
		if (!Array.isArray(data.iceServers)) {
			throw new TypeError("WebRTC credential iceServers must be an array");
		}
		iceServers = data.iceServers.map((server, index) =>
			validateIceServer(server, index)
		);
	} else {
		if (
			typeof data.username !== "string" ||
			typeof data.credential !== "string" ||
			data.username.length === 0 ||
			data.credential.length === 0
		) {
			throw new TypeError(
				"WebRTC credential response needs username and credential"
			);
		}
		iceServers = [
			validateIceServer(
				{
					urls: data.urls,
					username: data.username,
					credential: data.credential,
				},
				0
			),
		];
	}
	if (iceServers.length === 0) {
		throw new TypeError("WebRTC credential response has no TURN servers");
	}

	const ttlMs = ttl * 1000;
	return {
		iceServers,
		ttlMs,
		expiresAt: now + ttlMs,
	};
}

export type SelectedCandidatePair = {
	localType: CandidateType | null;
	remoteType: CandidateType | null;
	localAddress: string | null;
	remoteAddress: string | null;
	localPort: number | null;
	remotePort: number | null;
	localProtocol: string | null;
	localRelatedAddress: string | null;
	localRelatedPort: number | null;
	localUrl: string | null;
	localRelayProtocol: string | null;
	state: string | null;
	nominated: boolean | null;
	selected: boolean | null;
};

type StatsLike = {
	forEach(callback: (stat: Record<string, any>, id: string) => void): void;
};

/**
 * Find the selected candidate pair in a native RTCStatsReport and return the
 * candidate types/addresses. This never mutates the report.
 */
export function evaluateSelectedCandidatePair(
	report: StatsLike
): SelectedCandidatePair | null {
	const stats: Record<string, Record<string, any>> = {};
	report.forEach((stat, id) => {
		stats[id] = stat;
	});

	let selectedPairId: string | null = null;
	for (const stat of Object.values(stats)) {
		if (
			stat.type === "transport" &&
			typeof stat.selectedCandidatePairId === "string"
		) {
			selectedPairId = stat.selectedCandidatePairId;
			break;
		}
	}

	let pair: Record<string, any> | null = null;
	if (selectedPairId && stats[selectedPairId]?.type === "candidate-pair") {
		pair = stats[selectedPairId];
	} else {
		for (const stat of Object.values(stats)) {
			if (stat.type !== "candidate-pair") continue;
			if (stat.selected === true) {
				pair = stat;
				break;
			}
			if (
				!pair &&
				stat.state === "succeeded" &&
				(stat.nominated === true || stat.nominated === undefined)
			) {
				pair = stat;
			}
		}
	}
	if (!pair) return null;

	const local = pair.localCandidateId
		? stats[pair.localCandidateId]
		: undefined;
	const remote = pair.remoteCandidateId
		? stats[pair.remoteCandidateId]
		: undefined;
	const asType = (value: unknown): CandidateType | null => {
		if (typeof value !== "string") return null;
		const lowered = value.toLowerCase();
		if (
			lowered === "host" ||
			lowered === "srflx" ||
			lowered === "prflx" ||
			lowered === "relay"
		) {
			return lowered;
		}
		return "unknown";
	};
	const asString = (value: unknown): string | null =>
		typeof value === "string" ? value : null;
	const asNumber = (value: unknown): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;

	return {
		localType: asType(local?.candidateType),
		remoteType: asType(remote?.candidateType),
		localAddress: asString(local?.address ?? local?.ip),
		remoteAddress: asString(remote?.address ?? remote?.ip),
		localPort: asNumber(local?.port),
		remotePort: asNumber(remote?.port),
		localProtocol: asString(local?.protocol),
		localRelatedAddress: asString(local?.relatedAddress),
		localRelatedPort: asNumber(local?.relatedPort),
		localUrl: asString(local?.url),
		localRelayProtocol: asString(local?.relayProtocol),
		state: asString(pair.state),
		nominated: typeof pair.nominated === "boolean" ? pair.nominated : null,
		selected: typeof pair.selected === "boolean" ? pair.selected : null,
	};
}
