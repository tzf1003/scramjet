/** The file name a Content-Disposition header asks for, if it names one. */
export function dispositionFilename(
	disposition: string | null | undefined
): string | undefined {
	if (!disposition) return undefined;

	const extended = /filename\*\s*=\s*[^';]*'[^';]*'([^;]+)/i.exec(disposition);
	if (extended) {
		try {
			return decodeURIComponent(extended[1].trim());
		} catch {
			// fall through to the plain parameter
		}
	}

	const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(
		disposition
	);
	const name = (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim();
	return name || undefined;
}

/** The last path segment of a URL, decoded, for a download with no other name. */
export function pathFilename(pathname: string): string | undefined {
	const segments = pathname.split("/");
	let last = "";
	for (let i = segments.length - 1; i >= 0 && !last; i--) last = segments[i];
	if (!last) return undefined;
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}
