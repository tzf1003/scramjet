# Persistent access gateway

The gateway authenticates a fixed access key carried by a persistent cookie.
The key remains valid until the server operator changes it. HTTP routes,
WebSocket upgrades and TURN credential requests all require authentication.

The access form saves a verified key in this origin's `localStorage`. A later
visit to `/login` restores the cookie automatically and returns to the requested
page. A rejected key is removed; temporary network errors preserve the saved key.
Logout clears the cookie and browser storage.

The cookie is `__Secure-scramjet-access-key` with `Domain=<PROXY_DOMAIN>`,
`Secure`, `HttpOnly`, `SameSite=Strict` and `Path=/`, so a key entered on any
host (the portal or a mapped target) authenticates every `*.<PROXY_DOMAIN>`
host, including the hidden cross-site navigation handoff frames. Host-only
`__Host-scramjet-access-key` cookies from earlier releases are still accepted
and replaced on their next renewal. Set `ACCESS_COOKIE_SCOPE=host` to return to
per-host cookies. It contains the URL-encoded access key and is renewed on
authenticated HTTP requests. Because the key is sent to every subdomain, serve
only this gateway under the proxy domain. Logout on any host clears it for all. Its 400-day lifetime respects browser
cookie limits; the server applies no credential expiry. Stored keys are scoped
to the browser profile and origin. Clearing site data, using a new profile or
rotating the server key requires entering the key again. Browser policies can
limit persistence. Treat the saved key as a bearer credential: JavaScript on
the application origin can access its localStorage copy.

TURN credentials retain their short lifetime and automatic refresh. After
access-key validation the gateway supplies a short-lived internal credential
session to the existing issuer. The access key is not returned by its APIs.

## Gateway headers for the navigation handoff

The nginx gateway sends `Cross-Origin-Embedder-Policy: require-corp` on every
response. Cross-site navigation first loads `/__scramjet_handoff` on the
destination host in a hidden iframe embedded by the source host, so that path
must send `Cross-Origin-Resource-Policy: same-site`. With `same-origin` Chrome
blocks the frame (`net::ERR_BLOCKED_BY_RESPONSE`), the handoff fails and every
cross-site jump falls back to `?__scramjet_url=` on the source host. Keep every
other path on `same-origin`:

```nginx
map $uri $corp { default same-origin; /__scramjet_handoff same-site; }
# in the server block, replacing the fixed value:
add_header Cross-Origin-Resource-Policy $corp always;
```

The gateway container bind-mounts `nginx.conf`, and Docker resolves a `current`
symlink when the container is created, so recreate it after switching releases
(`manage.sh up -d --no-deps gateway`) instead of only restarting it. Check with
`curl -skI` on `/__scramjet_handoff` and `/login` that the two paths return
`same-site` and `same-origin`.

## HTTP caching

The gateway caches file responses according to their resolved file, so a target
URL ending in `.js` still receives an uncached HTML shell.

| Resource | Cache policy |
| --- | --- |
| `/login.js`, `/access-key-client.js`, `/access-session.js`, `/style.css` | Public, 5 minutes, then revalidate |
| Content-hashed JS/CSS/images/fonts in `/assets/` | Private browser cache, 1 year, immutable |
| Other JS/CSS/WASM/images/fonts in `/scramjet/`, `/controller/`, `/assets/`, plus `/home.js` and `/icon.png` | Private browser cache, revalidate with ETag on each use |
| HTML shells, `/login`, `/sw.js`, APIs, TURN credentials, version/source downloads and errors | `no-store` |

Cacheable file responses omit `Set-Cookie`. Authenticated HTML and API requests
continue renewing access cookies. Private file requests validate access before
processing conditional headers and vary on `Cookie`; an unchanged file returns
304, while a new release or changed file invalidates its ETag. GET and HEAD use
the same headers, and HEAD sends no file body.

For Cloudflare, enable Smart Tiered Cache and create an eligible-for-cache rule
with this expression (substitute the deployed proxy domain when needed):

```text
(http.host eq "xs2api.com" or ends_with(http.host, ".xs2api.com")) and http.request.method in {"GET" "HEAD"} and http.request.uri.path in {"/login.js" "/access-key-client.js" "/access-session.js" "/style.css"}
```

Use origin cache-control headers for Edge TTL, bypassing cache when they are
absent, and respect origin TTL for Browser TTL. Keep the standard cache level
and query-string cache keys. Protected resources require `private`/`no-store`
to remain effective at the edge; overriding those directives would bypass
gateway access checks. Wisp carries proxied target traffic over WebSocket,
which Cloudflare's ordinary HTTP cache does not accelerate. This policy improves
gateway loading and repeat visits; target-site transfer time also depends on
the origin server's network path.

## Browser resource cache

The internal resource cache is enabled by default. `HttpCachePlugin` uses the
request and `preresponse` hooks to retain original upstream bytes before
Scramjet rewrites them. IndexedDB database `__scramjet_http_cache_v3` commits
each `ArrayBuffer`, its metadata, generation epoch and eviction changes
atomically. Cached bytes pass through rewriting again on every use.

Eligible resources are GET responses for JavaScript, CSS, images, fonts and
WASM; a fresh GET entry can also satisfy HEAD. SHA-256 keys partition the full
target URL, including its query string, by logical top-level origin, effective
outgoing Cookie and credential mode. `Vary` variants hash the effective
outgoing header values. Requests with Authorization or Range, documents/HTML,
JSON/API responses, media, streams, non-200 responses, `no-store`, `Vary: *`
and responses setting cookies bypass storage.

This is a private browser cache: freshness follows `max-age`, `Expires`,
`Date` and `Age`; `s-maxage` does not supply its lifetime. `no-cache` requires
validation, and `immutable` entries still expire normally. ETag or
Last-Modified validators permit conditional requests; a 304 merges current
headers with the original cached body before rewriting. The normal cookie
pipeline processes each original network `Set-Cookie` once, including on 304.

Each browser origin has a 100 MiB budget, 2,000-entry limit, 8 MiB resource
limit and at most four concurrent writes. Available storage quota can reduce
the budget. Eviction removes stale entries first, then least recently used
entries. Storage denial, quota exhaustion or other storage failures leave
normal network loading available.

Caching runs automatically for eligible resources. Entries are local to each
browser origin, so the portal and mapped subdomains have separate storage.
Aggregate diagnostic counters are available as `window.scramjetCacheStats`
on proxy pages; diagnostics do not log target URLs or cookies.

Login and logout rotate the shared, Secure, nonsecret
`__Secure-scramjet-cache-epoch` cookie. Another subdomain lazily deletes its
old cache on its next use. Open proxy pages also check every five seconds and
on focus/visibility changes. Every read and write checks its generation;
clearing rotates the local epoch so pending writes cannot repopulate it.
The logout marker resolves the active cache scope to `null` until login.
Cleanup covers the plugin's IndexedDB namespace and legacy CacheStorage
`scramjet-http-cache-v2`, preserving target-owned caches.

Repeat visits benefit after eligible resources populate the cache. HTML/API
requests and uncached resources still incur their upstream transfer and Wisp
round-trip time. Actual speedup depends on resource eligibility and cache
warmth; measure representative loads for the deployment.

## Runtime

- `ACCESS_KEY_FILE`: mounted key file, 8–512 characters. Existing deployments
  can keep their original key value. The compatibility default reads
  `/run/secrets/admin-password`; new releases use `/run/secrets/access-key`.
- The Node container runs as UID/GID 1000. Preserve the existing secret file's
  ownership and permissions when migrating it (the current deployment uses
  `root:1000`, mode `0640`), and verify readability before switching releases.
- `CREDENTIAL_SESSION_SECRET`, `TURN_STATIC_AUTH_SECRET` and `TURN_URLS`:
  retain the deployment's existing values.
- `PROXY_DOMAIN`: base domain for mapped target hosts, such as `xs2api.com`.
  A leading `*.` is accepted. `GATEWAY_HOST` selects the portal hostname,
  such as `my.xs2api.com`, and defaults to the base domain.
- Restart the app after rotating the access key; this also closes existing
  proxy sockets. HTTPS must be provided by the deployment gateway.
- `TRUSTED_PROXY_CIDRS`: comma-separated CIDRs of trusted TCP peers. The default
  uses the socket address for login and WebSocket limits. A single valid
  `X-Real-IP` is accepted only from one of these peers; malformed values fall
  back to the socket address. Invalid CIDR configuration stops startup.
  Restrict this list to the gateway, keep the app port private, and have the
  public edge overwrite `X-Real-IP` with its verified client address.
  `package-release.py --trusted-proxy-ip <IPv4>` pins the gateway container's
  address and configures that exact `/32` peer after this edge check.

The production frontend uses `VITE_GATEWAY_ACCESS=1`, `VITE_PROXY_DOMAIN`
and `VITE_GATEWAY_HOST` matching the server configuration. It loads
`/api/config`. The portal and base domain show the home page and accept
`__scramjet_url` targets. Sibling hosts map directly to target sites:
`https://example-com.xs2api.com/path?q=1` opens
`https://example.com/path?q=1`. Literal target hyphens are doubled, and
non-default HTTPS ports use a numeric suffix, such as
`accounts-example-com-9443.xs2api.com`.

Configure wildcard DNS and HTTPS routing for `*.xs2api.com` at the public
edge. Its certificate must be accepted by the upstream TLS client. The
packager updates the internal gateway hostname; the public edge must use
the same base domain. The access cookie is shared across the domain, so the
key is entered once; only the browser's localStorage copy remains per origin.

Camera, microphone and screen capture are enabled in the proxy iframe. The
browser controls device and screen permission prompts. Browser permissions
belong to the proxy origin, which multiple target sites share; an existing
device grant can therefore apply to another proxied target. Scramjet's
shared-origin JavaScript proxy is not a security sandbox for hostile sites.

## Build and validation

Reuse installed dependencies or the package-manager cache. The deployment
package's lockfile supplies its two runtime dependencies.

```sh
rtk npm ci --prefix deployment --ignore-scripts
rtk node --test tests/deployment/access-key.test.mjs
rtk node tests/cache/storage.browser.mjs
rtk node tests/cache/proxy.browser.mjs
rtk env VITE_GATEWAY_ACCESS=1 VITE_PROXY_DOMAIN=xs2api.com VITE_GATEWAY_HOST=my.xs2api.com pnpm --dir packages/demo build
rtk python3 deployment/package-release.py --base /path/to/previous/release --frontend /path/to/frontend/dist --output /path/to/new/output --release-id wildcard-release --proxy-domain xs2api.com --gateway-host my.xs2api.com
```

The packager retains the previous gateway/TURN configuration, writes a release
manifest and includes the exact application sources in `public/source.tar.gz`.
Runtime secrets remain in the server's mounted secret directory.

The storage suite exercises Chromium, Firefox and WebKit. The proxy suite
uses a local target, Wisp server and the real libcurl transport in Chromium;
it checks automatic warm-cache requests, revalidation and cached-script imports. Reuse the
installed Playwright browsers and repository dependencies. Set
`SCRAMJET_CACHE_OUTPUT=/path/to/project/cache-test-output` to place test
evidence and Vite caches on the mounted external drive; the default is
`/tmp/scramjet-cache-tests`. Set `PLAYWRIGHT_BROWSERS_PATH` when reusing a
browser installation outside Playwright's default location.

Production rollout requires building the frontend, packaging the release and
deploying it, followed by validation against that deployed release. The
resource-cache implementation has not been deployed to production.

The libcurl transport patch in `patches/` adds HTTP 304 to its bodyless
response statuses. Keep this patch applied through the frozen pnpm lockfile
so validator responses reach the cache plugin successfully. Run `rtk node tests/cache/portal.browser.mjs` to verify portal navigation.
