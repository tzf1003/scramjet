import assert from "node:assert/strict";
import { test } from "node:test";
import { needsShell } from "../../packages/utils/src/shell-document.ts";

const headers = (init: Record<string, string>) => ({
	get: (name: string) => init[name.toLowerCase()] ?? null,
});

test("pages that run scripts are shown inside the shell", () => {
	for (const type of [
		"text/html",
		"text/html; charset=utf-8",
		"TEXT/HTML",
		"application/xhtml+xml",
		"image/svg+xml",
		"text/xml",
	]) {
		assert.equal(
			needsShell(200, headers({ "content-type": type })),
			true,
			type
		);
	}
	assert.equal(needsShell(404, headers({ "content-type": "text/html" })), true);
});

test("a download is passed through instead of being replaced by the shell", () => {
	for (const type of [
		"text/markdown; charset=utf-8",
		"text/plain",
		"application/octet-stream",
		"application/zip",
		"application/pdf",
		"image/png",
		"application/json",
	]) {
		assert.equal(
			needsShell(200, headers({ "content-type": type })),
			false,
			type
		);
	}
	assert.equal(needsShell(200, headers({})), false);
});

test("an attachment is never shown in the shell, even when it is HTML", () => {
	for (const disposition of [
		"attachment",
		'attachment; filename="发布文案.md"',
		"ATTACHMENT; filename*=UTF-8''%E6%96%87.html",
	]) {
		assert.equal(
			needsShell(
				200,
				headers({
					"content-type": "text/html",
					"content-disposition": disposition,
				})
			),
			false,
			disposition
		);
	}
	assert.equal(
		needsShell(
			200,
			headers({ "content-type": "text/html", "content-disposition": "inline" })
		),
		true
	);
});

test("a redirect is left for the browser to follow", () => {
	assert.equal(
		needsShell(302, headers({ "content-type": "text/html" })),
		false
	);
});
