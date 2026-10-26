import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteSelector } from "../../packages/core/src/shared/selector.ts";

const pair = (name: string, test: string) =>
	`:is([scramjet-attr-${name}${test}],:not([scramjet-attr-${name}])[${name}${test}])`;

test("an href lookup also matches the value the page set", () => {
	// how React finds an existing stylesheet before it inserts a new one
	assert.equal(
		rewriteSelector('link[rel="stylesheet"][href="https://a.test/x.css"]'),
		'link[rel="stylesheet"]' + pair("href", '="https://a.test/x.css"')
	);
	assert.equal(
		rewriteSelector("script[src='/app.js']"),
		"script" + pair("src", "='/app.js'")
	);
});

test("operators, flags and unquoted values are kept", () => {
	assert.equal(rewriteSelector("a[href^=http]"), "a" + pair("href", "^=http"));
	assert.equal(
		rewriteSelector('a[ HREF $= ".pdf" i ]'),
		"a" + pair("href", '$=".pdf" i')
	);
	assert.equal(
		rewriteSelector('img[srcset*="2x"], form[action="/go"]'),
		"img" + pair("srcset", '*="2x"') + ", form" + pair("action", '="/go"')
	);
});

test("other selectors are returned untouched", () => {
	for (const selector of [
		"a",
		"a[href]",
		"a:not([href])",
		'link[rel="stylesheet"]',
		'[data-href="/x"]',
		'[title="x"]',
		"",
	])
		assert.equal(rewriteSelector(selector), selector);
});

test("brackets inside a quoted value are not rewritten", () => {
	const selector = '[title="a[href=b]"]';
	assert.equal(rewriteSelector(selector), selector);
	assert.equal(
		rewriteSelector('[title="]"] a[href="/x"]'),
		'[title="]"] a' + pair("href", '="/x"')
	);
});
