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

	// <area> takes part in downloads the same way <a> does
	type Link = HTMLAnchorElement | HTMLAreaElement;
	const isLink = (node: unknown): node is Link =>
		client.box.instanceof(node, "HTMLAnchorElement") ||
		client.box.instanceof(node, "HTMLAreaElement");

	// links this module made itself, which must reach the browser untouched
	const ours = new _WeakSet<object>();
	const FETCH_ERROR = "scramjet: could not fetch the download";

	const isDownload = (anchor: Link) =>
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
	function plan(anchor: Link) {
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

		// an <area> reports the address it was rewritten to, an <a> the real one
		const real = client.unrewriteUrl(href);

		// the browser only honors download for a link to the page's own origin;
		// to anything else it navigates, which the worker can serve
		if (new _URL(real).origin !== client.url.origin) return "navigate" as const;

		return {
			save: () =>
				void saveThroughProxy(client.rewriteUrl(real), wanted).catch((error) =>
					client.natives.call("console.error", self.console, error)
				),
		};
	}

	// Browsers navigate to a cross-origin download link instead of saving it, so
	// do the same: take the attribute off for the click and put it back after.
	function withoutDownload(anchor: Link) {
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
		// the default action of a click runs once its dispatch has finished
		self.setTimeout(
			() =>
				client.natives.call(
					"Element.prototype.setAttribute",
					anchor,
					"download",
					value ?? ""
				),
			0
		);
	}

	// Runs once the page's own handlers have had their say, so a handler that
	// changes the link's address or name is honored.
	function takeOver(event: Event, anchor: Link) {
		if (event.defaultPrevented) return;
		const action = plan(anchor);
		if (!action) return;
		if (action === "navigate") {
			withoutDownload(anchor);
			return;
		}
		event.preventDefault();
		action.save();
	}

	client.natives.call(
		"EventTarget.prototype.addEventListener",
		self,
		"click",
		(event: MouseEvent) => {
			const path = client.natives.call("Event.prototype.composedPath", event);
			const anchor = path.find(isLink);
			if (anchor) takeOver(event, anchor);
		},
		true
	);

	// A link that is not in the document is clicked without any listener on the
	// window seeing it, so listen on the link itself for the length of the call.
	// Added now, it runs after the handlers the page registered earlier.
	client.Proxy("HTMLElement.prototype.click", {
		apply(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (!isLink(ctx.this)) return;
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const anchor = ctx.this;
			if (anchor.isConnected) return;

			const listener = (event: Event) => takeOver(event, anchor);
			client.natives.call(
				"EventTarget.prototype.addEventListener",
				anchor,
				"click",
				listener
			);
			try {
				ctx.call();
			} finally {
				client.natives.call(
					"EventTarget.prototype.removeEventListener",
					anchor,
					"click",
					listener
				);
			}
			return ctx.return(undefined);
		},
	});
}
