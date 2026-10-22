<h1 align="center">Scramjet</h1>
<div align="center">
  <img src="assets/scramjet.png" height="200" />
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/@mercuryworkshop/scramjet"><img src="https://img.shields.io/npm/v/@mercuryworkshop/scramjet.svg?maxAge=3600" alt="npm version" /></a>
  <img src="https://img.shields.io/github/issues/MercuryWorkshop/scramjet?style=flat&color=orange" />
  <img src="https://img.shields.io/github/stars/MercuryWorkshop/scramjet?style=flat&color=orange" />
</div>

---

Scramjet is an experimental interception-based web proxy designed to evade internet censorship and bypass arbitrary browser restrictions.<br><br>
Scramjet allows you to sandbox arbitrary web content, bypass CORS restrictions on loading websites, and instrument and debug websites inside the browser itself. This is accomplished through a combination of interception, rewriting, and sandboxing techniques. You can learn more about the technical details <a href="https://developer.puter.com/blog/how-I-ported-the-web-to-the-web/"><strong>here</strong></a>.<br><br>

## Supported Sites

Some of the popular websites that Scramjet supports include:

- [Google](https://google.com)
- [Youtube](https://youtube.com)
- [Instagram](https://instagram.com)
- [ChatGPT](https://chatgpt.com)
- [Reddit](https://reddit.com)
- [Twitter](https://twitter.com)
- [Discord](https://discord.com)
- [Spotify](https://spotify.com)
- [GeForce NOW](https://play.geforcenow.com/)
- [now.gg](https://now.gg)

## Development

### Dependencies

- Recent versions of `node.js` and `pnpm`
- `rustup`
- `wasm-bindgen`
- [Binaryen's `wasm-opt`](https://github.com/WebAssembly/binaryen)
- [this `wasm-snip` fork](https://github.com/r58Playz/wasm-snip)

#### Building

- Clone the repository with `git clone --recursive https://github.com/MercuryWorkshop/scramjet`
- Install the dependencies with `pnpm i`
- Change directories with `cd packages/core`
- Build the rewriter with `pnpm rewriter:build`
- Build Scramjet with `pnpm build`

### Running Scramjet Locally

You can run the Scramjet dev server when running this command at the root

```sh
pnpm dev
```

The proxy frontend runs on port 4141 and rebuilds when a file changes (excluding
the rewriter). It opens the target website from the request hostname in a
full-screen frame. For example:

```text
https://baidu-com.derp.xs2api.com:8443/test/?q=hello#section
→ https://baidu.com/test/?q=hello#section
```

The proxy port belongs to the proxy endpoint; targets default to HTTPS on their
standard port. Configure the base hostname with `VITE_PROXY_DOMAIN` (default:
`derp.xs2api.com`). Target dots become hyphens and literal hyphens become double
hyphens: `my-site.com` uses `my--site-com.derp.xs2api.com`. Each entry occupies
one subdomain label, covered by `*.derp.xs2api.com`. Generated links use the
explicit target parameter when the encoded label exceeds 63 characters or
starts with the browser-reserved `xn--` prefix.
HTTPS target ports append a numeric suffix: `example.com:9443` uses
`example-com-9443.derp.xs2api.com:8443` when the proxy port is 8443. Ordinary
cross-host GET navigation switches to the corresponding proxy hostname, handing
off cookies shared by the source and destination domain scopes in the current
tab. POST requests, HTTP targets and special paths retain the explicit target
parameter.
Existing multi-level entry URLs should be updated to this flattened format.
For local development:

```sh
VITE_PROXY_DOMAIN=localhost pnpm dev
# Open http://example-com.localhost:4141/
```

See [wildcard proxy deployment](docs/wildcard-proxy.md) for DNS, certificates,
WebSocket forwarding and refresh routing.

### Browser environment profiles

The proxy frontend starts with the Japan preset (`Asia/Tokyo`, `ja-JP, ja, en`).
Its default profile is configured in `packages/demo/src/environment.ts`.
Existing browser profiles saved under `scramjet-environment` remain supported.

Integrations opt in through the controller; the core library defaults to the
native browser environment:

```ts
const controller = new Controller({
  // ...existing initialization...
  scramjetConfig: {
    environment: {
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
      languages: ["ja-JP", "ja", "en"],
      protectFonts: true,
    },
  },
});
```

Profiles cover `navigator.language` / `languages`, default `Intl` formatting,
local `Date` getters, setters, construction and formatting, and outgoing HTTP
`Accept-Language`. `locale` becomes the first language; otherwise the first
`languages` entry supplies it. Values are validated and canonicalized before
controller initialization. Explicit locale/time-zone options, UTC operations,
and timestamps retain their meaning. Set the profile before navigating; reload
existing pages and recreate workers when changing it.

These are JavaScript API overrides within Scramjet-managed realms. They do not
change the operating system, IP location, or browser UI. An uninstrumented realm
or another browser fingerprint can still reveal the host environment; the
profile is not a guarantee against environment detection. Date parsing of
nonstandard legacy strings remains browser-dependent. For complete native
locale/time-zone behavior, configure an isolated browser profile as well.

The Runway `environment-` suite compares six profiles against native browser
contexts. Window/iframe checks cover Chromium, Firefox and WebKit; classic and
module Worker checks cover Chromium and WebKit. Firefox Worker validation is
excluded because the existing `workers-classic-scope` control also times out
with the native environment profile in this harness.

The demo enables `protectFonts` by default. This option replaces explicit
requests for common Simplified/Traditional Chinese system fonts (including
PingFang, Microsoft YaHei, Hiragino Sans GB, STHeiti and STSong) with an unavailable
family, preserving the following fallbacks. CSS names are parsed, including
escaped identifiers; content strings and selectors retain their meaning.
Local `@font-face`/`FontFace` sources are redirected to an unavailable face and
`queryLocalFonts()` returns an empty list. Remote webfonts remain available.
`FontFaceSet.check()` and `load()` use the same rewritten families as rendering;
a missing system family can legitimately yield `true` from `check()`.

Emoji uses bundled **Twemoji Mozilla v0.7.0 / Twemoji 14**, with a pinned file hash
and [upstream attribution](packages/core/assets/fonts/README.md). The font is
loaded from bytes before page scripts run and prepended to rewritten font
families in DOM/CSS, Canvas and OffscreenCanvas, including instrumented workers.
This provides a fixed artwork source. The font
adds approximately 1.5 MB of binary data (base64-encoded) to the client bundle.

Font protection is best effort in a local browser. Generic-family fallback can
still use host CJK fonts. CSS variables/system-font shorthands, uninstrumented
realms, page-supplied fonts, modifications to the injected font set/stylesheets,
image/SVG resources rendered outside the document, newer Emoji sequences and
OS/GPU rasterization can expose differences. Font substitutions can change
layout. The `fonts-` suite checks real DOM/Canvas metrics, local font loading,
escaped names, SVG attributes, iframe installation, and Emoji pixels against
the pinned font in the same browser. Cross-platform pixel identity is not an
acceptance claim.
