import { ScramjetClient } from "@client/index";
import { unrewriteBlob } from "@rewriters/url";
import { dispositionFilename, pathFilename } from "@/shared/download";
import {
	Error,
	String,
	String_startsWith,
	URL_createObjectURL,
	URL_revokeObjectURL,
	_URL,
	_WeakSet,
} from "@/shared/snapshot";

// A link with a download attribute is saved by the browser itself: the request
// never reaches the service worker. The proxy URL such a link was rewritten to
// is only meaningful to the worker, so the gateway answers it with its loader
// page and that page is saved under the file's name. Fetch the file through
// the worker from the page instead and give the browser a blob to save.
export default function (client: ScramjetClient, self: Self) {
	if (!self.HTMLAnchorElement) return;

	// links this module made itself, which must reach the browser untouched
	const ours = new _WeakSet<object>();
	const FETCH_ERROR = "scramjet: could not fetch the download";

	const isDownload = (anchor: HTMLAnchorElement) =>
		client.natives.call("Element.prototype.hasAttribute", anchor, "download");

	function saveNatively(url: string, name: string) {
		const link = client.natives.call(
			"Document.prototype.createElement",
			self.document,
			"a"
		) as HTMLAnchorElement;
		// the proxied href setter would rewrite this object URL back to a proxy one
		client.natives.call("Element.prototype.setAttribute", link, "href", url);
		client.natives.call(
			"Element.prototype.setAttribute",
			link,
			"download",
			name
		);
		ours.add(link);
		// some browsers only save from a link that is in the document
		const root = self.document.documentElement;
		if (root) client.natives.call("Node.prototype.appendChild", root, link);
		client.natives.call("HTMLElement.prototype.click", link);
		client.natives.call("Element.prototype.remove", link);
	}

	async function saveThroughProxy(url: string, wanted: string) {
		const response: Response = await client.natives.call("fetch", self, url, {
			credentials: "same-origin",
		});
		if (!response.ok)
			throw new Error(FETCH_ERROR + " (" + response.status + ")");

		const blob = await response.blob();
		const name =
			dispositionFilename(response.headers.get("content-disposition")) ||
			wanted ||
			pathFilename(new _URL(client.unrewriteUrl(url)).pathname) ||
			"download";
		const objectUrl = URL_createObjectURL(blob);
		saveNatively(objectUrl, name);
		// the save has started once the click returns, but give it a moment
		self.setTimeout(() => URL_revokeObjectURL(objectUrl), 60000);
	}

	/**
	 * What to do with a click on a download link: "save" when this module takes
	 * it over, "navigate" when the link should behave as a plain one, undefined
	 * when it is none of our business.
	 */
	function plan(anchor: HTMLAnchorElement) {
		if (ours.has(anchor) || !isDownload(anchor)) return undefined;

		// the address as the page sees it, whatever the proxy made of the attribute
		const href = String(anchor.href);

		const wanted =
			client.natives.call(
				"Element.prototype.getAttribute",
				anchor,
				"download"
			) || "";

		if (String_startsWith(href, "blob:")) {
			// object URLs are resolved by the browser, no worker involved
			const real = unrewriteBlob(href, client.context, client.meta);
			return { save: () => saveNatively(real, wanted) };
		}
		if (String_startsWith(href, "data:"))
			return { save: () => saveNatively(href, wanted) };
		if (!String_startsWith(href, "http:") && !String_startsWith(href, "https:"))
			return undefined;

		// the browser only honors download for a link to the page's own origin;
		// to anything else it navigates, which the worker can serve
		if (new _URL(href).origin !== client.url.origin) return "navigate" as const;

		return {
			save: () =>
				void saveThroughProxy(client.rewriteUrl(href), wanted).catch((error) =>
					client.natives.call("console.error", self.console, error)
				),
		};
	}

	// Browsers navigate to a cross-origin download link instead of saving it, so
	// do the same: take the attribute off for the click and put it back after.
	function withoutDownload(anchor: HTMLAnchorElement, click?: () => void) {
		const value = client.natives.call(
			"Element.prototype.getAttribute",
			anchor,
			"download"
		);
		client.natives.call(
			"Element.prototype.removeAttribute",
			anchor,
			"download"
		);
		const restore = () =>
			client.natives.call(
				"Element.prototype.setAttribute",
				anchor,
				"download",
				value ?? ""
			);
		if (click) {
			try {
				click();
			} finally {
				restore();
			}
		} else {
			// the default action of a click runs once its dispatch has finished
			self.setTimeout(restore, 0);
		}
	}

	client.natives.call(
		"EventTarget.prototype.addEventListener",
		self,
		"click",
		(event: MouseEvent) => {
			if (event.defaultPrevented) return;
			const path = client.natives.call("Event.prototype.composedPath", event);
			const anchor = path.find((node) =>
				client.box.instanceof(node, "HTMLAnchorElement")
			) as HTMLAnchorElement | undefined;
			if (!anchor) return;

			const action = plan(anchor);
			if (!action) return;
			if (action === "navigate") {
				withoutDownload(anchor);
				return;
			}
			event.preventDefault();
			action.save();
		},
		true
	);

	// a script can click a link that is not in the document, which no listener
	// sees, so the call itself has to be caught as well
	client.Proxy("HTMLElement.prototype.click", {
		apply(ctx) {
			if (!client.box.instanceof(ctx.this, "HTMLAnchorElement")) return;
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const anchor = ctx.this as HTMLAnchorElement;

			const action = plan(anchor);
			if (!action) return;
			if (action === "navigate") {
				withoutDownload(anchor, () => void ctx.call());
				return;
			}
			action.save();
			return ctx.return(undefined);
		},
	});
}
