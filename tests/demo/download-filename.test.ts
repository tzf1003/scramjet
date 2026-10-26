import assert from "node:assert/strict";
import { test } from "node:test";
import {
	dispositionFilename,
	pathFilename,
} from "../../packages/core/src/shared/download.ts";

test("a quoted or bare filename parameter is the name", () => {
	assert.equal(
		dispositionFilename('attachment; filename="report 1.pdf"'),
		"report 1.pdf"
	);
	assert.equal(dispositionFilename("attachment; filename=a.zip"), "a.zip");
	assert.equal(dispositionFilename('inline; FILENAME="x.md"; size=3'), "x.md");
	assert.equal(
		dispositionFilename('attachment; filename="say \\"hi\\".txt"'),
		'say "hi".txt'
	);
});

test("an extended filename wins and is decoded", () => {
	assert.equal(
		dispositionFilename(
			"attachment; filename=\"fallback.md\"; filename*=UTF-8''%E5%8F%91%E5%B8%83%E6%96%87%E6%A1%88.md"
		),
		"发布文案.md"
	);
});

test("a header without a name gives none", () => {
	assert.equal(dispositionFilename(null), undefined);
	assert.equal(dispositionFilename(""), undefined);
	assert.equal(dispositionFilename("attachment"), undefined);
});

test("the path supplies a name when nothing else does", () => {
	assert.equal(pathFilename("/files/report%201.pdf"), "report 1.pdf");
	assert.equal(pathFilename("/files/"), "files");
	assert.equal(pathFilename("/"), undefined);
	assert.equal(pathFilename("/bad%E0%A4%A"), "bad%E0%A4%A");
});
