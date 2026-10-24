import assert from "node:assert/strict";
import { test } from "node:test";
import { siteIconHref } from "../../packages/demo/src/site-icon.ts";
import { proxyUrl } from "../../packages/demo/src/routing.ts";

test("icon links point at the same-origin endpoint with the target hostname", () => {
	const target = new URL("https://www.example.com/a/b?c=d");
	assert.equal(
		siteIconHref(target, "icon"),
		"/__scramjet_icon?host=www.example.com"
	);
	assert.equal(
		siteIconHref(target, "apple"),
		"/__scramjet_icon?host=www.example.com&kind=apple"
	);
});

test("origins the gateway cannot fetch from get no icon instead of another service's", () => {
	for (const origin of ["https://example.com:8443/", "http://example.com/"])
		assert.equal(siteIconHref(new URL(origin), "icon"), "data:,");
	assert.equal(
		siteIconHref(new URL("https://example.com:443/"), "icon"),
		"/__scramjet_icon?host=example.com"
	);
});

test("targets cannot claim the icon endpoint path", () => {
	const entry = new URL("https://example-com.xs2api.com/");
	const url = proxyUrl(
		new URL("https://example.com/__scramjet_icon"),
		entry,
		"xs2api.com"
	);
	assert.equal(url.searchParams.has("__scramjet_url"), true);
});
