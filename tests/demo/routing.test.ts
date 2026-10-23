import assert from "node:assert/strict";
import { test } from "node:test";
import {
	normalizeProxyDomain,
	isGatewayEntry,
	resolveTarget,
	proxyUrl,
	shellUrl,
	TARGET_QUERY,
} from "../../packages/demo/src/routing.ts";
import {
	consumeHandoff,
	destinationCookies,
	isProxyPeer,
	transferableCookies,
} from "../../packages/demo/src/handoff.ts";

const base = "xs2api.com";
const entry = new URL(`https://baidu-com.${base}:8443/test/?q=a%2Fb#section`);

test("flattened wildcard entry preserves path, query and hash, independently of proxy port", () => {
	assert.equal(
		resolveTarget(entry, base).href,
		"https://baidu.com/test/?q=a%2Fb#section"
	);
	assert.equal(
		resolveTarget(new URL(`https://www-baidu-com.${base}/a.html`), base).href,
		"https://www.baidu.com/a.html"
	);
	assert.equal(
		resolveTarget(
			new URL(`https://baidu-com.${base}//another.example/path`),
			base
		).href,
		"https://baidu.com//another.example/path"
	);
});

test("suffix matching rejects apex and lookalike hosts", () => {
	for (const host of [
		base,
		`evil${base}`,
		`${base}.evil.example`,
		"baidu.com",
		`baidu.com.${base}`,
		`a---b.${base}`,
		`--bad-com.${base}`,
		`${"a".repeat(64)}.${base}`,
	]) {
		assert.throws(() => resolveTarget(new URL(`https://${host}/`), base));
	}
	for (const domain of [
		"",
		"https://example.com",
		"example.com:8443",
		".example.com",
		"a..b",
		"-a.test",
	]) {
		assert.throws(() => normalizeProxyDomain(domain));
	}
	assert.equal(normalizeProxyDomain("XS2API.COM."), base);
	assert.equal(normalizeProxyDomain("*.XS2API.COM"), base);
});

test("portal and apex entries are distinct from mapped target hosts", () => {
	for (const host of ["xs2api.com", "my.xs2api.com"])
		assert.equal(
			isGatewayEntry(new URL(`https://${host}/`), base, "my.xs2api.com"),
			true
		);
	for (const host of ["example-com.xs2api.com", "my.xs2api.com.evil.test"])
		assert.equal(
			isGatewayEntry(new URL(`https://${host}/`), base, "my.xs2api.com"),
			false
		);
	assert.equal(
		resolveTarget(
			new URL("https://example-com.xs2api.com/hello?q=1#part"),
			"*.xs2api.com"
		).href,
		"https://example.com/hello?q=1#part"
	);
});

test("new-tab links map to wildcard hosts with the proxy scheme and port", () => {
	const url = proxyUrl(new URL("https://www.example.com/a?b=c#d"), entry, base);
	assert.equal(url.href, `https://www-example-com.${base}:8443/a?b=c#d`);
	assert.equal(
		resolveTarget(url, base).href,
		"https://www.example.com/a?b=c#d"
	);
});

test("HTTPS target ports are encoded separately from the proxy port", () => {
	for (const port of ["1", "9443", "65535"]) {
		const target = new URL(`https://example.com:${port}/test/?q=a%2Fb#part`);
		const url = proxyUrl(target, entry, base);
		assert.equal(
			url.href,
			`https://example-com-${port}.${base}:8443/test/?q=a%2Fb#part`
		);
		assert.equal(resolveTarget(url, base).href, target.href);
	}
	assert.equal(
		resolveTarget(new URL(`https://example-com-443.${base}/`), base).href,
		"https://example.com/"
	);
	for (const label of [
		"example-com-0",
		"example-com-65536",
		"example-com-09443",
	]) {
		assert.throws(() =>
			resolveTarget(new URL(`https://${label}.${base}/`), base)
		);
	}
	for (const hostname of ["my-9443.com", "my--9443.com", "a123.example"]) {
		const target = new URL(`https://${hostname}:9443/test/`);
		assert.equal(
			resolveTarget(proxyUrl(target, entry, base), base).href,
			target.href
		);
	}
	const boundary = new URL(`https://${"a".repeat(54)}.com:9443/`);
	assert.equal(
		proxyUrl(boundary, entry, base).hostname.split(".")[0].length,
		63
	);
	const long = new URL(`https://${"a".repeat(55)}.com:9443/`);
	assert.equal(
		proxyUrl(long, entry, base).searchParams.get(TARGET_QUERY),
		long.href
	);
});

test("numeric IP addresses use an unambiguous explicit target", () => {
	for (const value of [
		"https://127.0.0.1/",
		"https://127.0.0.1:9443/",
		"https://[::1]:9443/",
	]) {
		const target = new URL(value);
		const url = proxyUrl(target, entry, base);
		assert.equal(url.searchParams.get(TARGET_QUERY), target.href);
		assert.equal(resolveTarget(url, base).href, target.href);
	}
});

test("numeric hostname text stays distinct from HTTPS port suffixes", () => {
	for (const [value, label] of [
		["https://foo:9443/", "foo-9443"],
		["https://foo-9443/", "foo--9443"],
		["https://foo-9443:8443/", "foo--9443-8443"],
	]) {
		const target = new URL(value);
		const publicUrl = proxyUrl(target, entry, base);
		assert.equal(publicUrl.hostname, `${label}.${base}`);
		assert.equal(resolveTarget(publicUrl, base).href, target.href);
	}
	// WHATWG HTTP(S) parsing treats numeric final labels as IPv4 candidates.
	assert.throws(() => new URL("https://foo.9443/"), TypeError);
});

test("handoff peers require the configured suffix, scheme and proxy port", () => {
	assert.equal(
		isProxyPeer(`https://accounts-example-com.${base}:8443`, entry, base),
		true
	);
	for (const origin of [
		`https://accounts-example-com.${base}`,
		`http://accounts-example-com.${base}:8443`,
		`https://accounts-example-com.${base}.evil.test:8443`,
		`https://${base}:8443`,
		`https://accounts-example-com.${base}:8443/path`,
		"null",
	])
		assert.equal(isProxyPeer(origin, entry, base), false);
});

test("cookie handoff includes only destination domain cookies", () => {
	const cookie = (domain: string, hostOnly: boolean) => ({
		domain,
		hostOnly,
		name: "session",
		value: "secret",
		path: "/",
		httpOnly: true,
	});
	const cookies = {
		".accounts.example.com@/@session": cookie(".accounts.example.com", true),
		".example.com@/@session": cookie(".example.com", false),
		".other.example.com@/@session": cookie(".other.example.com", true),
		".notexample.com@/@session": cookie(".notexample.com", false),
		invalid: { domain: ".example.com" },
	};
	assert.deepEqual(
		JSON.parse(
			destinationCookies(
				JSON.stringify(cookies),
				new URL("https://accounts.example.com/")
			)
		),
		{
			".accounts.example.com@/@session":
				cookies[".accounts.example.com@/@session"],
			".example.com@/@session": cookies[".example.com@/@session"],
		}
	);
	assert.equal(
		destinationCookies(
			JSON.stringify({
				".example.com@/@session": cookie(".example.com", true),
			}),
			new URL("https://accounts.example.com/")
		),
		"{}"
	);
	assert.equal(
		transferableCookies(
			JSON.stringify(cookies),
			new URL("https://unrelated.test/"),
			new URL("https://accounts.example.com/")
		),
		"{}"
	);
});

test("cookie handoff rejects ICANN and private public suffix scopes", () => {
	for (const [source, target, suffix] of [
		["attacker.com", "victim.com", "com"],
		["attacker.co.uk", "victim.co.uk", "co.uk"],
		["attacker.github.io", "victim.github.io", "github.io"],
	]) {
		const cookies = JSON.stringify({
			[`.${suffix}@/@session`]: {
				domain: `.${suffix}`,
				name: "session",
				value: "injected",
				path: "/",
			},
		});
		assert.equal(
			transferableCookies(
				cookies,
				new URL(`https://${source}`),
				new URL(`https://${target}`)
			),
			"{}"
		);
		assert.equal(
			destinationCookies(cookies, new URL(`https://${target}`)),
			"{}"
		);
	}
});

test("handoff state is scoped to one target, expires and is consumed once", () => {
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"sessionStorage"
	);
	let stored: string | null = null;
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: {
			getItem: () => stored,
			removeItem: () => {
				stored = null;
			},
		},
	});
	try {
		const state = {
			source: entry.origin,
			target: resolveTarget(entry, base).href,
			cookies: "{}",
			referrer: "https://baidu.com/",
			initiator: "https://baidu.com",
			fetchSite: "same-origin" as const,
			crossSiteRedirect: false,
			createdAt: Date.now(),
		};
		stored = JSON.stringify(state);
		assert.deepEqual(consumeHandoff(entry, base), state);
		assert.equal(consumeHandoff(entry, base), undefined);
		const destination = new URL(
			`https://accounts-example-com.${base}:8443/login`
		);
		for (const referrer of ["", "https://accounts.example.com/private"]) {
			stored = JSON.stringify({
				...state,
				target: "https://accounts.example.com/login",
				referrer,
				initiator: "https://accounts.example.com",
				fetchSite: "same-origin",
			});
			const verified = consumeHandoff(destination, base)!;
			assert.equal(verified.initiator, "https://baidu.com");
			assert.equal(verified.referrer, referrer ? "https://baidu.com/" : "");
			assert.equal(verified.fetchSite, "cross-site");
			assert.equal(verified.crossSiteRedirect, true);
		}
		// Separate tenants on private suffixes are cross-site, too.
		stored = JSON.stringify({
			...state,
			source: `https://attacker-github-io.${base}:8443`,
			target: "https://victim.github.io/",
		});
		assert.equal(
			consumeHandoff(new URL(`https://victim-github-io.${base}:8443/`), base)
				?.crossSiteRedirect,
			true
		);
		for (const patch of [
			{ target: "https://baidu.com/other" },
			{ createdAt: Date.now() - 121_000 },
			{ createdAt: Date.now() + 121_000 },
			{ cookies: '{"invalid":{"domain":".evil.example"}}' },
			{ initiator: "ftp://example.com" },
		]) {
			stored = JSON.stringify({ ...state, ...patch });
			assert.equal(consumeHandoff(entry, base), undefined);
			assert.equal(stored, null);
		}
	} finally {
		if (descriptor)
			Object.defineProperty(globalThis, "sessionStorage", descriptor);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	}
});

test("same-origin navigation keeps clean public paths", () => {
	const url = shellUrl(
		new URL("https://baidu.com/next.html?q=1#two"),
		entry,
		base
	);
	assert.equal(url.href, `https://baidu-com.${base}:8443/next.html?q=1#two`);
	assert.equal(
		resolveTarget(url, base).href,
		"https://baidu.com/next.html?q=1#two"
	);
});

test("cross-site, HTTP, custom-port and IPv6 navigation survives refresh", () => {
	for (const value of [
		"https://accounts.example.com/login?next=%2Fhome#continue",
		"http://example.com/plain?x=1#hash",
		"https://example.com:9443/test/",
		"http://[::1]:8080/test/",
		`https://baidu.com/?${TARGET_QUERY}=site-owned-value`,
		"https://baidu.com/sw.js",
		"https://baidu.com/assets/page.html",
	]) {
		const target = new URL(value);
		const url = shellUrl(target, entry, base);
		assert.equal(url.origin, entry.origin);
		assert.equal(resolveTarget(url, base).href, target.href);
		const newTab = proxyUrl(target, entry, base);
		assert.equal(resolveTarget(newTab, base).href, target.href);
	}
});

test("explicit targets reject executable protocols and URL credentials", () => {
	for (const value of [
		"javascript:alert(1)",
		"data:text/html,hello",
		"file:///tmp/a",
		"https://user:password@example.com/",
		"/relative",
	]) {
		const url = new URL(entry);
		url.searchParams.set(TARGET_QUERY, value);
		assert.throws(() => resolveTarget(url, base));
	}
});

test("flattened labels round-trip nested domains and literal hyphens", () => {
	for (const [hostname, label] of [
		["a.b.c.example.com", "a-b-c-example-com"],
		["my-site.example.com", "my--site-example-com"],
		["my--site.example.com", "my----site-example-com"],
		["www.xn--bcher-kva.example", "www-xn----bcher--kva-example"],
	]) {
		const target = new URL(`https://${hostname}/path?q=1#part`);
		const url = proxyUrl(target, entry, base);
		assert.equal(url.hostname, `${label}.${base}`);
		assert.equal(url.hostname.slice(0, -base.length - 1).includes("."), false);
		assert.equal(resolveTarget(url, base).href, target.href);
	}
});

test("oversized labels and Punycode-prefixed labels use the explicit target", () => {
	const boundary = new URL(`https://${"a".repeat(59)}.com/path`);
	const clean = proxyUrl(boundary, entry, base);
	assert.equal(clean.hostname.split(".")[0].length, 63);
	assert.equal(resolveTarget(clean, base).href, boundary.href);
	for (const hostname of [
		`${"a".repeat(60)}.com`,
		`${"a-".repeat(20)}a.example.com`,
		"xn--bcher-kva.example",
		"书.example",
	]) {
		const target = new URL(`https://${hostname}/path?q=1#part`);
		const url = proxyUrl(target, entry, base);
		assert.equal(url.origin, entry.origin);
		assert.equal(url.searchParams.get(TARGET_QUERY), target.href);
		assert.equal(resolveTarget(url, base).href, target.href);
	}
});

test("URL hosts outside DNS label syntax preserve explicit-target navigation", () => {
	for (const hostname of [
		"my_site.example",
		"-site.example",
		"site-.example",
		`${"a".repeat(64)}.example`,
	]) {
		for (const scheme of ["https://", "http://"]) {
			const target = new URL(`${scheme}${hostname}:9443/path?q=1#part`);
			const standardPort = new URL(`${scheme}${hostname}/path?q=1#part`);
			for (const url of [target, standardPort]) {
				for (const route of [proxyUrl, shellUrl]) {
					const result = route(url, entry, base);
					assert.equal(result.origin, entry.origin);
					assert.equal(result.searchParams.get(TARGET_QUERY), url.href);
					assert.equal(resolveTarget(result, base).href, url.href);
				}
			}
		}
	}
});
