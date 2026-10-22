import { rewriteCss } from "@rewriters/css";
import { ScramjetClient } from "@client/index";
import { rewriteFontSource } from "@/shared/fonts";

export default function (client: ScramjetClient, _self: Self) {
	client.Proxy("FontFace", {
		construct(ctx) {
			if (typeof ctx.args[1] !== "string") return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
			if (client.config.environment?.protectFonts)
				ctx.args[1] = rewriteFontSource(ctx.args[1]);
		},
	});
}
