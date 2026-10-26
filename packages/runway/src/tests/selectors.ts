import { htmlTest } from "../testcommon.ts";

export default [
	// React looks for the stylesheet it is about to insert with
	// link[rel="stylesheet"][href="<url>"]; when that finds nothing it inserts a
	// copy at the start of <head> and changes which CSS @layer wins.
	htmlTest({
		name: "selectors-match-the-url-the-page-set",
		html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="canonical" href="https://example.com/canonical">
</head>
<body>
<div id="box"><a id="link" href="https://example.com/page">page</a></div>
<script>
const link = document.getElementById("link");
const box = document.getElementById("box");

assert(
	document.querySelector('link[rel="canonical"][href="https://example.com/canonical"]'),
	"an exact href selector should find the link by the value in the page"
);
assert(
	document.querySelector('a[href^="https://example.com/"]') === link,
	"a prefix selector should compare against the value in the page"
);
assert(
	document.querySelectorAll('a[href$="/page"]').length === 1,
	"a suffix selector should compare against the value in the page"
);
assert(box.querySelector('[href="https://example.com/page"]') === link, "Element.querySelector");
assert(link.matches('a[href="https://example.com/page"]'), "Element.matches");
assert(link.closest('div') === box, "closest without attributes still works");
assert(
	link.closest('[href="https://example.com/page"]') === link,
	"Element.closest"
);
assert(!document.querySelector('a[href="https://example.com/other"]'), "a different href should not match");

const added = document.createElement("a");
added.setAttribute("href", "https://example.com/added");
box.append(added);
assert(
	document.querySelector('a[href="https://example.com/added"]') === added,
	"an element built by the page should match too"
);
added.href = "https://example.com/moved";
assert(
	!document.querySelector('a[href="https://example.com/added"]') &&
		document.querySelector('a[href="https://example.com/moved"]') === added,
	"the selector should follow a changed href"
);

const input = document.createElement("input");
input.type = "image";
input.src = "https://example.com/old.png";
input.src = "https://example.com/new.png";
box.append(input);
assert(
	input.matches('[src="https://example.com/new.png"]') &&
		!input.matches('[src="https://example.com/old.png"]'),
	"assigning input.src should keep the saved value in step"
);
pass();
</script>
</body>
</html>`,
	}),
];
