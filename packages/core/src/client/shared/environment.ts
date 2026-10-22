import type { ScramjetClient } from "@client/index";
import { normalizeEnvironment } from "@/shared/environment";

/** Install each profile in the destination realm before its scripts execute. */
export default function (client: ScramjetClient, self: any) {
	const config = normalizeEnvironment(client.config.environment);
	if (!config.locale && !config.timezone) return;
	const {
		Object,
		Reflect,
		Array,
		Number,
		Math,
		String,
		Date: NativeDate,
	} = self;
	const NativeDateTimeFormat = self.Intl.DateTimeFormat;
	const getTime = NativeDate.prototype.getTime;
	const setTime = NativeDate.prototype.setTime;
	const utc = NativeDate.UTC;
	const parse = NativeDate.parse;
	const nativeDateMethods = Object.getOwnPropertyDescriptors(
		NativeDate.prototype
	);
	const callDate = (name: string, date: Date, args: any[] = []) =>
		Reflect.apply(nativeDateMethods[name].value, date, args);
	const languages =
		config.languages && Object.freeze(Array.from(config.languages));

	if (languages) {
		for (const prefix of ["Navigator", "WorkerNavigator"]) {
			for (const property of [
				"language",
				"languages",
				"userLanguage",
				"browserLanguage",
				"systemLanguage",
			]) {
				client.Trap(`${prefix}.prototype.${property}`, {
					get(ctx) {
						ctx.get(); // Preserve the native receiver check.
						return property === "languages" ? languages : config.locale;
					},
				});
			}
		}
	}

	const defaults = (args: any[], timezone = false) => {
		if (
			config.locale &&
			(args[0] === undefined ||
				(Array.isArray(args[0]) && args[0].length === 0))
		)
			args[0] = config.locale;
		if (timezone && config.timezone && args[1] !== null) {
			// Inherited/non-enumerable options are valid ECMA-402 options too.
			const options = args[1] === undefined ? {} : Object(args[1]);
			if (options.timeZone === undefined) {
				args[1] = Object.create(options, {
					timeZone: { value: config.timezone },
				});
			}
		}
	};
	for (const name of [
		"DateTimeFormat",
		"NumberFormat",
		"RelativeTimeFormat",
		"Collator",
		"ListFormat",
		"PluralRules",
		"DisplayNames",
		"Segmenter",
	]) {
		if (!self.Intl[name]) continue;
		const update = (ctx: any) =>
			defaults(ctx.args, name === "DateTimeFormat");
		client.Proxy(`Intl.${name}`, { construct: update, apply: update });
		Object.defineProperty(self.Intl[name].prototype, "constructor", {
			...Object.getOwnPropertyDescriptor(
				self.Intl[name].prototype,
				"constructor"
			),
			value: self.Intl[name],
		});
	}

	for (const name of [
		"toLocaleString",
		"toLocaleDateString",
		"toLocaleTimeString",
	]) {
		client.Proxy(`Date.prototype.${name}`, {
			apply(ctx) {
				const time = Reflect.apply(getTime, ctx.this, []);
				if (!Number.isFinite(time)) return ctx.return("Invalid Date");
				defaults(ctx.args, true);
				ctx.return(
					Reflect.apply(nativeDateMethods[name].value, ctx.this, ctx.args)
				);
			},
		});
	}
	if (config.locale) {
		for (const name of [
			"Number.prototype.toLocaleString",
			"BigInt.prototype.toLocaleString",
			"String.prototype.localeCompare",
			"String.prototype.toLocaleLowerCase",
			"String.prototype.toLocaleUpperCase",
		]) {
			client.Proxy(name, {
				apply(ctx) {
					const index = name.endsWith("localeCompare") ? 1 : 0;
					const args = ctx.args.slice(index);
					defaults(args);
					ctx.args.splice(index, ctx.args.length - index, ...args);
				},
			});
		}
	}
	const timezone =
		config.timezone ?? new NativeDateTimeFormat().resolvedOptions().timeZone;
	if (config.timezone && self.Temporal?.Now) {
		client.Proxy("Temporal.Now.timeZoneId", {
			apply(ctx) {
				ctx.return(config.timezone);
			},
		});
		for (const name of [
			"zonedDateTimeISO",
			"plainDateTimeISO",
			"plainDateISO",
			"plainTimeISO",
		]) {
			client.Proxy(`Temporal.Now.${name}`, {
				apply(ctx) {
					if (ctx.args[0] === undefined) ctx.args[0] = config.timezone;
				},
			});
		}
	}

	const partsFormatter = new NativeDateTimeFormat(
		"en-US-u-ca-gregory-nu-latn",
		{
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			era: "short",
			hourCycle: "h23",
		}
	);
	const zoneFormatter = new NativeDateTimeFormat(config.locale, {
		timeZone: timezone,
		timeZoneName: "long",
	});
	const formatParts = NativeDateTimeFormat.prototype.formatToParts;
	const wallTime = (time: number): number => {
		if (!Number.isFinite(time)) return NaN;
		const parts: Record<string, string> = {};
		for (const part of Reflect.apply(formatParts, partsFormatter, [time]))
			parts[part.type] = part.value;
		const date = new NativeDate(0);
		const year =
			parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year);
		callDate("setUTCFullYear", date, [
			year,
			Number(parts.month) - 1,
			Number(parts.day),
		]);
		callDate("setUTCHours", date, [
			Number(parts.hour),
			Number(parts.minute),
			Number(parts.second),
			((time % 1000) + 1000) % 1000,
		]);
		return Reflect.apply(getTime, date, []);
	};
	const offset = (time: number) => wallTime(time) - time;
	const fromWallTime = (wall: number): number => {
		if (!Number.isFinite(wall)) return NaN;
		// Sample both sides of transitions. Repeats choose the earlier instant;
		// gaps advance by the transition, matching Date's compatible behavior.
		const offsets = [
			offset(wall - 86400000),
			offset(wall),
			offset(wall + 86400000),
		];
		const candidates = offsets.map((value: number) => wall - value);
		const exact = candidates.filter(
			(time: number) => wallTime(time) === wall
		);
		return exact.length ? Math.min(...exact) : Math.max(...candidates);
	};

	for (const suffix of [
		"FullYear",
		"Month",
		"Date",
		"Day",
		"Hours",
		"Minutes",
		"Seconds",
		"Milliseconds",
	]) {
		client.Proxy(`Date.prototype.get${suffix}`, {
			apply(ctx) {
				const time = Reflect.apply(getTime, ctx.this, []);
				ctx.return(
					callDate(`getUTC${suffix}`, new NativeDate(wallTime(time)))
				);
			},
		});
	}
	client.Proxy("Date.prototype.getYear", {
		apply(ctx) {
			ctx.return(
				callDate(
					"getUTCFullYear",
					new NativeDate(wallTime(Reflect.apply(getTime, ctx.this, [])))
				) - 1900
			);
		},
	});
	client.Proxy("Date.prototype.getTimezoneOffset", {
		apply(ctx) {
			// Historical offsets may include seconds; Date returns whole minutes.
			const minutes = -Math.trunc(
				offset(Reflect.apply(getTime, ctx.this, [])) / 60000
			);
			ctx.return(minutes === 0 ? 0 : minutes);
		},
	});
	for (const suffix of [
		"FullYear",
		"Month",
		"Date",
		"Hours",
		"Minutes",
		"Seconds",
		"Milliseconds",
		"Year",
	]) {
		client.Proxy(`Date.prototype.set${suffix}`, {
			apply(ctx) {
				let time = Reflect.apply(getTime, ctx.this, []);
				const args: any[] = Array.from(ctx.args);
				if (suffix === "Year") {
					let year = +args[0];
					if (
						Number.isFinite(year) &&
						Math.trunc(year) >= 0 &&
						Math.trunc(year) <= 99
					)
						year = Math.trunc(year) + 1900;
					args[0] = year;
				}
				if (
					!Number.isFinite(time) &&
					(suffix === "FullYear" || suffix === "Year")
				)
					time = 0;
				const local = new NativeDate(
					Number.isNaN(Reflect.apply(getTime, ctx.this, [])) && time === 0
						? 0
						: wallTime(time)
				);
				const wall = callDate(
					`setUTC${suffix === "Year" ? "FullYear" : suffix}`,
					local,
					args
				);
				ctx.return(Reflect.apply(setTime, ctx.this, [fromWallTime(wall)]));
			},
		});
	}

	const pad = (value: number, length = 2) =>
		String(value).padStart(length, "0");
	const dateString = (date: Date, kind: string) => {
		const time = Reflect.apply(getTime, date, []);
		if (!Number.isFinite(time)) return "Invalid Date";
		const local = new NativeDate(wallTime(time));
		const get = (suffix: string) => callDate(`getUTC${suffix}`, local);
		const year = get("FullYear");
		const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][get("Day")];
		const month = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		][get("Month")];
		const datePart = `${day} ${month} ${pad(get("Date"))} ${year < 0 ? "-" : ""}${pad(Math.abs(year), 4)}`;
		if (kind === "toDateString") return datePart;
		const minutes = Math.trunc(offset(time) / 60000);
		const zone = Reflect.apply(formatParts, zoneFormatter, [time]).find(
			(part: Intl.DateTimeFormatPart) => part.type === "timeZoneName"
		)!.value;
		const timePart = `${pad(get("Hours"))}:${pad(get("Minutes"))}:${pad(get("Seconds"))} GMT${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)} (${zone})`;
		return kind === "toTimeString" ? timePart : `${datePart} ${timePart}`;
	};
	for (const name of ["toString", "toDateString", "toTimeString"]) {
		client.Proxy(`Date.prototype.${name}`, {
			apply(ctx) {
				ctx.return(dateString(ctx.this, name));
			},
		});
	}

	const parseDate = (text: string) => {
		// ISO date-only forms are UTC; ISO date-times without offsets are local.
		if (
			/^(?:[+-]\d{6}|\d{4})-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(
				text
			)
		)
			return fromWallTime(Reflect.apply(parse, NativeDate, [text + "Z"]));
		const parsed = Reflect.apply(parse, NativeDate, [text]);
		// Delegate browser-specific legacy grammar to its parser in UTC. Strings
		// with an explicit zone and ISO date-only strings retain their instant.
		if (
			!Number.isFinite(parsed) ||
			/^(?:[+-]\d{6}|\d{4})(?:-\d\d(?:-\d\d)?)?$/.test(text) ||
			/(?:z|gmt|utc|[ecmp][sd]t|[+-]\d{2}:?\d{2})(?:\s*\([^)]*\))?\s*$/i.test(
				text
			)
		)
			return parsed;
		const asUTC = Reflect.apply(parse, NativeDate, [text + " UTC"]);
		return Number.isFinite(asUTC) ? fromWallTime(asUTC) : parsed;
	};
	client.Proxy("Date.parse", {
		apply(ctx) {
			ctx.return(parseDate(`${ctx.args[0]}`));
		},
	});
	client.Proxy("Date", {
		apply(ctx) {
			ctx.return(dateString(new NativeDate(), "toString"));
		},
		construct(ctx) {
			if (ctx.args.length >= 2)
				ctx.args = [fromWallTime(Reflect.apply(utc, NativeDate, ctx.args))];
			else if (ctx.args.length === 1) {
				let value = ctx.args[0];
				if (
					value !== null &&
					(typeof value === "object" || typeof value === "function")
				) {
					try {
						ctx.args = [Reflect.apply(getTime, value, [])];
						return;
					} catch {
						/* Ordinary objects use ToPrimitive with hint default. */
					}
					const exotic = value[self.Symbol.toPrimitive];
					if (exotic !== undefined && exotic !== null)
						value = Reflect.apply(exotic, value, ["default"]);
					else {
						for (const key of ["valueOf", "toString"]) {
							if (typeof value[key] !== "function") continue;
							const primitive = Reflect.apply(value[key], value, []);
							if (
								primitive === null ||
								(typeof primitive !== "object" &&
									typeof primitive !== "function")
							) {
								value = primitive;
								break;
							}
						}
					}
					if (
						value !== null &&
						(typeof value === "object" || typeof value === "function")
					)
						throw new self.TypeError(
							"Cannot convert object to primitive value"
						);
				}
				ctx.args = [typeof value === "string" ? parseDate(value) : value];
			}
		},
	});
	Object.defineProperty(NativeDate.prototype, "constructor", {
		...Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor"),
		value: self.Date,
	});
}
