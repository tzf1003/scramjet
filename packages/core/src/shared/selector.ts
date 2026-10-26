// The rewriter points href, src and similar attributes at the proxy and keeps the
// page's own value in scramjet-attr-<name>. Pages that look elements up by
// attribute (React finds the stylesheet it would otherwise insert with
// link[rel="stylesheet"][href="https://..."]) compare against that value.
// A quoted string is matched first so that brackets inside it are left alone.
// The attribute names are the ones the rewriter points at the proxy.
const attributeSelector =
	/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\[\s*(href|src|srcset|imagesrcset|action|formaction|poster|data)\s*([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]"']+)(\s+[iIsS])?\s*\]/gi;

/**
 * Makes attribute selectors on rewritten URL attributes compare against the
 * value the page set. An element that was never rewritten is still matched on
 * its own attribute.
 */
export function rewriteSelector(selector: string): string {
	if (!selector.includes("[")) return selector;

	return selector.replace(
		attributeSelector,
		(
			match,
			_string,
			name?: string,
			operator?: string,
			value?: string,
			flag = ""
		) => {
			if (!name) return match;
			name = name.toLowerCase();
			const test = `${operator}${value}${flag}`;

			return `:is([scramjet-attr-${name}${test}],:not([scramjet-attr-${name}])[${name}${test}])`;
		}
	);
}
