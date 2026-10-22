import type { ScramjetClient } from "@client/index";
import { emojiFamily, rewriteFontValue } from "@/shared/fonts";
import emojiData from "../../../assets/fonts/Twemoji.Mozilla.ttf";

export const order = 1;

/** Each instrumented document/worker receives the same synchronous font bytes. */
export default function (client: ScramjetClient, self: any) {
	if (!client.config.environment?.protectFonts) return;
	const fontSet = self.document?.fonts ?? self.fonts;
	if (self.FontFace && fontSet) {
		const binary = self.atob(emojiData.slice(emojiData.indexOf(",") + 1));
		const bytes = new self.Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		// Buffer sources parse immediately; there is no network font-loading race.
		const face = new self.FontFace(emojiFamily, bytes, {
			// Keep ordinary digits/punctuation in the site's text font.
			unicodeRange:
				"U+200D,U+20E3,U+2300-23FF,U+2600-27BF,U+2B00-2BFF,U+FE0F,U+1F000-1FAFF,U+E0020-E007F",
		});
		fontSet.add(face);
		face.loaded.catch((error: unknown) =>
			dbg.warn("Fixed emoji font could not be loaded", error)
		);
	}
	client.Proxy("queryLocalFonts", {
		apply(ctx) {
			ctx.return(self.Promise.resolve([]));
		},
	});
	for (const method of ["check", "load"]) {
		client.Proxy(`FontFaceSet.prototype.${method}`, {
			apply(ctx: any) {
				if (typeof ctx.args[0] === "string")
					ctx.args[0] = rewriteFontValue(ctx.args[0], "font");
			},
		});
	}
	for (const property of ["font", "fontFamily"]) {
		client.Trap(`CSSStyleDeclaration.prototype.${property}`, {
			set(ctx, value) {
				ctx.set(
					typeof value === "string"
						? rewriteFontValue(
								value,
								property === "font" ? "font" : "font-family"
							)
						: value
				);
			},
		});
	}
	for (const prefix of [
		"CanvasRenderingContext2D",
		"OffscreenCanvasRenderingContext2D",
	]) {
		const prototype = self[prefix]?.prototype;
		if (!prototype) continue;
		const descriptor = self.Object.getOwnPropertyDescriptor(
			prototype,
			"font"
		);
		if (!descriptor?.set || !descriptor.get) continue;
		client.Trap(`${prefix}.prototype.font`, {
			set(ctx, value) {
				ctx.set(
					typeof value === "string" ? rewriteFontValue(value, "font") : value
				);
			},
		});
		// Also covers default context fonts, reset(), resize and restored state.
		for (const method of ["measureText", "fillText", "strokeText"]) {
			client.Proxy(`${prefix}.prototype.${method}`, {
				apply(ctx) {
					const font = self.Reflect.apply(descriptor.get, ctx.this, []);
					self.Reflect.apply(descriptor.set, ctx.this, [
						rewriteFontValue(font, "font"),
					]);
				},
			});
		}
	}
	if (self.document) {
		const sheet = new self.CSSStyleSheet();
		sheet.replaceSync(
			`html { font-family: "${emojiFamily}", serif; } button,input,select,textarea { font-family: "${emojiFamily}", sans-serif; }`
		);
		self.document.adoptedStyleSheets = [
			...self.document.adoptedStyleSheets,
			sheet,
		];
	}
}
