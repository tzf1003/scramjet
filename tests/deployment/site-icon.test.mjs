import test from "node:test";
import assert from "node:assert/strict";
import {
	declaredIcons,
	expandLabel,
	iconTarget,
	validTarget,
} from "../../deployment/site-icon.mjs";

const options = {
	proxyDomain: "xs2api.com",
	reserved: ["xs2api.com", "my.xs2api.com", "assets.xs2api.com"],
};
const icon = (path, host) =>
	iconTarget(new URL(path, "https://x"), host, options);

test("flattened labels expand to hostnames and reject ports and malformed labels", () => {
	assert.equal(expandLabel("www-example-com"), "www.example.com");
	assert.equal(expandLabel("my--site-example-com"), "my-site.example.com");
	for (const label of [
		"example-com-8443",
		"localhost",
		"a.b",
		"-example-com",
		"example--",
	])
		assert.equal(expandLabel(label), null, label);
});

test("targets must be public-looking DNS names outside the proxy domain", () => {
	assert.equal(validTarget("example.com", "xs2api.com"), true);
	for (const host of [
		"localhost",
		"a.localhost",
		"127.0.0.1",
		"10.0.0.1",
		"xs2api.com",
		"a.xs2api.com",
		"x_y.com",
		"single",
	])
		assert.equal(validTarget(host, "xs2api.com"), false, host);
});

test("icon paths resolve the target from the host label, never the gateway hosts", () => {
	assert.equal(icon("/favicon.ico", "baidu-com.xs2api.com"), "baidu.com");
	assert.equal(
		icon("/apple-touch-icon.png", "www-baidu-com.xs2api.com"),
		"www.baidu.com"
	);
	assert.equal(icon("/favicon.ico", "my.xs2api.com"), null);
	assert.equal(icon("/favicon.ico", "assets.xs2api.com"), null);
	assert.equal(icon("/favicon.ico", "xs2api.com"), null);
	assert.equal(icon("/favicon.ico", "example.com"), null);
	assert.equal(icon("/other.png", "baidu-com.xs2api.com"), null);
});

test("the shell icon endpoint takes an explicit host and validates it", () => {
	assert.equal(
		icon("/__scramjet_icon?host=Example.com", "go.xs2api.com"),
		"example.com"
	);
	for (const host of [
		"",
		"localhost",
		"127.0.0.1",
		"a.xs2api.com",
		"x.com:8080",
		"u@x.com",
	])
		assert.equal(
			icon(
				"/__scramjet_icon?host=" + encodeURIComponent(host),
				"my.xs2api.com"
			),
			null,
			host
		);
});

test("declared icons are filtered by kind, resolved against the page and ranked by size", () => {
	const html = `<head>
		<link rel="shortcut icon" href="/small.ico" sizes="16x16">
		<link rel=icon href=//cdn.example.com/big.png sizes="64x64">
		<link rel="icon" href="http://insecure.example.com/x.png">
		<link rel="apple-touch-icon" href="touch.png" sizes="180x180">
		<link rel="stylesheet" href="/a.css">
	</head>`;
	assert.deepEqual(declaredIcons(html, "https://example.com/dir/", false), [
		"https://cdn.example.com/big.png",
		"https://example.com/small.ico",
	]);
	assert.deepEqual(declaredIcons(html, "https://example.com/dir/", true), [
		"https://example.com/dir/touch.png",
	]);
	assert.deepEqual(
		declaredIcons("<p>none</p>", "https://example.com/", false),
		[]
	);
});
