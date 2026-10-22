# Persistent access gateway

The gateway authenticates a fixed access key carried by a persistent cookie.
The key remains valid until the server operator changes it. HTTP routes,
WebSocket upgrades and TURN credential requests all require authentication.

The access form saves a verified key in this origin's `localStorage`. A later
visit to `/login` restores the cookie automatically and returns to the requested
page. A rejected key is removed; temporary network errors preserve the saved key.
Logout clears the cookie and browser storage.

The cookie is `__Host-scramjet-access-key` with `Secure`, `HttpOnly`,
`SameSite=Strict` and `Path=/`. It contains the URL-encoded access key and is
renewed on authenticated HTTP requests. Its 400-day lifetime respects browser
cookie limits; the server applies no credential expiry. Stored keys are scoped
to the browser profile and origin. Clearing site data, using a new profile or
rotating the server key requires entering the key again. Browser policies can
limit persistence. Treat the saved key as a bearer credential: JavaScript on
the application origin can access its localStorage copy.

TURN credentials retain their short lifetime and automatic refresh. After
access-key validation the gateway supplies a short-lived internal credential
session to the existing issuer. The access key is not returned by its APIs.

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
the same base domain. Each mapped hostname has its own host-only cookie
and saved key, so the first visit to a new hostname requires the access key.

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
rtk env VITE_GATEWAY_ACCESS=1 VITE_PROXY_DOMAIN=xs2api.com VITE_GATEWAY_HOST=my.xs2api.com pnpm --dir packages/demo build
rtk python3 deployment/package-release.py --base /path/to/previous/release --frontend /path/to/frontend/dist --output /path/to/new/output --release-id wildcard-release --proxy-domain xs2api.com --gateway-host my.xs2api.com
```

The packager retains the previous gateway/TURN configuration, writes a release
manifest and includes the exact application sources in `public/source.tar.gz`.
Runtime secrets remain in the server's mounted secret directory.
