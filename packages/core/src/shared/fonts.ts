import {
	parse,
	generate as generateNative,
	walk,
	lexer,
	ident,
	type CssNode,
	type Value,
} from "css-tree";
import { JSON_stringify } from "./snapshot";

export const emojiFamily = "Scramjet Twemoji 14";
export const missingFamily = "Scramjet Unavailable Font";

/** Keep decoded CSS strings/URLs safe when embedded in an HTML style element. */
function generate(node: CssNode): string {
	return generateNative(node, {
		decorator(handlers) {
			const emit = handlers.node;
			handlers.node = function (node) {
				if (node.type === "String" || node.type === "Url")
					node = {
						type: "Raw",
						value: generateNative(node).replace(/</g, "\\3c "),
					};
				emit.call(this, node);
			};
			return handlers;
		},
	});
}

/** Includes localized, PostScript and common vendor aliases. */
export function isRestrictedFont(name: string): boolean {
	const key = name.toLowerCase().replace(/[\s_-]/g, "");
	return (
		/^(pingfang|hiraginosansgb|stheiti|stsong|stkaiti|stfangsong|stxihei|stzhongsong|stxinwei|stliti|sthupo|stsiti|microsoftyahei|microsoftjhenghei|simsun|nsimsun|simhei|fangsong|kaiti|dengxian|notosanscjk[st]c|notoserifcjk[st]c|sourcehansans[sc]|sourcehanserif[sc]|harmonyos|honorsans|misans|miui|opposans|vivo|droidsansfallback|heiti[st]c|songti[st]c|kaiti[st]c|baoli[st]c|lantinghei|libiansc|xingkaisc|yuantisc|yuppy[st]c|weibei[st]c|fz|hanyi)/.test(
			key
		) ||
		/^(微软雅黑|微軟雅黑|微软正黑|微軟正黑|苹方|蘋方|黑体|黑體|宋体|宋體|新宋体|新細明體|細明體|标楷体|標楷體|楷体|楷體|仿宋|华文|華文|等线|等線|思源|方正|汉仪|漢儀|鸿蒙|鴻蒙)/.test(
			key
		)
	);
}

function familyName(nodes: CssNode[]): string | undefined {
	if (nodes.length === 1 && nodes[0].type === "String") return nodes[0].value;
	if (nodes.every((node) => node.type === "Identifier"))
		return nodes.map((node) => ident.decode((node as any).name)).join(" ");
}

/** Preserve the caller's fallback order after the fixed emoji face. */
export function rewriteFontValue(
	value: string,
	property = "font-family",
	emoji = true
): string {
	if (!value.trim()) return value;
	try {
		const ast = parse(value, { context: "value" }) as Value;
		const nodes = ast.children.toArray();
		let start = 0;
		if (property === "font") {
			const match = lexer.matchProperty("font", ast) as ReturnType<
				typeof lexer.matchProperty
			> & {
				getTrace(node: CssNode): { type: string; name: string }[] | null;
			};
			if (match.error) return value;
			start = nodes.findIndex((node) =>
				match
					.getTrace(node)
					?.some(
						(entry) =>
							entry.type === "Property" && entry.name === "font-family"
					)
			);
			if (start < 0) return value; // System-font and global keywords.
		} else if (
			/^(inherit|initial|unset|revert|revert-layer)$/i.test(value.trim())
		)
			return value;
		const groups: CssNode[][] = [[]];
		for (const node of nodes.slice(start)) {
			if (node.type === "Operator" && node.value === ",") groups.push([]);
			else groups[groups.length - 1].push(node);
		}
		const families = groups.map((group) => {
			const name = familyName(group);
			return name && isRestrictedFont(name)
				? JSON_stringify(missingFamily)
				: group.map((node) => generate(node)).join(" ");
		});
		if (emoji && familyName(groups[0]) !== emojiFamily)
			families.unshift(JSON_stringify(emojiFamily));
		return (
			(start
				? nodes
						.slice(0, start)
						.map((node) => generate(node))
						.join(" ") + " "
				: "") + families.join(", ")
		);
	} catch {
		return value; // Let the browser reject unsupported syntax.
	}
}

export function rewriteFontSource(source: string): string {
	try {
		const ast = parse(source, { context: "value" });
		walk(ast, (node) => {
			if (
				node.type === "Function" &&
				ident.decode(node.name).toLowerCase() === "local"
			)
				node.children = (
					parse(JSON_stringify(missingFamily), { context: "value" }) as Value
				).children;
		});
		return generate(ast);
	} catch {
		return source;
	}
}

/** Parse declarations so selectors, content strings and URLs remain intact. */
export function rewriteFontCss(css: string): string {
	try {
		let ast: CssNode;
		try {
			ast = parse(css, {
				onParseError(error) {
					throw error;
				},
			});
		} catch {
			ast = parse(css, { context: "declarationList" });
		}
		let changed = false;
		walk(ast, {
			visit: "Declaration",
			enter(node) {
				const property = ident.decode(node.property).toLowerCase();
				const face = this.atrule?.name.toLowerCase() === "font-face";
				const value = generate(node.value);
				if (property === "src" && face) {
					node.value = parse(rewriteFontSource(value), {
						context: "value",
					}) as Value;
					changed = true;
				} else if (
					(property === "font" || property === "font-family") &&
					!face
				) {
					node.value = parse(rewriteFontValue(value, property), {
						context: "value",
					}) as Value;
					changed = true;
				}
			},
		});
		return changed ? generate(ast) : css;
	} catch {
		return css;
	}
}
