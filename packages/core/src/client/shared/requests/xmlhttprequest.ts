import {
	NativeDataView,
	NativeError,
	NativeRegExp,
	NativeResponse,
	NativeSharedArrayBuffer,
	NativeSymbol,
	NativeTextDecoder,
	NativeUint8Array,
	Nativeconsole,
	Nativeperformance,
} from "@/shared/snapshot";
import { ScramjetContext } from "@/shared";
import { rewriteUrl, unrewriteUrl, URLMeta } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { hasFiles } from "./fetch";

export default function (client: ScramjetClient, self: Self) {
	const { DOMParser: NativeDOMParser } = self;
	let worker;
	// if (self.Worker && flagEnabled("syncxhr", client.url)) {
	// 	worker = client.natives.construct("Worker", config.files.sync);
	// }
	const ARGS = NativeSymbol("xhr original args");
	const HEADERS = NativeSymbol("xhr headers");
	const PENDING = NativeSymbol("xhr pending file send");

	client.Proxy("XMLHttpRequest.prototype.open", {
		apply(ctx) {
			if (ctx.args[1]) ctx.args[1] = client.rewriteUrl(ctx.args[1]);
			if (ctx.args[2] === undefined) ctx.args[2] = true;
			ctx.this[ARGS] = ctx.args;
			// open() starts a new request: its headers and any pending send are gone
			ctx.this[HEADERS] = undefined;
			ctx.this[PENDING] = null;
		},
	});

	client.Proxy("XMLHttpRequest.prototype.setRequestHeader", {
		apply(ctx) {
			const headers = ctx.this[HEADERS] || (ctx.this[HEADERS] = {});
			headers[ctx.args[0]] = ctx.args[1];
		},
	});

	client.Proxy("XMLHttpRequest.prototype.abort", {
		apply(ctx) {
			// a send still waiting on its serialized body is cancelled too
			ctx.this[PENDING] = null;
		},
	});

	client.Proxy("XMLHttpRequest.prototype.send", {
		apply(ctx) {
			const args = ctx.this[ARGS];
			if (args && args[2] && hasFiles(client, ctx.args[0])) {
				// Safari drops the file parts of a FormData sent from a page to the
				// service worker, so send the serialized bytes instead
				const xhr = ctx.this as XMLHttpRequest;
				const form = ctx.args[0] as FormData;
				const headers = ctx.this[HEADERS] || {};
				let hasType = false;
				for (const name in headers) {
					if (name.toLowerCase() === "content-type") hasType = true;
				}
				// one token per send, so a stale serialization cannot fire a newer request
				const token = {};
				ctx.this[PENDING] = token;
				ctx.return(undefined);
				(async () => {
					const serialized = new NativeResponse(form);
					const type = serialized.headers.get("content-type") as string;
					ctx.args[0] = await serialized.arrayBuffer();
					// an explicit Content-Type wins, as it does for a native FormData body
					if (ctx.this[PENDING] === token && !hasType) {
						xhr.setRequestHeader("content-type", type);
					}
				})().then(
					() => {
						if (ctx.this[PENDING] !== token) return;
						ctx.this[PENDING] = null;
						ctx.call();
					},
					() => {
						if (ctx.this[PENDING] !== token) return;
						ctx.this[PENDING] = null;
						ctx.args[0] = form;
						ctx.call();
					}
				);
				return;
			}
			if (!args || args[2]) return;

			if (!client.flagEnabled("syncxhr")) {
				Nativeconsole.warn("ignoring request - sync xhr disabled in flags");

				return ctx.return(undefined);
			}

			// it's a sync request
			// sync xhr to service worker is not supported
			// there's a nice way of polyfilling this though, we can spin on an atomic using sharedarraybuffer. this will maintain the sync behavior

			//@ts-ignore
			const sab = new NativeSharedArrayBuffer(1024, {
				maxByteLength: 2147483647,
			});
			const view = new NativeDataView(sab);

			client.natives.call("Worker.prototype.postMessage", worker, {
				sab,
				args,
				headers: ctx.this[HEADERS],
				body: ctx.args[0],
			});

			const now = Nativeperformance.now();
			while (view.getUint8(0) === 0) {
				if (Nativeperformance.now() - now > 1000) {
					throw new NativeError("xhr timeout");
				}
				/* spin */
			}

			const status = view.getUint16(1);
			const headersLength = view.getUint32(3);

			const headersab = new NativeUint8Array(headersLength);
			headersab.set(new NativeUint8Array(sab.slice(7, 7 + headersLength)));
			const headers = new NativeTextDecoder().decode(headersab);

			const bodyLength = view.getUint32(7 + headersLength);
			const bodyab = new NativeUint8Array(bodyLength);
			bodyab.set(
				new NativeUint8Array(
					sab.slice(11 + headersLength, 11 + headersLength + bodyLength)
				)
			);
			const body = new NativeTextDecoder().decode(bodyab);

			// these should be using proxies to not leak scram strings but who cares
			client.RawTrap(ctx.this, "status", {
				get() {
					return status;
				},
			});
			client.RawTrap(ctx.this, "responseText", {
				get() {
					return body;
				},
			});
			client.RawTrap(ctx.this, "response", {
				get() {
					if (ctx.this.responseType === "arraybuffer") return bodyab.buffer;

					return body;
				},
			});
			client.RawTrap(ctx.this, "responseXML", {
				get() {
					const parser = new NativeDOMParser();

					return parser.parseFromString(body, "text/xml");
				},
			});
			client.RawTrap(ctx.this, "getAllResponseHeaders", {
				get() {
					return () => headers;
				},
			});
			client.RawTrap(ctx.this, "getResponseHeader", {
				get() {
					return (header: string) => {
						const re = new NativeRegExp(`^${header}: (.*)$`, "m");
						const match = re.exec(headers);

						return match ? match[1] : null;
					};
				},
			});

			ctx.return(undefined);
		},
	});

	client.Trap("XMLHttpRequest.prototype.responseURL", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.getAllResponseHeaders", {
		apply(ctx) {
			const headerstring = ctx.fn.call(ctx.this) as string;
			if (!headerstring) return headerstring;
			const headers = headerstring.split("\r\n");

			for (const [i, header] of headers.entries()) {
				if (header.toLowerCase().startsWith("link:")) {
					headers[i] = `Link: ${unrewriteLinkHeader(
						header.slice(5).trim(),
						client.context
					)}`;
				}
			}

			ctx.return(headers.join("\r\n"));
		},
	});
	client.Proxy("XMLHttpRequest.prototype.getResponseHeader", {
		apply(ctx) {
			const header = ctx.fn.call(ctx.this, ctx.args[0]) as string | null;
			if (!header) return header;
			if (ctx.args[0].toLowerCase() === "link") {
				ctx.return(unrewriteLinkHeader(header, client.context));
			}
		},
	});
}

export function unrewriteLinkHeader(header: string, context: ScramjetContext) {
	return header.replace(
		/<([^>]+)>/gi,
		(_match, p1) => `<${unrewriteUrl(p1, context)}>`
	);
}
