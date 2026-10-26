/**
 * Whether a top-level response is a page that runs scripts and therefore has to
 * be shown inside the proxy shell. Anything else (a file, an image, plain text,
 * an `attachment`) can be handed to the browser as it is.
 */
export function needsShell(
	status: number,
	headers: { get(name: string): string | null }
): boolean {
	// A redirect is followed by the browser and arrives here as its own request.
	if (status >= 300 && status < 400) return false;
	const disposition = headers.get("content-disposition");
	if (disposition && /^\s*attachment\b/i.test(disposition)) return false;
	const essence = (headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return (
		essence === "text/html" ||
		essence === "text/xml" ||
		essence === "application/xml" ||
		essence.endsWith("+xml")
	);
}
