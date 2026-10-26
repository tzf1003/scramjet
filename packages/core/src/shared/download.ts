function decodeExtended(charset: string, value: string): string | undefined {
	try {
		if (!charset || /^utf-?8$/i.test(charset)) return decodeURIComponent(value);
		if (!/^(iso-8859-1|latin1)$/i.test(charset)) return undefined;
		// every percent escape is one character; the rest is taken as it is
		return value.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
			// eslint-disable-next-line scramjet-core/no-globals
			String.fromCharCode(parseInt(hex, 16))
		);
	} catch {
		return undefined;
	}
}

/** The file name a Content-Disposition header asks for, if it names one. */
export function dispositionFilename(
	disposition: string | null | undefined
): string | undefined {
	if (!disposition) return undefined;

	const extended = /filename\*\s*=\s*([^';]*)'[^';]*'([^;]+)/i.exec(
		disposition
	);
	if (extended) {
		const decoded = decodeExtended(extended[1].trim(), extended[2].trim());
		if (decoded) return decoded;
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
