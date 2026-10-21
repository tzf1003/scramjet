// Capture the few runtime globals used below at module load. The client module is
// executed before page scripts, so this is the same tamper-resistance boundary
// as shared/snapshot.ts without adding a runtime import to the pure helper.
const Array_isArray = globalThis.Array.isArray;
const Number_isFinite = globalThis.Number.isFinite;
const Math_min = globalThis.Math.min;
const Math_max = globalThis.Math.max;
const Object_create = globalThis.Object.create;
const Object_defineProperty = globalThis.Object.defineProperty;
const Object_hasOwn = globalThis.Object.hasOwn;
const Object_keys = globalThis.Object.keys;
const Object_freeze = globalThis.Object.freeze;
const Reflect_apply = globalThis.Reflect.apply;
const String_trim = globalThis.String.prototype.trim;
const String_toLowerCase = globalThis.String.prototype.toLowerCase;
const RegExp_exec = globalThis.RegExp.prototype.exec;
const Symbol_iterator = globalThis.Symbol.iterator;
const policySnapshots = new globalThis.WeakSet<object>();
const WeakSet_has = globalThis.WeakSet.prototype.has;
const WeakSet_add = globalThis.WeakSet.prototype.add;

function append<T>(values: T[], value: T): void {
	Object_defineProperty(values, values.length, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

// Native WebIDL sequence conversion must consume the same private values that
// were validated, even when page code replaces Array's iterator or methods.
function sequence<T>(): T[] {
	const values: T[] = [];
	Object_defineProperty(values, Symbol_iterator, {
		value() {
			let index = 0;
			const iterator = Object_create(null);
			iterator.next = () => {
				const result = Object_create(null);
				result.done = index >= values.length;
				result.value = result.done ? undefined : values[index++];
				return result;
			};
			iterator[Symbol_iterator] = () => iterator;
			return iterator;
		},
	});
	return values;
}

function exec(pattern: RegExp, input: string): RegExpExecArray | null {
	return Reflect_apply(RegExp_exec, pattern, [input]);
}

function lower(input: string): string {
	return Reflect_apply(String_toLowerCase, input, []);
}
const String = globalThis.String;
const TypeError = globalThis.TypeError;

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

export const defaultWebrtcConfig: ScramjetWebrtcConfig = Object_freeze({
	mode: "off",
	iceServers: [],
	credentialEndpoint: null,
	iceServersExpiresAt: null,
	credentialRefreshRatio: 0.8,
	failClosed: true,
	diagnostics: false,
	networkIsolationVerified: false,
});

export function isTurnUrl(url: string): boolean {
	return exec(/^turns?:/i, Reflect_apply(String_trim, url, [])) !== null;
}

function cloneUrls(urls: string | string[]): string | string[] {
	if (!Array_isArray(urls)) return urls;
	const result = sequence<string>();
	for (let index = 0; index < urls.length; index++) append(result, urls[index]);
	return result;
}

export function cloneIceServers(
	servers: readonly WebrtcIceServer[]
): WebrtcIceServer[] {
	const result = sequence<WebrtcIceServer>();
	for (let index = 0; index < servers.length; index++) {
		const server = servers[index];
		const copy = Object_create(null) as WebrtcIceServer;
		copy.urls = cloneUrls(server.urls);
		// Own fields keep dictionary conversion independent of Object.prototype.
		copy.username = server.username;
		copy.credential = server.credential;
		append(result, copy);
	}
	return result;
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
			: Array_isArray(rawUrls)
				? rawUrls
				: null;
	let validUrls = urls !== null && urls.length > 0;
	if (urls) {
		for (let index = 0; index < urls.length; index++) {
			if (typeof urls[index] !== "string" || !isTurnUrl(urls[index]))
				validUrls = false;
		}
	}
	if (!validUrls) {
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
	const result = Object_create(null) as WebrtcIceServer;
	result.urls = cloneUrls(rawUrls as string | string[]);
	result.username =
		typeof value.username === "string" ? value.username : undefined;
	result.credential =
		typeof value.credential === "string" ? value.credential : undefined;
	return result;
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
	if (typeof input !== "object" || Array_isArray(input)) {
		throw new TypeError("webrtc must be an object");
	}

	const mode = input.mode ?? defaultWebrtcConfig.mode;
	if (mode !== "off" && mode !== "relay" && mode !== "enforced") {
		throw new TypeError(`unknown webrtc.mode: ${String(mode)}`);
	}
	if (mode === "off") {
		// Off mode must not validate or activate any policy fields.
		return { ...defaultWebrtcConfig, iceServers: [] };
	}

	const rawServers = input.iceServers ?? [];
	if (!Array_isArray(rawServers)) {
		throw new TypeError("webrtc.iceServers must be an array");
	}
	const iceServers = sequence<WebrtcIceServer>();
	for (let index = 0; index < rawServers.length; index++) {
		append(iceServers, validateIceServer(rawServers[index], index));
	}
	const booleanFields = [
		"failClosed",
		"diagnostics",
		"networkIsolationVerified",
	] as const;
	for (let index = 0; index < booleanFields.length; index++) {
		const field = booleanFields[index];
		if (input[field] !== undefined && typeof input[field] !== "boolean") {
			throw new TypeError(`webrtc.${field} must be a boolean`);
		}
	}

	const credentialEndpoint = input.credentialEndpoint ?? null;
	if (
		credentialEndpoint !== null &&
		(typeof credentialEndpoint !== "string" ||
			credentialEndpoint.length === 0 ||
			exec(/^(https?:\/\/|\/)/i, credentialEndpoint) === null)
	) {
		throw new TypeError(
			"webrtc.credentialEndpoint must be an /path or http(s) URL"
		);
	}

	const ratio = input.credentialRefreshRatio;
	const credentialRefreshRatio =
		typeof ratio === "number" && Number_isFinite(ratio)
			? Math_min(0.95, Math_max(0.1, ratio))
			: defaultWebrtcConfig.credentialRefreshRatio;

	const rawExpiresAt = input.iceServersExpiresAt ?? null;
	if (
		rawExpiresAt !== null &&
		(typeof rawExpiresAt !== "number" ||
			!Number_isFinite(rawExpiresAt) ||
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

/** Clone and freeze the policy inherited by later injected realms. */
export function snapshotWebrtcConfig(
	input: Partial<ScramjetWebrtcConfig> | null | undefined
): ScramjetWebrtcConfig {
	if (input && Reflect_apply(WeakSet_has, policySnapshots, [input]))
		return input as ScramjetWebrtcConfig;
	const config = normalizeWebrtcConfig(input);
	for (let index = 0; index < config.iceServers.length; index++) {
		const server = config.iceServers[index];
		if (Array_isArray(server.urls)) Object_freeze(server.urls);
		Object_freeze(server);
	}
	Object_freeze(config.iceServers);
	Reflect_apply(WeakSet_add, policySnapshots, [config]);
	return Object_freeze(config);
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
	servers: readonly WebrtcIceServer[],
	defaults?: RTCConfiguration
): RTCConfiguration {
	if (
		input != null &&
		typeof input !== "object" &&
		typeof input !== "function"
	) {
		// Preserve native TypeError behaviour for non-object arguments.
		return input as RTCConfiguration;
	}
	const source = (input ?? {}) as RtcConfigurationWithIdentity;
	const result = Object_create(null) as RtcConfigurationWithIdentity;
	result.iceTransportPolicy = "relay";
	result.iceServers = cloneIceServers(servers) as RTCIceServer[];
	const bundlePolicy =
		source.bundlePolicy === undefined
			? defaults?.bundlePolicy
			: source.bundlePolicy;
	const poolSize =
		source.iceCandidatePoolSize === undefined
			? defaults?.iceCandidatePoolSize
			: source.iceCandidatePoolSize;
	const muxPolicy =
		source.rtcpMuxPolicy === undefined
			? defaults?.rtcpMuxPolicy
			: source.rtcpMuxPolicy;
	const certificates =
		source.certificates === undefined
			? defaults?.certificates
			: source.certificates;
	if (bundlePolicy !== undefined) result.bundlePolicy = bundlePolicy;
	if (poolSize !== undefined) result.iceCandidatePoolSize = poolSize;
	if (muxPolicy !== undefined) result.rtcpMuxPolicy = muxPolicy;
	if (certificates !== undefined) result.certificates = certificates;
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
	while ((match = exec(SDP_CANDIDATE_RE, sdp)) !== null) {
		const type = lower(match[7]);
		append(types, type as CandidateType);
	}
	return types;
}

/** True when the SDP contains a candidate that did not come from TURN. */
export function hasNonRelayCandidates(sdp: string): boolean {
	const types = sdpCandidateTypes(sdp);
	for (let index = 0; index < types.length; index++) {
		if (types[index] !== "relay") return true;
	}
	return false;
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
	if (!payload || typeof payload !== "object" || Array_isArray(payload)) {
		throw new TypeError("WebRTC credential response must be an object");
	}
	const data = payload as WebRtcCredentialPayload;
	const ttl = data.ttl;
	if (typeof ttl !== "number" || !Number_isFinite(ttl) || ttl <= 0) {
		throw new TypeError("WebRTC credential response needs a positive ttl");
	}

	let iceServers: WebrtcIceServer[];
	if (Object_hasOwn(data, "iceServers") && data.iceServers !== undefined) {
		if (!Array_isArray(data.iceServers)) {
			throw new TypeError("WebRTC credential iceServers must be an array");
		}
		iceServers = sequence<WebrtcIceServer>();
		for (let index = 0; index < data.iceServers.length; index++) {
			append(iceServers, validateIceServer(data.iceServers[index], index));
		}
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
	if (!Number_isFinite(ttlMs) || !Number_isFinite(now + ttlMs)) {
		throw new TypeError(
			"WebRTC credential ttl exceeds the supported expiry range"
		);
	}
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

/** Return every selected transport; incomplete references remain observable. */
export function evaluateSelectedCandidatePairs(
	report: StatsLike
): SelectedCandidatePair[] {
	const stats = Object_create(null) as Record<string, Record<string, any>>;
	const ids = sequence<string>();
	Reflect_apply(report.forEach, report, [
		(stat: Record<string, any>, id: string) => {
			const copy = Object_create(null) as Record<string, any>;
			const keys = Object_keys(stat);
			for (let index = 0; index < keys.length; index++)
				copy[keys[index]] = stat[keys[index]];
			stats[id] = copy;
			append(ids, id);
		},
	]);
	const selected = sequence<Record<string, any>>();
	const unresolved = sequence<string>();
	const seen = Object_create(null) as Record<string, boolean>;
	let transportCount = 0;
	for (let index = 0; index < ids.length; index++) {
		const stat = stats[ids[index]];
		if (stat.type !== "transport") continue;
		transportCount++;
		if (typeof stat.selectedCandidatePairId === "string") {
			const id = stat.selectedCandidatePairId;
			seen[id] = true;
			const pair = stats[id];
			append(
				selected,
				pair?.type === "candidate-pair" &&
					(pair.transportId === undefined || pair.transportId === ids[index])
					? pair
					: Object_create(null)
			);
		} else if (stat.dtlsState === "connected") append(unresolved, ids[index]);
	}
	const fallbacks = sequence<Record<string, any>>();
	for (let index = 0; index < ids.length; index++) {
		const stat = stats[ids[index]];
		if (
			stat.type === "candidate-pair" &&
			!seen[ids[index]] &&
			(stat.selected === true ||
				(stat.state === "succeeded" && stat.nominated === true))
		) {
			append(fallbacks, stat);
		}
	}
	for (let index = 0; index < unresolved.length; index++) {
		let matched = 0;
		for (let item = 0; item < fallbacks.length; item++) {
			const pair = fallbacks[item];
			if (
				pair.transportId === unresolved[index] ||
				(transportCount === 1 &&
					fallbacks.length === 1 &&
					pair.transportId === undefined)
			) {
				append(selected, pair);
				matched++;
			}
		}
		if (matched === 0) append(selected, Object_create(null));
	}
	// Older browser reports omit transport records entirely. Every selected or
	// nominated succeeded pair remains subject to the same candidate validation.
	if (transportCount === 0) {
		for (let index = 0; index < fallbacks.length; index++)
			append(selected, fallbacks[index]);
	}

	const result = sequence<SelectedCandidatePair>();
	const asType = (value: unknown): CandidateType | null => {
		if (typeof value !== "string") return null;
		const type = lower(value);
		return type === "host" ||
			type === "srflx" ||
			type === "prflx" ||
			type === "relay"
			? type
			: "unknown";
	};
	const asString = (value: unknown): string | null =>
		typeof value === "string" ? value : null;
	const asNumber = (value: unknown): number | null =>
		typeof value === "number" && Number_isFinite(value) ? value : null;
	for (let index = 0; index < selected.length; index++) {
		const pair = selected[index];
		const local =
			typeof pair.localCandidateId === "string"
				? stats[pair.localCandidateId]
				: undefined;
		const remote =
			typeof pair.remoteCandidateId === "string"
				? stats[pair.remoteCandidateId]
				: undefined;
		append(result, {
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
		});
	}
	return result;
}

/** Compatibility helper for callers that inspect a single bundled transport. */
export function evaluateSelectedCandidatePair(
	report: StatsLike
): SelectedCandidatePair | null {
	return evaluateSelectedCandidatePairs(report)[0] ?? null;
}
