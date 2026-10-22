// Mobile browsers tint their toolbars from the shell document, not the iframe.
// Mirror the proxied page's surface color onto the shell so they match.

export type SurfaceSample = {
	colorScheme: string;
	themeColors: { content: string; media: string }[];
	bodyBackground: string;
	rootBackground: string;
};

export function isTransparent(color: string): boolean {
	const value = color.trim().toLowerCase();
	if (!value || value === "transparent") return true;
	const alpha = /^rgba?\((?:[^,/)]+[,\s]+){3}(?:\/\s*)?([\d.]+)(%?)\s*\)$/.exec(
		value
	);
	if (!alpha) return false;
	return parseFloat(alpha[1]) === 0;
}

export function pickSurfaceColor(
	sample: SurfaceSample,
	matches: (media: string) => boolean
): string | null {
	for (const { content, media } of sample.themeColors) {
		if (!content.trim() || isTransparent(content)) continue;
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
		if (!doc?.documentElement) return;
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
