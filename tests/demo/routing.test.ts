import assert from "node:assert/strict";
import { test } from "node:test";
import {
	normalizeProxyDomain,
	resolveTarget,
	proxyUrl,
	shellUrl,
	TARGET_QUERY,
} from "../../packages/demo/src/routing.ts";

const base = "derp.xs2api.com";
const entry = new URL(`https://baidu.com.${base}:8443/test/?q=a%2Fb#section`);

test("wildcard entry preserves path, query and hash, independently of proxy port", () => {
	assert.equal(
		resolveTarget(entry, base).href,
		"https://baidu.com/test/?q=a%2Fb#section"
	);
	assert.equal(
		resolveTarget(new URL(`https://www.baidu.com.${base}/a.html`), base).href,
		"https://www.baidu.com/a.html"
	);
	assert.equal(
		resolveTarget(
			new URL(`https://baidu.com.${base}//another.example/path`),
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
	assert.equal(normalizeProxyDomain("DERP.XS2API.COM."), base);
});

test("new-tab links map to wildcard hosts with the proxy scheme and port", () => {
	const url = proxyUrl(new URL("https://www.example.com/a?b=c#d"), entry, base);
	assert.equal(url.href, `https://www.example.com.${base}:8443/a?b=c#d`);
	assert.equal(
		resolveTarget(url, base).href,
		"https://www.example.com/a?b=c#d"
	);
});

test("same-origin navigation keeps clean public paths", () => {
	const url = shellUrl(
		new URL("https://baidu.com/next.html?q=1#two"),
		entry,
		base
	);
	assert.equal(url.href, `https://baidu.com.${base}:8443/next.html?q=1#two`);
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
