import type { ScramjetWebrtcConfig } from "./shared/webrtc";

/** Optional environment values exposed to proxied pages. */
export interface ScramjetEnvironmentConfig {
	/** IANA time zone for local Date operations and default Intl formatting. */
	timezone?: string;
	/** Default BCP 47 locale; also placed first in languages. */
	locale?: string;
	/** Ordered BCP 47 locales for navigator and Accept-Language. */
	languages?: string[];
	/** Best-effort local-font restrictions and bundled Twemoji 14 rendering. */
	protectFonts?: boolean;
}

/**
 * Version information for the current Scramjet build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface ScramjetVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Scramjet Feature Flags, configured at build time
 */
export type ScramjetFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
};

export interface ScramjetConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: ScramjetFlags;
	siteFlags: Record<string, Partial<ScramjetFlags>>;
	maskedfiles: string[];
	/**
	 * WebRTC network policy. Set by the trusted controller; proxied pages cannot
	 * modify it. See docs/webrtc-architecture.md.
	 */
	webrtc: ScramjetWebrtcConfig;
	/** Omitted fields use the native browser environment. */
	environment?: ScramjetEnvironmentConfig;
}

/**
 * The config for Scramjet initialization.
 */
export interface ScramjetInitConfig
	extends Omit<ScramjetConfig, "codec" | "flags"> {
	flags: Partial<ScramjetFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
