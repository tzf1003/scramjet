import {
	NativeArrayBuffer,
	NativeBlob,
	NativeObject,
	NativePromise,
	NativeReadableStream,
	NativeWritableStream,
} from "@/shared/snapshot";
import { type BareCompatibleWebSocket } from "@mercuryworkshop/proxy-transports";
import { ScramjetClient } from "@client/index";
import {
	Object_setPrototypeOf,
	Reflect_get,
	_URL,
	_WeakMap,
} from "@/shared/snapshot";

type FakeWebSocketState = {
	protocol: string;
	extensions: string;
	url: string;
	binaryType: BinaryType;
	barews: BareCompatibleWebSocket;

	onopen: (ev: Event) => any | null;
	onmessage: (ev: MessageEvent) => any | null;
	onclose: (ev: CloseEvent) => any | null;
	onerror: (ev: Event) => any | null;
};
type FakeWebSocketStreamState = {
	protocol: string;
	extensions: string;
	url: string;
	barews: BareCompatibleWebSocket;

	opened: any;
	closed: any;
	readable: ReadableStream;
	writable: WritableStream;
};
export default function (client: ScramjetClient, self: GlobalThis) {
	const {
		CloseEvent: NativeCloseEvent,
		Event: NativeEvent,
		EventTarget: NativeEventTarget,
		MessageEvent: NativeMessageEvent,
	} = self;
	const socketmap: WeakMap<WebSocket, FakeWebSocketState> =
		new _WeakMap() as WeakMap<WebSocket, FakeWebSocketState>;
	const socketstreammap: WeakMap<WebSocketStream, FakeWebSocketStreamState> =
		new _WeakMap() as WeakMap<WebSocketStream, FakeWebSocketStreamState>;
	client.Proxy("WebSocket", {
		construct(ctx) {
			const fakeWebSocket = new NativeEventTarget() as WebSocket;
			Object_setPrototypeOf(fakeWebSocket, ctx.fn.prototype);
			fakeWebSocket.constructor = ctx.fn;

			// websockets can take relative URLs
			let rawurl = new _URL(ctx.args[0], client.url.href);
			if (rawurl.protocol === "http:") {
				rawurl = new _URL(
					"ws:" + rawurl.href.substring(rawurl.protocol.length)
				);
			} else if (rawurl.protocol === "https:") {
				rawurl = new _URL(
					"wss:" + rawurl.href.substring(rawurl.protocol.length)
				);
			}
			const url = rawurl.href;

			const trustEvent = (ev: Event) =>
				new Proxy(ev, {
					get(target, prop) {
						if (prop === "isTrusted") return true;

						return Reflect_get(target, prop);
					},
				});

			const barews = client.bare.createWebSocket(url, ctx.args[1], [
				["User-Agent", self.navigator.userAgent],
				["Origin", client.url.origin],
				["Cookie", client.context.cookieJar.getCookies(client.url, false)],
			]);

			const state: FakeWebSocketState = {
				protocol: "",
				extensions: "",
				url,
				binaryType: "blob",
				barews,

				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
			};

			function fakeEventSend(fakeev: Event) {
				state["on" + fakeev.type]?.(trustEvent(fakeev));
				fakeWebSocket.dispatchEvent(fakeev);
			}

			barews.addEventListener("open", () => {
				fakeEventSend(new NativeEvent("open"));
			});
			barews.addEventListener("close", (ev) => {
				fakeEventSend(new NativeCloseEvent("close", ev));
			});
			barews.addEventListener("message", async (ev: MessageEvent) => {
				let payload = ev.data;
				if (typeof payload === "string") {
					// DO NOTHING
				} else if ("byteLength" in payload) {
					// arraybuffer, convert to blob if needed or set the proper prototype
					if (state.binaryType === "blob") {
						payload = new NativeBlob([payload]);
					} else {
						Object_setPrototypeOf(payload, NativeArrayBuffer.prototype);
					}
				} else if ("arrayBuffer" in payload) {
					// blob, convert to arraybuffer if neccesary.
					if (state.binaryType === "arraybuffer") {
						payload = await payload.arrayBuffer();
						Object_setPrototypeOf(payload, NativeArrayBuffer.prototype);
					}
				}

				const fakeev = new NativeMessageEvent("message", {
					data: payload,
					origin: ev.origin,
					lastEventId: ev.lastEventId,
					source: ev.source,
					ports: [...ev.ports],
				});

				fakeEventSend(fakeev);
			});
			barews.addEventListener("error", () => {
				fakeEventSend(new NativeEvent("error"));
			});

			socketmap.set(fakeWebSocket, state);
			ctx.return(fakeWebSocket);
		},
	});
	client.Trap("WebSocket.prototype.binaryType", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.binaryType;
		},
		set(ctx, v: BinaryType) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);
			if (v === "blob" || v === "arraybuffer") ws.binaryType = v;
		},
	});

	client.Trap("WebSocket.prototype.bufferedAmount", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return 0;
		},
	});

	client.Trap("WebSocket.prototype.extensions", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.extensions;
		},
	});

	client.Trap("WebSocket.prototype.onopen", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onopen;
		},
		set(ctx, v: (ev: Event) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onopen = v;
		},
	});

	client.Trap("WebSocket.prototype.onmessage", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onmessage;
		},
		set(ctx, v: (ev: MessageEvent) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onmessage = v;
		},
	});

	client.Trap("WebSocket.prototype.onclose", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onclose;
		},
		set(ctx, v: (ev: CloseEvent) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onclose = v;
		},
	});

	client.Trap("WebSocket.prototype.onerror", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onerror;
		},
		set(ctx, v: (ev: Event) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onerror = v;
		},
	});

	client.Trap("WebSocket.prototype.url", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.url;
		},
	});

	client.Trap("WebSocket.prototype.protocol", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.protocol;
		},
	});

	client.Trap("WebSocket.prototype.readyState", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.barews.readyState;
		},
	});

	client.Proxy("WebSocket.prototype.send", {
		apply(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return;

			const data = ctx.args[0];
			const payload = self.ArrayBuffer.isView(data)
				? (new self.Uint8Array(
						data.buffer,
						data.byteOffset,
						data.byteLength
					).slice().buffer as ArrayBuffer)
				: data;
			void ws.barews.send(payload as string | ArrayBuffer | Blob);
			ctx.return(undefined);
		},
	});

	client.Proxy("WebSocket.prototype.close", {
		apply(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return;

			if (ctx.args[0] === undefined) ctx.args[0] = 1000;
			if (ctx.args[1] === undefined) ctx.args[1] = "";
			ctx.return(ws.barews.close(ctx.args[0], ctx.args[1]));
		},
	});

	client.Proxy("WebSocketStream", {
		construct(ctx) {
			const fakeWebSocket = {} as WebSocketStream;
			Object_setPrototypeOf(fakeWebSocket, ctx.fn.prototype);
			fakeWebSocket.constructor = ctx.fn;

			const url = new _URL(ctx.args[0], client.url.href).href;
			const barews = client.bare.createWebSocket(url, ctx.args[1]?.protocols, [
				["User-Agent", self.navigator.userAgent],
				["Origin", client.url.origin],
			]);
			ctx.args[1]?.signal?.addEventListener("abort", () => {
				barews.close(1000, "");
			});
			const state: FakeWebSocketStreamState = {
				protocol: "",
				extensions: "",
				url,
				barews,

				opened: new NativePromise((resolve, reject) => {
					barews.addEventListener("open", () => {
						resolve({
							readable: state.readable,
							writable: state.writable,
							protocol: state.protocol,
							extensions: state.extensions,
						});
					});
					barews.addEventListener("error", (ev: Event) => {
						reject(ev);
					});
				}),
				closed: new NativePromise((resolve) => {
					barews.addEventListener("close", (ev: CloseEvent) => {
						resolve({ closeCode: ev.code, reason: ev.reason });
					});
				}),
				readable: new NativeReadableStream({
					start(controller) {
						barews.addEventListener("message", async (ev: MessageEvent) => {
							let payload = ev.data;
							// TODO: this needs to be changed to uint8array later
							// chrome isnt following spec though so we are just going to do this
							if (typeof payload === "string") {
								// DO NOTHING
							} else if ("byteLength" in payload) {
								// arraybuffer, set the realms prototype so its recognized
								NativeObject.setPrototypeOf(
									payload,
									NativeArrayBuffer.prototype
								);
							} else if ("arrayBuffer" in payload) {
								// blob, convert to arraybuffer
								payload = await payload.arrayBuffer();
								NativeObject.setPrototypeOf(
									payload,
									NativeArrayBuffer.prototype
								);
							}
							controller.enqueue(payload);
						});
					},
					cancel(info) {
						barews.close(info?.closeCode ?? 1000, info?.reason ?? "");
					},
				}),
				writable: new NativeWritableStream({
					write(chunk) {
						barews.send(chunk);
					},
					abort() {
						barews.close(1000, "");
					},
					close() {
						barews.close(1000, "");
					},
				}),
			};

			socketstreammap.set(fakeWebSocket, state);
			ctx.return(fakeWebSocket);
		},
	});

	client.Trap("WebSocketStream.prototype.opened", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.opened;
		},
	});

	client.Trap("WebSocketStream.prototype.closed", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.closed;
		},
	});

	client.Trap("WebSocketStream.prototype.url", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.url;
		},
	});

	client.Proxy("WebSocketStream.prototype.close", {
		apply(ctx) {
			const ws = socketstreammap.get(ctx.this);
			if (ctx.args[0]) {
				if (ctx.args[0].closeCode === undefined) ctx.args[0].closeCode = 1000;
				if (ctx.args[0].reason === undefined) ctx.args[0].reason = "";

				return ctx.return(
					ws.barews.close(ctx.args[0].closeCode, ctx.args[0].reason)
				);
			}

			return ctx.return(ws.barews.close(1000, ""));
		},
	});
}
