import assert from "node:assert/strict";
import { test } from "node:test";
import { siteIconHref } from "../../packages/demo/src/site-icon.ts";
import { proxyUrl } from "../../packages/demo/src/routing.ts";

test("icon links point at the same-origin endpoint with the target hostname", () => {
	const target = new URL("https://www.example.com:8443/a/b?c=d");
	assert.equal(
		siteIconHref(target, "icon"),
		"/__scramjet_icon?host=www.example.com"
	);
	assert.equal(
		siteIconHref(target, "apple"),
		"/__scramjet_icon?host=www.example.com&kind=apple"
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
