import {
	normalizeEnvironment,
	type ScramjetEnvironmentConfig,
} from "@mercuryworkshop/scramjet";

export const japanEnvironment: ScramjetEnvironmentConfig = {
	timezone: "Asia/Tokyo",
	locale: "ja-JP",
	languages: ["ja-JP", "ja", "en"],
	protectFonts: true,
};
const key = "scramjet-environment";

export function loadEnvironment(): ScramjetEnvironmentConfig {
	try {
		const stored = localStorage.getItem(key);
		return normalizeEnvironment(
			stored
				? { protectFonts: true, ...JSON.parse(stored) }
				: japanEnvironment
		);
	} catch {
		return normalizeEnvironment(japanEnvironment);
	}
}

export function saveEnvironment(config: ScramjetEnvironmentConfig) {
	const normalized = normalizeEnvironment(config);
	localStorage.setItem(key, JSON.stringify(normalized));
	return normalized;
}
