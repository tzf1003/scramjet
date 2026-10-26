import { ScramjetHeaders } from "@mercuryworkshop/scramjet";
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
import { needsShell } from "./shell-document";

/**
 * Intercepts top-level navigation requests (triggered by clicking "open in new tab" on a link, or window.open)
 * Without this plugin, they would open without the proxy shell, which is usually undesired.
 * give a callback telling it how to redirect back to the proxy shell.
 *
 * Downloads reach the worker as top-level navigations too, so a GET is only
 * redirected once its response turns out to be a page. A file, or anything sent
 * as an attachment, is passed through; redirecting it would save the shell's
 * loading page under the file's name.
 */
export class CatchEscapedLinksPlugin extends ManagedPlugin {
	constructor(private toLocation: (url: URL) => string | URL) {
		super("catch-escaped-links", []);
	}

	private redirect(url: URL) {
		return {
			body: "",
			status: 302,
			statusText: "Found",
			headers: ScramjetHeaders.fromRawHeaders([
				["Location", String(this.toLocation(url))],
			]),
		};
	}

	install(frame: Frame): void {
		this.tap(
			frame.hooks.fetch.intercept,
			(context, props) => {
				if (context.parsed.destination !== "document") return;
				// Only a GET can be repeated once the response has been inspected.
				if (["GET", "HEAD"].includes(context.request.method)) return;

				props.response = this.redirect(context.parsed.url);
			},
			{ after: ["scramjet-http-cache"] }
		);
		this.tap(frame.hooks.fetch.response, (context, props) => {
			if (context.parsed.destination !== "document") return;
			if (!["GET", "HEAD"].includes(context.request.method)) return;
			// blob: and data: documents only exist for the page that made them
			if (!["http:", "https:"].includes(context.parsed.url.protocol)) return;
			if (!needsShell(props.response.status, props.response.headers)) return;

			props.response = this.redirect(context.parsed.url);
		});
	}
}
