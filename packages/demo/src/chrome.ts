// Mobile browsers tint their toolbars from the shell document, not the iframe.
// Mirror the proxied page's surface color onto the shell so they match.

export type SurfaceSample = {
	colorScheme: string;
	themeColors: { content: string; media: string }[];
	bodyBackground: string;
	rootBackground: string;
};

// An iframe's initial about:blank document is not the proxied page.
export function isBlankDocument(doc: Document): boolean {
	return doc.URL === "about:blank";
}

export function isTransparent(color: string): boolean {
	const value = color.trim().toLowerCase();
	if (!value || value === "transparent") return true;
	const alpha = /^rgba?\((?:[^,/)]+[,\s]+){3}(?:\/\s*)?([\d.]+)(%?)\s*\)$/.exec(
		value
	);
	if (!alpha) return false;
	return parseFloat(alpha[1]) === 0;
}

// theme-color comes from the proxied page and ends up in the shell's CSS, so
// it must be a plain color: url() or var() would make the shell itself fetch
// a page-chosen address, bypassing the proxy. Allow only a known shape rather
// than deny known-bad functions, since CSS escapes (\75rl(...)) defeat a
// denylist: no backslashes, no nested parentheses, color function names only.
const COLOR_SYNTAX =
	/^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([\w\s.,%/#+-]*\))$/i;

export function isSafeColorSyntax(value: string): boolean {
	return COLOR_SYNTAX.test(value.trim());
}

export function isPlainColor(value: string): boolean {
	return (
		isSafeColorSyntax(value) &&
		typeof CSS !== "undefined" &&
		CSS.supports("color", value)
	);
}

export function pickSurfaceColor(
	sample: SurfaceSample,
	matches: (media: string) => boolean,
	isColor: (value: string) => boolean = isPlainColor
): string | null {
	for (const { content, media } of sample.themeColors) {
		if (!content.trim() || isTransparent(content) || !isColor(content.trim()))
			continue;
		if (media && !matches(media)) continue;
		return content.trim();
	}
	for (const color of [sample.bodyBackground, sample.rootBackground]) {
		if (!isTransparent(color)) return color;
	}
	return null;
}

function applySurface(color: string | null, colorScheme: string) {
	const root = document.documentElement;
	// Matching color-scheme keeps the iframe transparent over the shell, and
	// lets a page without a background resolve Canvas exactly as it would.
	root.style.colorScheme = colorScheme === "normal" ? "light" : colorScheme;
	root.style.setProperty("--shell-surface", color ?? "Canvas");
	const resolved = getComputedStyle(root).backgroundColor;
	let meta = document.querySelector<HTMLMetaElement>(
		'meta[name="theme-color"]'
	);
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
	}
	if (meta.content !== resolved) meta.content = resolved;
}

function sampleDocument(doc: Document): SurfaceSample {
	// Use the shell's getComputedStyle: the proxied window's copy may be hooked.
	const background = (element: Element | null) =>
		element ? getComputedStyle(element).backgroundColor : "";
	return {
		colorScheme: getComputedStyle(doc.documentElement).colorScheme,
		themeColors: Array.from(
			doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color" i]'),
			(meta) => ({
				content: meta.getAttribute("content") ?? "",
				media: meta.getAttribute("media") ?? "",
			})
		),
		bodyBackground: background(doc.body),
		rootBackground: background(doc.documentElement),
	};
}

export function syncShellSurface(iframe: HTMLIFrameElement) {
	let observer: MutationObserver | undefined;
	let observed: [Document, Element | null, Element | null] | undefined;
	let scheduled = false;

	const sync = () => {
		scheduled = false;
		let doc: Document | null = null;
		try {
			doc = iframe.contentDocument;
		} catch {
			// A document can be temporarily inaccessible while it navigates.
		}
		if (!doc?.documentElement || isBlankDocument(doc)) return;
		if (
			!observed ||
			observed[0] !== doc ||
			observed[1] !== doc.head ||
			observed[2] !== doc.body
		)
			watch(doc);
		const sample = sampleDocument(doc);
		applySurface(
			pickSurfaceColor(sample, (media) => matchMedia(media).matches),
			sample.colorScheme
		);
	};
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(sync);
	};
	const watch = (doc: Document) => {
		observer?.disconnect();
		observed = [doc, doc.head, doc.body];
		observer = new MutationObserver(schedule);
		// Theme switches usually toggle a class or style on <html>/<body>, or
		// swap the theme-color meta; deeper subtrees are not worth the cost.
		observer.observe(doc.documentElement, {
			attributes: true,
			childList: true,
		});
		if (doc.head)
			observer.observe(doc.head, {
				attributes: true,
				childList: true,
				subtree: true,
			});
		if (doc.body) observer.observe(doc.body, { attributes: true });
		doc.addEventListener("DOMContentLoaded", schedule, { once: true });
	};

	iframe.addEventListener("load", schedule);
	matchMedia("(prefers-color-scheme: dark)").addEventListener(
		"change",
		schedule
	);
	return schedule;
}
