import { ScramjetClient, type Proxy, type ProxyCtx } from "@client/index";
import {
	defaultWebrtcConfig,
	evaluateSelectedCandidatePair,
	hasNonRelayCandidates,
	normalizeWebrtcConfig,
	parseWebrtcCredentialPayload,
	sanitizeRtcConfiguration,
	type ScramjetWebrtcConfig,
	type WebrtcIceServer,
} from "@/shared/webrtc";
import { _URL } from "@/shared/snapshot";

type NativeRtcConstructor = typeof RTCPeerConnection;
type TimerHandle = ReturnType<typeof setTimeout>;

type NativeMethods = {
	setConfiguration: RTCPeerConnection["setConfiguration"];
	getConfiguration: RTCPeerConnection["getConfiguration"];
	getStats: RTCPeerConnection["getStats"];
	close: RTCPeerConnection["close"];
};

type CredentialState = {
	iceServers: WebrtcIceServer[];
	expiresAt: number | null;
	refreshTimer: TimerHandle | null;
	refreshInFlight: Promise<void> | null;
	retryMs: number;
};

type PcState = {
	closed: boolean;
	pairCheckToken: number;
	methods: NativeMethods;
};

const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const PAIR_CHECK_ATTEMPTS = 6;
const PAIR_CHECK_INTERVAL_MS = 500;

function captureMethods(ctor: NativeRtcConstructor): NativeMethods {
	return {
		setConfiguration: ctor.prototype.setConfiguration,
		getConfiguration: ctor.prototype.getConfiguration,
		getStats: ctor.prototype.getStats,
		close: ctor.prototype.close,
	};
}

export default function (client: ScramjetClient, self: GlobalThis) {
	let config: ScramjetWebrtcConfig;
	try {
		config = normalizeWebrtcConfig(client.context.config.webrtc);
	} catch (error) {
		// A mistyped trusted policy must fail closed, not silently disable WebRTC.
		dbg.error("invalid scramjet webrtc config", error);
		config = {
			...defaultWebrtcConfig,
			mode: "enforced",
			iceServers: [],
			failClosed: true,
			networkIsolationVerified: false,
		};
	}
	if (config.mode === "off") return;

	const globals = self as unknown as Record<string, unknown>;
	const rtcCandidate = globals.RTCPeerConnection;
	const webkitCandidate = globals.webkitRTCPeerConnection;
	const nativeRtc =
		typeof rtcCandidate === "function"
			? (rtcCandidate as NativeRtcConstructor)
			: undefined;
	const nativeWebkit =
		typeof webkitCandidate === "function"
			? (webkitCandidate as NativeRtcConstructor)
			: undefined;
	if (!nativeRtc && !nativeWebkit) {
		if (config.diagnostics) {
			dbg.log("[scramjet:webrtc] no native RTCPeerConnection in this realm");
		}
		return;
	}

	// Capture constructors before page scripts can replace them.
	const NativeWeakMap = self.WeakMap;
	const NativeWeakSet = self.WeakSet;
	const NativeSet = self.Set;
	const NativeDOMException = self.DOMException;
	const getPrototypeOf = Object.getPrototypeOf;
	const nativeSetTimeout = self.setTimeout.bind(self);
	const nativeClearTimeout = self.clearTimeout.bind(self);

	const methodsByPrototype = new NativeWeakMap<object, NativeMethods>();
	for (const ctor of [nativeRtc, nativeWebkit]) {
		if (ctor && !methodsByPrototype.has(ctor.prototype)) {
			methodsByPrototype.set(ctor.prototype, captureMethods(ctor));
		}
	}
	const fallbackMethods = methodsByPrototype.get(
		(nativeRtc ?? nativeWebkit)!.prototype
	)!;
	const states = new NativeWeakMap<RTCPeerConnection, PcState>();
	const active = new NativeSet<RTCPeerConnection>();
	const methodsFor = (pc: RTCPeerConnection): NativeMethods =>
		states.get(pc)?.methods ??
		methodsByPrototype.get(getPrototypeOf(pc)) ??
		fallbackMethods;

	const credential: CredentialState = {
		iceServers: config.iceServers,
		expiresAt: config.iceServersExpiresAt,
		refreshTimer: null,
		refreshInFlight: null,
		retryMs: RETRY_INITIAL_MS,
	};

	const log = (message: string, ...args: unknown[]) => {
		if (config.diagnostics) dbg.log(`[scramjet:webrtc] ${message}`, ...args);
	};

	const securityError = (message: string) =>
		typeof NativeDOMException === "function"
			? new NativeDOMException(`Scramjet WebRTC: ${message}`, "OperationError")
			: new Error(`Scramjet WebRTC: ${message}`);

	const configurationError = (message: string) =>
		typeof NativeDOMException === "function"
			? new NativeDOMException(
					`Scramjet WebRTC: ${message}`,
					"NotSupportedError"
				)
			: new Error(`Scramjet WebRTC: ${message}`);

	const credentialsUsable = () =>
		credential.iceServers.length > 0 &&
		(credential.expiresAt === null ||
			credential.expiresAt > Date.now() + 1_000);

	const iceServerUrls = (servers: readonly WebrtcIceServer[]) => {
		const urls = new NativeSet<string>();
		for (const server of servers) {
			for (const url of Array.isArray(server.urls)
				? server.urls
				: [server.urls]) {
				urls.add(url);
			}
		}
		return urls;
	};

	const assertNativeConfiguration = (pc: RTCPeerConnection) => {
		const actual = methodsFor(pc).getConfiguration.call(pc);
		if (actual.iceTransportPolicy !== "relay") {
			throw securityError(
				`browser ignored iceTransportPolicy=relay (got ${String(
					actual.iceTransportPolicy
				)})`
			);
		}
		const expected = iceServerUrls(credential.iceServers);
		const actualUrls = iceServerUrls(
			(actual.iceServers ?? []) as WebrtcIceServer[]
		);
		if (actualUrls.size === 0) {
			throw configurationError("no TURN servers are active");
		}
		for (const url of actualUrls) {
			if (!expected.has(url)) {
				throw securityError(`unauthorised ICE server survived: ${url}`);
			}
		}
	};

	const closeUnsafe = (pc: RTCPeerConnection, reason: string) => {
		const state = states.get(pc);
		if (state?.closed) return;
		if (state) state.closed = true;
		active.delete(pc);
		dbg.error(`[scramjet:webrtc] closing connection: ${reason}`);
		try {
			methodsFor(pc).close.call(pc);
		} catch {
			// The connection may already be closed by the page.
		}
	};

	const verifySelectedPair = (pc: RTCPeerConnection) => {
		const state = states.get(pc);
		if (!state || state.closed) return;
		const token = ++state.pairCheckToken;
		let attempts = 0;

		const check = async () => {
			if (state.closed || token !== state.pairCheckToken) return;
			let report: RTCStatsReport;
			try {
				report = await methodsFor(pc).getStats.call(pc);
			} catch (error) {
				log("getStats failed during pair verification", error);
				return;
			}
			if (state.closed || token !== state.pairCheckToken) return;
			const pair = evaluateSelectedCandidatePair(report);
			if (!pair) {
				if (++attempts < PAIR_CHECK_ATTEMPTS) {
					nativeSetTimeout(check, PAIR_CHECK_INTERVAL_MS);
				} else {
					dbg.warn(
						"[scramjet:webrtc] could not observe a selected candidate pair"
					);
				}
				return;
			}
			// TURN can surface the selected local candidate as prflx when the peer
			// discovers the relayed transport. `url`/`relayProtocol` prove the
			// candidate is backed by a TURN allocation; a direct prflx has no TURN
			// URL. Accept only relay candidates and TURN-backed prflx candidates.
			const turnBacked =
				pair.localType === "relay" ||
				(pair.localType === "prflx" &&
					typeof pair.localUrl === "string" &&
					/^turns?:/i.test(pair.localUrl) &&
					pair.localRelayProtocol !== null);
			if (!turnBacked) {
				log(`selected pair rejected ${JSON.stringify(pair)}`);
				closeUnsafe(
					pc,
					`selected local candidate is ${String(
						pair.localType
					)} via ${String(pair.localUrl)}, expected a TURN-backed candidate`
				);
				return;
			}
			log(`selected pair verified ${JSON.stringify(pair)}`);
		};

		void check();
	};

	const register = (pc: RTCPeerConnection, methods: NativeMethods) => {
		const state: PcState = {
			closed: false,
			pairCheckToken: 0,
			methods,
		};
		states.set(pc, state);
		active.add(pc);

		pc.addEventListener("icecandidate", (event) => {
			const line = event.candidate?.candidate;
			if (line && hasNonRelayCandidates(`a=${line}`)) {
				closeUnsafe(pc, "non-relay ICE candidate emitted");
			}
		});

		pc.addEventListener("iceconnectionstatechange", () => {
			if (
				pc.iceConnectionState === "connected" ||
				pc.iceConnectionState === "completed"
			) {
				verifySelectedPair(pc);
			} else if (
				pc.iceConnectionState === "failed" &&
				config.credentialEndpoint
			) {
				void refreshCredentials().catch((error) =>
					log("credential refresh after ICE failure failed", error)
				);
			}
		});

		pc.addEventListener("connectionstatechange", () => {
			if (pc.connectionState === "connected") {
				verifySelectedPair(pc);
			} else if (pc.connectionState === "closed") {
				state.closed = true;
				active.delete(pc);
			}
		});
	};

	function refreshCredentials(): Promise<void> {
		if (!config.credentialEndpoint) return Promise.resolve();
		if (credential.refreshInFlight) return credential.refreshInFlight;

		const url = new _URL(config.credentialEndpoint, client.context.prefix.href)
			.href;
		credential.refreshInFlight = (async () => {
			try {
				const response: Response = await client.natives.call(
					"fetch",
					self,
					url,
					{
						cache: "no-store",
						credentials: "omit",
						redirect: "error",
					}
				);
				if (!response.ok) {
					throw new Error(`credential endpoint returned ${response.status}`);
				}
				const parsed = parseWebrtcCredentialPayload(
					await response.json(),
					Date.now()
				);
				credential.iceServers = parsed.iceServers;
				credential.expiresAt = parsed.expiresAt;
				credential.retryMs = RETRY_INITIAL_MS;
				applyCredentialsToActiveConnections();
				config.iceServers = parsed.iceServers;
				config.iceServersExpiresAt = parsed.expiresAt;
				scheduleCredentialRefresh();
				log("credentials refreshed", {
					servers: parsed.iceServers.length,
					expiresAt: parsed.expiresAt,
				});
			} catch (error) {
				credential.retryMs = Math.min(RETRY_MAX_MS, credential.retryMs * 2);
				nativeClearTimeout(credential.refreshTimer);
				credential.refreshTimer = nativeSetTimeout(() => {
					void refreshCredentials().catch(() => {});
				}, credential.retryMs);
				throw error;
			} finally {
				credential.refreshInFlight = null;
			}
		})();

		return credential.refreshInFlight;
	}

	function scheduleCredentialRefresh() {
		nativeClearTimeout(credential.refreshTimer);
		credential.refreshTimer = null;
		if (!config.credentialEndpoint) return;
		const now = Date.now();
		const delay =
			credential.expiresAt === null
				? 0
				: Math.max(
						0,
						(credential.expiresAt - now) * config.credentialRefreshRatio
					);
		credential.refreshTimer = nativeSetTimeout(
			() => {
				void refreshCredentials().catch((error) =>
					log("scheduled credential refresh failed", error)
				);
			},
			Math.min(delay, 2_147_483_647)
		);
	}

	function applyCredentialsToActiveConnections() {
		for (const pc of active) {
			const state = states.get(pc);
			if (!state || state.closed) {
				active.delete(pc);
				continue;
			}
			try {
				const current = state.methods.getConfiguration.call(pc);
				state.methods.setConfiguration.call(
					pc,
					sanitizeRtcConfiguration(current, credential.iceServers)
				);
				assertNativeConfiguration(pc);
			} catch (error) {
				log(
					"could not apply refreshed credentials to a live connection",
					error
				);
			}
		}
	}

	function ensureConstructible() {
		if (config.mode === "enforced" && !config.networkIsolationVerified) {
			throw configurationError(
				"enforced mode requires networkIsolationVerified=true; refusing to create a PeerConnection without a verified network boundary"
			);
		}
		if (!credentialsUsable()) {
			if (config.credentialEndpoint) {
				void refreshCredentials().catch((error) =>
					log("credential refresh failed", error)
				);
			}
			if (config.failClosed) {
				throw configurationError(
					"no valid TURN credentials; refusing to create a PeerConnection that could bypass the relay"
				);
			}
		}
	}

	const constructorHandler: Proxy<
		"RTCPeerConnection" | "webkitRTCPeerConnection"
	> = {
		construct(
			ctx: ProxyCtx<
				"RTCPeerConnection" | "webkitRTCPeerConnection",
				"construct"
			>
		) {
			ensureConstructible();
			ctx.args[0] = sanitizeRtcConfiguration(
				ctx.args[0],
				credential.iceServers
			);
			const methods =
				methodsByPrototype.get((ctx.fn as NativeRtcConstructor).prototype) ??
				fallbackMethods;
			const pc = ctx.call() as RTCPeerConnection;
			register(pc, methods);
			log("PeerConnection created", {
				iceServers: credential.iceServers.length,
				failClosed: config.failClosed,
			});
			ctx.return(pc);
		},
	};

	const hookedPrototypes = new NativeWeakSet<object>();
	const hookPrototype = (
		name: string,
		ctor: NativeRtcConstructor | undefined
	) => {
		if (!ctor || hookedPrototypes.has(ctor.prototype)) return;
		hookedPrototypes.add(ctor.prototype);
		const prefix = `${name}.prototype`;

		client.Proxy(`${prefix}.setConfiguration`, {
			apply(ctx) {
				ensureConstructible();
				const pc = ctx.this as RTCPeerConnection;
				const input = ctx.args[0];
				if (input !== null && typeof input === "object") {
					const current = methodsFor(pc).getConfiguration.call(pc);
					ctx.args[0] = sanitizeRtcConfiguration(
						Object.assign({}, current, input),
						credential.iceServers
					);
				}
				ctx.call();
				try {
					assertNativeConfiguration(pc);
				} catch (error) {
					closeUnsafe(pc, "native configuration failed verification");
					throw error;
				}
			},
		});

		client.Proxy(`${prefix}.setLocalDescription`, {
			apply(ctx) {
				const pc = ctx.this as RTCPeerConnection;
				const result = ctx.call() as Promise<unknown> | undefined;
				if (!result || typeof result.then !== "function") return;
				ctx.return(
					result.then((value: unknown) => {
						const sdp = pc.localDescription?.sdp;
						if (sdp && hasNonRelayCandidates(sdp)) {
							closeUnsafe(pc, "local SDP contained a non-relay ICE candidate");
							throw securityError(
								"local description contains a non-relay ICE candidate"
							);
						}
						return value;
					})
				);
			},
		});

		client.Proxy(`${prefix}.restartIce`, {
			apply(ctx) {
				if (!credentialsUsable() && config.credentialEndpoint) {
					void refreshCredentials().catch((error) =>
						log("credential refresh before ICE restart failed", error)
					);
				}
				ctx.call();
			},
		});

		client.Proxy(`${prefix}.close`, {
			apply(ctx) {
				const pc = ctx.this as RTCPeerConnection;
				const state = states.get(pc);
				if (state) state.closed = true;
				active.delete(pc);
				ctx.call();
			},
		});
	};

	client.Proxy("RTCPeerConnection", constructorHandler);
	if (nativeWebkit && nativeWebkit !== nativeRtc) {
		client.Proxy("webkitRTCPeerConnection", constructorHandler);
	}
	hookPrototype("RTCPeerConnection", nativeRtc);
	hookPrototype("webkitRTCPeerConnection", nativeWebkit);

	if (config.credentialEndpoint && credential.iceServers.length === 0) {
		void refreshCredentials().catch((error) =>
			log("initial credential fetch failed", error)
		);
	} else {
		scheduleCredentialRefresh();
	}

	log("installed", {
		mode: config.mode,
		servers: credential.iceServers.length,
		failClosed: config.failClosed,
		networkIsolationVerified: config.networkIsolationVerified,
	});
}
