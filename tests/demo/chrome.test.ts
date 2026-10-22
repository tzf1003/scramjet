import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isTransparent,
	pickSurfaceColor,
	type SurfaceSample,
} from "../../packages/demo/src/chrome.ts";

const sample = (overrides: Partial<SurfaceSample>): SurfaceSample => ({
	colorScheme: "normal",
	themeColors: [],
	bodyBackground: "rgba(0, 0, 0, 0)",
	rootBackground: "rgba(0, 0, 0, 0)",
	...overrides,
});
const dark = (media: string) => media.includes("dark");

test("recognizes transparent computed colors", () => {
	assert.equal(isTransparent("rgba(0, 0, 0, 0)"), true);
	assert.equal(isTransparent("rgb(0 0 0 / 0)"), true);
	assert.equal(isTransparent("transparent"), true);
	assert.equal(isTransparent(""), true);
	assert.equal(isTransparent("rgb(22, 22, 22)"), false);
	assert.equal(isTransparent("rgba(22, 22, 22, 0.5)"), false);
	assert.equal(isTransparent("#161616"), false);
});

test("prefers the matching theme-color meta", () => {
	const color = pickSurfaceColor(
		sample({
			themeColors: [
				{ content: "#ffffff", media: "(prefers-color-scheme: light)" },
				{ content: "#161616", media: "(prefers-color-scheme: dark)" },
			],
			bodyBackground: "rgb(255, 255, 255)",
		}),
		dark
	);
	assert.equal(color, "#161616");
});

test("falls back from body to root background", () => {
	assert.equal(
		pickSurfaceColor(sample({ bodyBackground: "rgb(20, 20, 20)" }), dark),
		"rgb(20, 20, 20)"
	);
	assert.equal(
		pickSurfaceColor(sample({ rootBackground: "rgb(30, 30, 30)" }), dark),
		"rgb(30, 30, 30)"
	);
	assert.equal(pickSurfaceColor(sample({}), dark), null);
});
