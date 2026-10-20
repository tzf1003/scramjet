import { playwrightTest } from "../../testcommon.ts";

export default [
	playwrightTest({
		name: "site-youtube-frontpage",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/");

			// Wait for the YouTube logo to be visible
			const logo = frame.locator("#logo-icon > span > div").first();
			await logo.waitFor({ state: "visible", timeout: 30000 });
		},
	}),

	playwrightTest({
		name: "site-youtube-search",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/results?search_query=bad+apple");

			// Wait for search results to load
			const title = frame
				.locator("ytd-video-renderer a#video-title, yt-lockup-view-model h3 a")
				.first();
			await title.waitFor({ state: "visible", timeout: 30000 });

			const thumbnail = frame
				.locator(
					"ytd-video-renderer ytd-thumbnail img, yt-lockup-view-model img"
				)
				.first();
			await thumbnail.waitFor({ state: "visible", timeout: 30000 });
		},
	}),
];
