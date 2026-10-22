import type { ScramjetEnvironmentConfig } from "../types";
import {
	Intl_DateTimeFormat,
	Intl_getCanonicalLocales,
	TypeError,
	Array_isArray,
	Math_max,
} from "./snapshot";

/** Validate before navigation so a malformed profile cannot silently fall back. */
export function normalizeEnvironment(
	config: ScramjetEnvironmentConfig = {}
): ScramjetEnvironmentConfig {
	const result: ScramjetEnvironmentConfig = {};
	if (config.protectFonts !== undefined) {
		if (typeof config.protectFonts !== "boolean")
			throw new TypeError("environment.protectFonts must be a boolean");
		result.protectFonts = config.protectFonts;
	}
	if (config.timezone !== undefined) {
		result.timezone = new Intl_DateTimeFormat("en", {
			timeZone: config.timezone,
		}).resolvedOptions().timeZone;
	}
	if (config.locale !== undefined) {
		result.locale = Intl_getCanonicalLocales(config.locale)[0];
		if (!result.locale)
			throw new TypeError("environment.locale must be a BCP 47 locale");
	}
	if (config.languages !== undefined) {
		if (!Array_isArray(config.languages) || !config.languages.length)
			throw new TypeError(
				"environment.languages must be a nonempty locale array"
			);
		result.languages = Intl_getCanonicalLocales(config.languages);
	}
	if (result.locale || result.languages) {
		result.locale ??= result.languages![0];
		result.languages = Intl_getCanonicalLocales([
			result.locale!,
			...(result.languages ?? []),
		]);
	}
	return result;
}

export function environmentAcceptLanguage(
	config?: ScramjetEnvironmentConfig
): string | undefined {
	const languages = normalizeEnvironment(config).languages;
	return languages
		?.map((language, index) =>
			index === 0
				? language
				: `${language};q=${Math_max(0.1, 1 - index * 0.1).toFixed(1)}`
		)
		.join(",");
}
