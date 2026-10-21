import { ScramjetClient, type Proxy, type ProxyCtx } from "@client/index";
import {
	defaultWebrtcConfig,
	evaluateSelectedCandidatePairs,
	isTurnUrl,
	hasNonRelayCandidates,
	normalizeWebrtcConfig,
	parseWebrtcCredentialPayload,
	sanitizeRtcConfiguration,
	type ScramjetWebrtcConfig,
	type WebrtcIceServer,
} from "@/shared/webrtc";
import {
	_URL,
	Date_now,
	Error,
	JSON_stringify,
	Math_max,
	Math_min,
	Object_getOwnPropertyDescriptor,
	Object_defineProperty,
	Function_prototype_toString,
	Reflect_apply,
	Promise_race,
	Reflect_set,
	Object_getPrototypeOf,
	Promise_resolve,
} from "@/shared/snapshot";

// eslint-disable-next-line scramjet-core/no-globals -- type-only reference
type NativeRtcConstructor = typeof RTCPeerConnection;
type TimerHandle = ReturnType<typeof setTimeout>;

type NativeMethods = {
	setConfiguration: RTCPeerConnection["setConfiguration"];
	getConfiguration: RTCPeerConnection["getConfiguration"];
	getStats: RTCPeerConnection["getStats"];
	close: RTCPeerConnection["close"];
	restartIce: RTCPeerConnection["restartIce"];
	connectionState: (this: RTCPeerConnection) => RTCPeerConnectionState;
	iceConnectionState: (this: RTCPeerConnection) => RTCIceConnectionState;
	localDescription: (this: RTCPeerConnection) => RTCSessionDescription | null;
};

type CredentialState = {
	iceServers: WebrtcIceServer[];
	expiresAt: number | null;
	refreshTimer: TimerHandle | null;
	expiryTimer: TimerHandle | null;
	refreshInFlight: Promise<void> | null;
	retryMs: number;
};

type PcState = {
	closed: boolean;
	pairCheckToken: number;
	pairTimer: TimerHandle | null;
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
		restartIce: ctor.prototype.restartIce,
		connectionState: Object_getOwnPropertyDescriptor(
			ctor.prototype,
			"connectionState"
		)!.get as NativeMethods["connectionState"],
		iceConnectionState: Object_getOwnPropertyDescriptor(
			ctor.prototype,
			"iceConnectionState"
		)!.get as NativeMethods["iceConnectionState"],
		localDescription: Object_getOwnPropertyDescriptor(
			ctor.prototype,
			"localDescription"
		)!.get as NativeMethods["localDescription"],
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
	const nativeSetTimeout = self.setTimeout.bind(self);
	const nativeClearTimeout = self.clearTimeout.bind(self);

	const weakMapGet = NativeWeakMap.prototype.get;
	const weakMapSet = NativeWeakMap.prototype.set;
	const weakMapHas = NativeWeakMap.prototype.has;
	const weakSetHas = NativeWeakSet.prototype.has;
	const weakSetAdd = NativeWeakSet.prototype.add;
	const setAdd = NativeSet.prototype.add;
	const setDelete = NativeSet.prototype.delete;
	const setForEach = NativeSet.prototype.forEach;
	const promiseThen = self.Promise.prototype.then;
	const NativePromise = self.Promise;
	const eventAdd = self.EventTarget.prototype.addEventListener;
	const responseJson = self.Response.prototype.json;
	const responseOk = Object_getOwnPropertyDescriptor(
		self.Response.prototype,
		"ok"
	)!.get!;
	const responseStatus = Object_getOwnPropertyDescriptor(
		self.Response.prototype,
		"status"
	)!.get!;
	const nativeFetch = client.natives.store.fetch as typeof self.fetch;
	const reportForEach = self.RTCStatsReport?.prototype.forEach;
	const methodsByPrototype = new NativeWeakMap<object, NativeMethods>();
	const constructors = [nativeRtc, nativeWebkit];
	for (let index = 0; index < constructors.length; index++) {
		const ctor = constructors[index];
		if (
			ctor &&
			!Reflect_apply(weakMapHas, methodsByPrototype, [ctor.prototype])
		) {
			Reflect_apply(weakMapSet, methodsByPrototype, [
				ctor.prototype,
				captureMethods(ctor),
			]);
		}
	}
	const fallbackMethods = Reflect_apply(weakMapGet, methodsByPrototype, [
		(nativeRtc ?? nativeWebkit)!.prototype,
	]) as NativeMethods;
	const states = new NativeWeakMap<RTCPeerConnection, PcState>();
	const active = new NativeSet<RTCPeerConnection>();
	const stateFor = (pc: RTCPeerConnection): PcState | undefined =>
		Reflect_apply(weakMapGet, states, [pc]);
	const methodsFor = (pc: RTCPeerConnection): NativeMethods =>
		stateFor(pc)?.methods ??
		Reflect_apply(weakMapGet, methodsByPrototype, [
			Object_getPrototypeOf(pc),
		]) ??
		fallbackMethods;
	const removeActive = (pc: RTCPeerConnection) =>
		Reflect_apply(setDelete, active, [pc]);
	const forEachActive = (callback: (pc: RTCPeerConnection) => void) =>
		Reflect_apply(setForEach, active, [callback]);

	const credential: CredentialState = {
		iceServers: config.iceServers,
		expiresAt: config.iceServersExpiresAt,
		refreshTimer: null,
		expiryTimer: null,
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
			credential.expiresAt > Date_now() + 1_000);

	const urlAuthorized = (url: string) => {
		for (let index = 0; index < credential.iceServers.length; index++) {
			const configured = credential.iceServers[index].urls;
			if (typeof configured === "string") {
				if (url === configured) return true;
			} else {
				for (let item = 0; item < configured.length; item++)
					if (url === configured[item]) return true;
			}
		}
		return false;
	};

	const assertNativeConfiguration = (pc: RTCPeerConnection) => {
		const actual = Reflect_apply(
			methodsFor(pc).getConfiguration,
			pc,
			[]
		) as RTCConfiguration;
		if (actual.iceTransportPolicy !== "relay")
			throw securityError("browser ignored iceTransportPolicy=relay");
		const servers = actual.iceServers ?? [];
		if (servers.length === 0)
			throw configurationError("no TURN servers are active");
		for (let index = 0; index < servers.length; index++) {
			const urls = servers[index].urls;
			if (typeof urls === "string") {
				if (!urlAuthorized(urls))
					throw securityError("unauthorised ICE server survived");
			} else {
				if (!urls || urls.length === 0)
					throw securityError("empty ICE server URL list");
				for (let item = 0; item < urls.length; item++) {
					if (!urlAuthorized(urls[item]))
						throw securityError("unauthorised ICE server survived");
				}
			}
		}
	};

	const closeUnsafe = (pc: RTCPeerConnection, reason: string) => {
		const state = stateFor(pc);
		if (state?.closed) return;
		if (state) {
			state.closed = true;
			nativeClearTimeout(state.pairTimer);
		}
		removeActive(pc);
		dbg.error(`[scramjet:webrtc] closing connection: ${reason}`);
		try {
			Reflect_apply(methodsFor(pc).close, pc, []);
		} catch {
			// The connection may already be closed by the page.
		}
	};

	const verifySelectedPair = (pc: RTCPeerConnection) => {
		const state = stateFor(pc);
		if (!state || state.closed) return;
		nativeClearTimeout(state.pairTimer);
		const token = ++state.pairCheckToken;
		let attempts = 0;
		const check = async () => {
			if (state.closed || token !== state.pairCheckToken) return;
			if (
				!credentialsUsable() &&
				(config.failClosed || config.mode === "enforced")
			) {
				closeUnsafe(pc, "TURN credentials expired");
				return;
			}
			let timeout: TimerHandle | null = null;
			try {
				if (!reportForEach)
					throw configurationError(
						"browser does not expose verifiable WebRTC statistics"
					);
				const report = (await Promise_race([
					Reflect_apply(methodsFor(pc).getStats, pc, []),
					new NativePromise<never>((_resolve, reject) => {
						timeout = nativeSetTimeout(
							() => reject(securityError("WebRTC statistics timed out")),
							1500
						);
					}),
				])) as RTCStatsReport;
				if (state.closed || token !== state.pairCheckToken) return;
				const pairs = evaluateSelectedCandidatePairs({
					forEach(callback) {
						Reflect_apply(reportForEach, report, [callback]);
					},
				});
				if (pairs.length === 0)
					throw securityError("could not observe a selected candidate pair");
				let incomplete = false;
				for (let index = 0; index < pairs.length; index++) {
					const pair = pairs[index];
					if (pair.localType === null) {
						incomplete = true;
						if (pair.localUrl === null || urlAuthorized(pair.localUrl))
							continue;
					}
					const turnBacked =
						pair.localType === "relay" ||
						(pair.localType === "prflx" &&
							typeof pair.localUrl === "string" &&
							isTurnUrl(pair.localUrl) &&
							urlAuthorized(pair.localUrl) &&
							pair.localRelayProtocol !== null);
					if (
						!turnBacked ||
						(pair.localUrl !== null && !urlAuthorized(pair.localUrl))
					) {
						closeUnsafe(
							pc,
							"selected candidate pair is not backed by an authorised TURN server"
						);
						return;
					}
				}
				if (incomplete)
					throw securityError(
						"selected candidate pair statistics are incomplete"
					);
				attempts = 0;
				log(`selected pairs verified ${JSON_stringify(pairs)}`);
			} catch (error) {
				log("selected pair verification pending", error);
				if (
					++attempts >= PAIR_CHECK_ATTEMPTS &&
					(config.failClosed || config.mode === "enforced")
				) {
					closeUnsafe(pc, "selected candidate pairs could not be verified");
					return;
				}
			} finally {
				nativeClearTimeout(timeout);
			}
			if (!state.closed && token === state.pairCheckToken) {
				state.pairTimer = nativeSetTimeout(
					check,
					attempts ? PAIR_CHECK_INTERVAL_MS : 1000
				);
			}
		};
		void check();
	};

	const register = (pc: RTCPeerConnection, methods: NativeMethods) => {
		const state: PcState = {
			closed: false,
			pairCheckToken: 0,
			pairTimer: null,
			methods,
		};
		Reflect_apply(weakMapSet, states, [pc, state]);
		Reflect_apply(setAdd, active, [pc]);

		Reflect_apply(eventAdd, pc, [
			"icecandidate",
			(event: RTCPeerConnectionIceEvent) => {
				const line = event.candidate?.candidate;
				if (line && hasNonRelayCandidates(`a=${line}`)) {
					closeUnsafe(pc, "non-relay ICE candidate emitted");
				}
			},
		]);

		Reflect_apply(eventAdd, pc, [
			"iceconnectionstatechange",
			() => {
				if (
					Reflect_apply(methods.iceConnectionState, pc, []) === "connected" ||
					Reflect_apply(methods.iceConnectionState, pc, []) === "completed"
				) {
					verifySelectedPair(pc);
				} else if (
					Reflect_apply(methods.iceConnectionState, pc, []) === "failed" &&
					config.credentialEndpoint
				) {
					void refreshCredentials().catch((error) =>
						log("credential refresh after ICE failure failed", error)
					);
				}
			},
		]);

		Reflect_apply(eventAdd, pc, [
			"connectionstatechange",
			() => {
				if (Reflect_apply(methods.connectionState, pc, []) === "connected") {
					verifySelectedPair(pc);
				} else if (
					Reflect_apply(methods.connectionState, pc, []) === "closed"
				) {
					state.closed = true;
					removeActive(pc);
					nativeClearTimeout(state.pairTimer);
				}
			},
		]);
	};

	function refreshCredentials(): Promise<void> {
		if (!config.credentialEndpoint) return Promise_resolve();
		if (credential.refreshInFlight) return credential.refreshInFlight;

		const url = new _URL(config.credentialEndpoint, client.context.prefix.href)
			.href;
		credential.refreshInFlight = (async () => {
			try {
				const response = (await Reflect_apply(nativeFetch, self, [
					url,
					{
						cache: "no-store",
						credentials: "same-origin",
						redirect: "error",
					},
				])) as Response;
				if (!Reflect_apply(responseOk, response, [])) {
					throw new Error(
						`credential endpoint returned ${Reflect_apply(responseStatus, response, [])}`
					);
				}
				const parsed = parseWebrtcCredentialPayload(
					await Reflect_apply(responseJson, response, []),
					Date_now()
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
				credential.retryMs = Math_min(RETRY_MAX_MS, credential.retryMs * 2);
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
		nativeClearTimeout(credential.expiryTimer);
		if (credential.expiresAt !== null) {
			credential.expiryTimer = nativeSetTimeout(
				() => {
					if (
						!credentialsUsable() &&
						(config.failClosed || config.mode === "enforced")
					) {
						forEachActive((pc) =>
							closeUnsafe(pc, "TURN credentials expired before refresh")
						);
					}
				},
				Math_min(Math_max(0, credential.expiresAt - Date_now()), 2_147_483_647)
			);
		}
		if (!config.credentialEndpoint) return;
		const now = Date_now();
		const delay =
			credential.expiresAt === null
				? 0
				: Math_max(
						0,
						(credential.expiresAt - now) * config.credentialRefreshRatio
					);
		credential.refreshTimer = nativeSetTimeout(
			() => {
				void refreshCredentials().catch((error) =>
					log("scheduled credential refresh failed", error)
				);
			},
			Math_min(delay, 2_147_483_647)
		);
	}

	function applyCredentialsToActiveConnections() {
		forEachActive((pc) => {
			const state = stateFor(pc);
			if (!state || state.closed) {
				removeActive(pc);
				return;
			}
			try {
				const current = Reflect_apply(state.methods.getConfiguration, pc, []);
				const previous = current.iceServers ?? [];
				let changed = previous.length !== credential.iceServers.length;
				for (let index = 0; index < previous.length && !changed; index++) {
					const next = credential.iceServers[index];
					changed =
						previous[index].username !== next.username ||
						previous[index].credential !== next.credential;
					const oldUrls =
						typeof previous[index].urls === "string"
							? [previous[index].urls]
							: previous[index].urls;
					const newUrls =
						typeof next.urls === "string" ? [next.urls] : next.urls;
					if (oldUrls.length !== newUrls.length) changed = true;
					for (let item = 0; item < oldUrls.length && !changed; item++)
						changed = oldUrls[item] !== newUrls[item];
				}
				Reflect_apply(state.methods.setConfiguration, pc, [
					sanitizeRtcConfiguration(current, credential.iceServers),
				]);
				assertNativeConfiguration(pc);
				// New TURN credentials take effect in the next ICE generation. Let
				// the native negotiationneeded event ask the application to signal it.
				const ice = Reflect_apply(state.methods.iceConnectionState, pc, []);
				if (changed && (ice === "connected" || ice === "completed")) {
					if (typeof state.methods.restartIce !== "function")
						throw configurationError(
							"credential rotation requires ICE restart support"
						);
					Reflect_apply(state.methods.restartIce, pc, []);
				}
			} catch (error) {
				log(
					"could not apply refreshed credentials to a live connection",
					error
				);
				if (config.failClosed || config.mode === "enforced")
					closeUnsafe(pc, "refreshed TURN configuration could not be applied");
			}
		});
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
				Reflect_apply(weakMapGet, methodsByPrototype, [
					(ctx.fn as NativeRtcConstructor).prototype,
				]) ?? fallbackMethods;
			const pc = ctx.call() as RTCPeerConnection;
			register(pc, methods);
			try {
				assertNativeConfiguration(pc);
			} catch (error) {
				closeUnsafe(pc, "initial TURN configuration failed verification");
				throw error;
			}
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
		if (!ctor || Reflect_apply(weakSetHas, hookedPrototypes, [ctor.prototype]))
			return;
		Reflect_apply(weakSetAdd, hookedPrototypes, [ctor.prototype]);
		const prefix = `${name}.prototype`;

		client.Proxy(`${prefix}.setConfiguration`, {
			apply(ctx) {
				ensureConstructible();
				const pc = ctx.this as RTCPeerConnection;
				ctx.args[0] = sanitizeRtcConfiguration(
					ctx.args[0],
					credential.iceServers,
					Reflect_apply(methodsFor(pc).getConfiguration, pc, [])
				);
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
				if (!result) return;
				ctx.return(
					Reflect_apply(promiseThen, result, [
						(value: unknown) => {
							const sdp = (
								Reflect_apply(
									methodsFor(pc).localDescription,
									pc,
									[]
								) as RTCSessionDescription | null
							)?.sdp;
							if (sdp && hasNonRelayCandidates(sdp)) {
								closeUnsafe(
									pc,
									"local SDP contained a non-relay ICE candidate"
								);
								throw securityError(
									"local description contains a non-relay ICE candidate"
								);
							}
							return value;
						},
					])
				);
			},
		});

		client.Proxy(`${prefix}.restartIce`, {
			apply(ctx) {
				ensureConstructible();
				ctx.call();
			},
		});

		client.Proxy(`${prefix}.close`, {
			apply(ctx) {
				const pc = ctx.this as RTCPeerConnection;
				const state = stateFor(pc);
				if (state) {
					state.closed = true;
					nativeClearTimeout(state.pairTimer);
				}
				removeActive(pc);
				ctx.call();
			},
		});
	};

	if (nativeRtc) client.Proxy("RTCPeerConnection", constructorHandler);
	if (nativeWebkit) {
		if (nativeWebkit === nativeRtc) {
			Reflect_set(
				globals,
				"webkitRTCPeerConnection",
				globals.RTCPeerConnection
			);
		} else {
			client.Proxy("webkitRTCPeerConnection", constructorHandler);
		}
	}
	hookPrototype("RTCPeerConnection", nativeRtc);
	hookPrototype("webkitRTCPeerConnection", nativeWebkit);

	// All page-reachable references must enter the same constructor and method
	// guards. Keep native implementations only in this module's captured closures.
	const protectReference = (native: unknown, guarded: unknown) => {
		if (typeof native !== "function" || typeof guarded !== "function") return;
		client.box.nativeFunctionStrings.set(
			guarded,
			client.box.nativeFunctionStrings.get(native) ??
				Reflect_apply(Function_prototype_toString, native, [])
		);
		client.box.unproxy.delete(guarded);
		for (const name in client.box.ctors) {
			const entries = client.box.ctors[name];
			for (let index = 0; index < entries.length; index++) {
				if (entries[index] === native)
					entries[index] = guarded as (typeof entries)[number];
			}
		}
	};
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
		const native = name === "RTCPeerConnection" ? nativeRtc : nativeWebkit;
		if (!native) continue;
		const guarded = globals[name] as NativeRtcConstructor;
		const descriptor = Object_getOwnPropertyDescriptor(
			native.prototype,
			"constructor"
		)!;
		Object_defineProperty(native.prototype, "constructor", {
			...descriptor,
			value: guarded,
		});
		client.natives.store[name] = guarded;
		protectReference(native, guarded);
		for (const method of [
			"setConfiguration",
			"setLocalDescription",
			"restartIce",
			"close",
		] as const) {
			const guardedMethod = guarded.prototype[method];
			const key = `${name}.prototype.${method}`;
			const nativeMethod = client.natives.store[key];
			client.natives.store[key] = guardedMethod;
			protectReference(nativeMethod, guardedMethod);
		}
	}

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
