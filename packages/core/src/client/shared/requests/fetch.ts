import { NativeHeaders, NativeResponse } from "@/shared/snapshot";
import { ScramjetClient } from "@client/index";
import { unrewriteLinkHeader } from "./xmlhttprequest";
import { String } from "@/shared/snapshot";

/**
 * Capture the page's intended `init.mode` / `init.credentials` and forward
 * them to `rewriteUrl` so they get stamped onto the proxy URL as `sj$mode` /
 * `sj$cred`. The service-side handler reads those back when computing
 * Sec-Fetch-Mode / Sec-Fetch-Storage-Access, since `event.request.mode` and
 * `event.request.credentials` from the SW are derived against the rewritten
 * same-origin URL and don't reflect the page's actual intent.
 */
function rewriteUrlOptionsForFetch(init: RequestInit | undefined) {
	return {
		// `fetch()` and `new Request()` both default mode to "cors" per spec.
		mode: init?.mode ?? "cors",
		credentials: init?.credentials === "include" ? "include" : undefined,
	};
}

// Uploads larger than this keep streaming rather than being read into memory.
const MAX_FLATTENED_BODY = 64 * 1024 * 1024;

const REQUEST_INIT_KEYS = [
	"method",
	"headers",
	"body",
	"referrer",
	"referrerPolicy",
	"mode",
	"credentials",
	"cache",
	"redirect",
	"integrity",
	"keepalive",
	"signal",
	"priority",
	"duplex",
];

export default function (client: ScramjetClient) {
	/**
	 * Whether `body` is a FormData holding files. Safari does not deliver the file
	 * parts of such a body to the service worker (the upload arrives with an empty
	 * file), so the page serializes it itself before the request leaves.
	 */
	function hasFiles(body: unknown): body is FormData {
		if (!client.box.instanceof(body, "FormData")) return false;
		let size = 0;
		let files = false;
		for (const entry of (body as FormData).values()) {
			if (client.box.instanceof(entry, "Blob")) {
				files = true;
				size += (entry as Blob).size;
			} else {
				// text fields are buffered too; their length is a lower bound
				size += String(entry).length;
			}
		}
		return files && size <= MAX_FLATTENED_BODY;
	}

	client.Proxy("fetch", {
		apply(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			const url = String(ctx.args[0]);
			const init = ctx.args[1] as RequestInit | undefined;
			ctx.args[0] = client.rewriteUrl(url, rewriteUrlOptionsForFetch(init));

			const body = init?.body;
			if (init && hasFiles(body)) {
				// fetch reads its options when it is called, so take them now, before
				// the body is serialized and the caller can change them.
				const options: Record<string, unknown> = {};
				for (const key of REQUEST_INIT_KEYS) {
					if (key !== "body" && key in init)
						options[key] = init[key as keyof RequestInit];
				}
				// the body getter may only be read once
				const form = body;
				ctx.return(
					(async () => {
						// built here so invalid headers reject the promise like native fetch
						const headers = new NativeHeaders(options.headers as HeadersInit);
						const serialized = new NativeResponse(form);
						// an explicit Content-Type wins, as it does for a native FormData body
						if (!headers.has("content-type")) {
							headers.set(
								"content-type",
								serialized.headers.get("content-type") as string
							);
						}
						options.body = await serialized.arrayBuffer();
						options.headers = headers;
						ctx.args[1] = options;
						return ctx.call();
					})()
				);
			}
		},
	});

	client.Proxy("Request", {
		construct(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(
				url,
				rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
			);
		},
	});

	client.Trap(["Request.prototype.url", "Response.prototype.url"], {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	// TODO: this needs to be only for response objects created from a fetch
	client.Trap("Response.prototype.headers", {
		get(ctx) {
			const headers = ctx.get() as Headers;
			const newHeaders = new NativeHeaders();

			for (const [key, value] of headers.entries()) {
				if (key.toLowerCase() === "link") {
					newHeaders.append(key, unrewriteLinkHeader(value, client.context));
				} else {
					newHeaders.append(key, value);
				}
			}

			return newHeaders;
		},
	});
}
