import {
	BareResponse,
	type ScramjetFetchRequest,
} from "@mercuryworkshop/scramjet";
import {
	ManagedPlugin,
	type Frame,
} from "@mercuryworkshop/scramjet-controller";
import {
	ResourceCache,
	CACHE_DATABASE,
	type CacheTicket,
	type ResourceCacheOptions,
} from "./http-cache-storage";

export const CACHE_NAME = CACHE_DATABASE;
export interface HttpCachePluginOptions extends ResourceCacheOptions {
	/** Logical top-level site, not the origin of the requested subresource. */
	topOrigin?: () => string;
	store?: ResourceCache;
	/** Compatibility alias for the cache database name. */
	cacheName?: string;
	bypass?: () => boolean;
}
type Flight = {
	ticket: CacheTicket;
	init: Parameters<Frame["fetchHandler"]["client"]["fetch"]>[1];
	url: URL;
};
function headersFromRaw(
	raw: ReadonlyArray<readonly [string, string]>
): Headers {
	const headers = new Headers();
	for (const [name, value] of raw) headers.append(name, value);
	return headers;
}
function native(response: BareResponse): Response {
	return new Response(
		[101, 204, 205, 304].includes(response.status) ? null : response.body,
		{
			status: response.status,
			statusText: response.statusText,
			headers: headersFromRaw(response.rawHeaders),
		}
	);
}
/** Caches upstream bytes before rewriting, partitioned by the effective request. */
export class HttpCachePlugin extends ManagedPlugin {
	readonly store: ResourceCache;
	readonly cacheName: string;
	private flights = new WeakMap<ScramjetFetchRequest, Flight>();
	private hits = new WeakSet<ScramjetFetchRequest>();
	constructor(private options: HttpCachePluginOptions = {}) {
		super("scramjet-http-cache", []);
		this.store =
			options.store ||
			new ResourceCache({
				...options,
				databaseName: options.databaseName || options.cacheName,
			});
		this.cacheName = this.store.name;
	}
	install(frame: Frame): void {
		super.install(frame);
		this.tap(frame.fetchHandler.hooks.fetch.request, async (ctx, props) => {
			if (props.earlyResponse || this.options.bypass?.()) return;
			try {
				const lookup = await this.store.lookup({
					url: props.url.href,
					topOrigin:
						this.options.topOrigin?.() ||
						ctx.parsed.clientUrl?.origin ||
						props.url.origin,
					headers: headersFromRaw(props.init.headers || []),
					credentials: JSON.stringify([
						ctx.request.mode,
						ctx.parsed.fetchCredentialsInclude,
						ctx.parsed.fetchMode,
					]),
					method: ctx.request.method,
					destination: ctx.parsed.destination,
					cache: ctx.request.cache,
				});
				if (lookup.onlyIfCachedMiss) {
					props.earlyResponse = BareResponse.fromNativeResponse(
						new Response(null, { status: 504, statusText: "Cache miss" })
					);
					props.earlyResponse.url = props.url.href;
					this.hits.add(ctx.request);
					return;
				}
				if (lookup.response) {
					props.earlyResponse = BareResponse.fromNativeResponse(
						lookup.response
					);
					props.earlyResponse.url = props.url.href;
					this.hits.add(ctx.request);
					return;
				}
				if (lookup.ticket) {
					this.flights.set(ctx.request, {
						ticket: lookup.ticket,
						init: { ...props.init, headers: [...(props.init.headers || [])] },
						url: props.url,
					});
					if (lookup.ticket.conditional)
						props.init.headers = Array.from(lookup.ticket.headers.entries());
				}
			} catch {
				this.store.stats.failure++;
			}
		});
		this.tap(frame.fetchHandler.hooks.fetch.preresponse, async (ctx, props) => {
			if (this.hits.delete(ctx.request)) return;
			const flight = this.flights.get(ctx.request);
			this.flights.delete(ctx.request);
			if (!flight) return;
			const response = props.response;
			const validating = response.status === 304 && flight.ticket.conditional;
			let retry = false;
			try {
				if (validating && !(await this.store.valid(flight.ticket))) {
					retry = true;
				} else {
					const originalRaw = response.rawHeaders;
					const merged = await this.store.revalidate(
						flight.ticket,
						native(response),
						originalRaw
					);
					if (validating && !(await this.store.valid(flight.ticket))) {
						retry = true;
					} else {
						const live = this.store.store(flight.ticket, merged, originalRaw);
						const replacement = BareResponse.fromNativeResponse(live);
						replacement.url = response.url || flight.url.href;
						replacement.redirected = response.redirected;
						// Each network cookie field is consumed once by the cookie pipeline.
						replacement.rawHeaders = validating
							? [
									...Array.from(merged.headers.entries()).filter(
										([name]) => !/^set-cookie2?$/i.test(name)
									),
									...originalRaw.filter(([name]) =>
										/^set-cookie2?$/i.test(name)
									),
								]
							: originalRaw;
						props.response = replacement;
					}
				}
			} catch {
				this.store.stats.failure++;
				retry = !!validating;
			}
			// A deleted validator body requires a full request. Propagate network failures.
			if (retry)
				props.response = await frame.fetchHandler.client.fetch(
					flight.url,
					flight.init
				);
		});
	}
	async bust(): Promise<boolean> {
		return this.store.clear();
	}
}
