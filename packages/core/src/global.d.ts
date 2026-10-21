import { SCRAMJETCLIENT } from "./symbols";
import type { ScramjetClient } from "./client";
import type { URLMeta } from "./shared/rewriters/url";

declare global {
	interface Window {
		WASM: string;
		REAL_WASM: Uint8Array;

		/**
		 * The scramjet client belonging to a window.
		 */
		[SCRAMJETCLIENT]: ScramjetClient;
	}

	interface Document {
		/**
		 * Should be the same as window.
		 */
		[SCRAMJETCLIENT]: ScramjetClient;
	}

	const dbg: {
		log: (message: string, ...args: any[]) => void;
		warn: (message: string, ...args: any[]) => void;
		error: (message: string, ...args: any[]) => void;
		debug: (message: string, ...args: any[]) => void;
		time: (meta: URLMeta, before: number, type: string) => void;
	};

	// eslint-disable-next-line scramjet-core/no-globals
	type GlobalThis = typeof globalThis;
	type Self = Window & GlobalThis;

	interface WebSocketStream {
		readonly url: string;
		readonly opened: Promise<{
			readable: ReadableStream;
			writable: WritableStream;
			protocol: string;
			extensions: string;
		}>;
		readonly closed: Promise<{ closeCode: number; reason: string }>;
		close(options?: { closeCode?: number; reason?: string }): void;
	}
	// eslint-disable-next-line no-var -- WebIDL constructors are global object properties.
	var WebSocketStream: {
		prototype: WebSocketStream;
		new (
			url: string | URL,
			options?: { protocols?: string[]; signal?: AbortSignal }
		): WebSocketStream;
	};
}
