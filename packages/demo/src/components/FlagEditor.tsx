import {
	japanEnvironment,
	loadEnvironment,
	saveEnvironment,
} from "../environment";
import { createStore, css, type Component } from "dreamland/core";
import type { ScramjetFlags } from "@mercuryworkshop/scramjet";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { cachePlugin, controller } from "..";

const flagStore = createStore<ScramjetFlags>(
	{
		...defaultConfigDev.flags,
	},
	{
		ident: "scramjet-flags",
		backing: "localstorage",
		autosave: "auto",
	}
);

// Flag descriptions for better UX
const flagDescriptions: Record<keyof ScramjetFlags, string> = {
	syncxhr: "Enable synchronous XMLHttpRequest support",
	disableComputedWrap: "Skip deep js interception for better runtime speed",
	cleanErrors: "prevent sites from noticing scramjet stack frames",
	sourcemaps:
		"prevent sites from noticing javascript transformations (at a performance cost)",
	destructureRewrites:
		"enable support for rewriting es6 destructure syntax (currently experimental)",
	allowInvalidJs:
		"if invalid javascript is evaluated, pass through unsafely instead of throwing",
	allowFailedIntercepts:
		"if an api interceptor fails, call the api with original input unsafely instead of throwing",
	encapsulateWorkers:
		"wrap web worker scripts in data urls to prevent scope issues (potentially buggy)",
	scramitize:
		"Trigger debugger whenever the string 'scramjet' or the real location is detected in attacker code (debug feature)",
	rewriterLogs: "Enable rewriter logging (debug feature)",
	captureErrors: "Capture and handle JavaScript errors (debug feature)",
	debugTrampolines: "Show proxied api in stack traces (debug feature)",
	debugSourceURL:
		"Make debugger recognize javascript source urls consistently (debug feature)",
};

const FlagEditor: Component<
	{
		inline?: boolean;
	},
	{},
	{
		isOpen: boolean;
		cacheBustStatus: string;
		timezone: string;
		languages: string;
		protectFonts: boolean;
		environmentStatus: string;
	}
> = function (cx) {
	this.isOpen = false;
	this.cacheBustStatus = "";
	const environment = loadEnvironment();
	this.timezone = environment.timezone ?? "";
	this.languages = environment.languages?.join(", ") ?? "";
	this.protectFonts = environment.protectFonts ?? true;
	this.environmentStatus = "";
	const applyEnvironment = async () => {
		try {
			const languages = this.languages
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			controller.scramjetConfig.environment = saveEnvironment({
				timezone: this.timezone.trim() || undefined,
				languages: languages.length ? languages : undefined,
				protectFonts: this.protectFonts,
			});
			await cachePlugin.bust();
			this.environmentStatus = "Saved. Reload the proxied page to apply.";
		} catch (error) {
			this.environmentStatus =
				error instanceof Error ? error.message : String(error);
		}
	};

	const toggleFlag = (flag: keyof ScramjetFlags, value: boolean) => {
		flagStore[flag] = value;
		Object.assign(controller.scramjetConfig.flags, flagStore);
	};

	const resetToDefaults = () => {
		Object.assign(flagStore, {
			...defaultConfigDev.flags,
		});
		Object.assign(controller.scramjetConfig.flags, flagStore);
	};

	const bustCache = async () => {
		this.cacheBustStatus = "Busting…";
		try {
			const ok = await cachePlugin.bust();
			this.cacheBustStatus = ok ? "Cache cleared" : "Nothing to clear";
		} catch (err) {
			console.error("[FlagEditor] cache bust failed:", err);
			this.cacheBustStatus = "Bust failed (see console)";
		}
		setTimeout(() => {
			this.cacheBustStatus = "";
		}, 2000);
	};
	cx.mount = async () => {
		await controller.wait();
		Object.assign(controller.scramjetConfig.flags, flagStore);
	};

	return (
		<div
			class={use(this.inline).map(
				(inline) => `flag-editor ${inline ? "inline" : ""}`
			)}
		>
			<button
				class="toggle-button"
				on:click={() => {
					this.isOpen = !this.isOpen;
				}}
			>
				{use(this.isOpen).map((open) => (open ? "▼" : "▶"))} Flag Editor
			</button>
			{use(this.isOpen).andThen(
				<div class="editor-panel">
					<div class="header">
						<h3>Scramjet Feature Flags</h3>
						<div class="header-actions">
							<button class="cache-bust-button" on:click={bustCache}>
								Bust Cache
							</button>
							<button class="reset-button" on:click={resetToDefaults}>
								Reset to Defaults
							</button>
						</div>
					</div>
					{use(this.cacheBustStatus).andThen(
						<div class="cache-bust-status">{use(this.cacheBustStatus)}</div>
					)}
					<fieldset class="environment-settings">
						<legend>Browser environment</legend>
						<label>
							Time zone (IANA)
							<input
								aria-label="Time zone"
								value={use(this.timezone)}
								placeholder="Asia/Tokyo"
								on:input={(event: Event) => {
									this.timezone = (event.target as HTMLInputElement).value;
								}}
							/>
						</label>
						<label>
							Languages (in preference order)
							<input
								aria-label="Languages"
								value={use(this.languages)}
								placeholder="ja-JP, ja, en"
								on:input={(event: Event) => {
									this.languages = (event.target as HTMLInputElement).value;
								}}
							/>
						</label>
						<p>Leave a field empty to use the browser setting.</p>
						<label>
							<input
								type="checkbox"
								aria-label="Protect fonts"
								checked={use(this.protectFonts)}
								on:change={(event: Event) => {
									this.protectFonts = (
										event.target as HTMLInputElement
									).checked;
								}}
							/>
							Restrict local fonts &amp; use fixed Twemoji
						</label>
						<p>
							Font protection is best effort. Layout and rendering may differ
							between browsers.
						</p>
						<div class="header-actions">
							<button class="reset-button" on:click={applyEnvironment}>
								Apply environment
							</button>
							<button
								class="reset-button"
								on:click={() => {
									this.timezone = japanEnvironment.timezone!;
									this.languages = japanEnvironment.languages!.join(", ");
									this.protectFonts = true;
									applyEnvironment();
								}}
							>
								Japan preset
							</button>
						</div>
						<p role="status">{use(this.environmentStatus)}</p>
					</fieldset>
					<div class="flags-list">
						{(Object.keys(flagStore) as Array<keyof ScramjetFlags>).map(
							(flag) => (
								<label class="flag-item">
									<input
										type="checkbox"
										checked={use(flagStore[flag])}
										on:change={(e: Event) =>
											toggleFlag(flag, (e.target as HTMLInputElement).checked)
										}
									/>
									<div class="flag-info">
										<span class="flag-name">{flag}</span>
										<span class="flag-desc">{flagDescriptions[flag]}</span>
									</div>
								</label>
							)
						)}
					</div>
				</div>
			)}
		</div>
	);
};

FlagEditor.style = css`
	:scope {
		position: fixed;
		top: 1em;
		right: 1em;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.9);
		border: 1px solid #444;
		border-radius: 8px;
		color: white;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		font-size: 14px;
		max-width: 400px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	}

	:scope.inline {
		position: relative;
		display: flex;
		align-items: center;
		background: transparent;
		border: none;
		box-shadow: none;
		max-width: none;
	}

	.toggle-button {
		width: 100%;
		padding: 0.75em 1em;
		background: #333;
		border: none;
		border-radius: 8px 8px 0 0;
		color: white;
		cursor: pointer;
		font-size: 14px;
		font-weight: 500;
		text-align: left;
		transition: background 0.2s;
	}

	:scope.inline .toggle-button {
		padding: 0.35em 0.7em;
		background: #1a1a1a;
		border: 1px solid #2a2a2a;
		border-radius: 0;
		font-size: 0.8em;
		line-height: 1.2;
		min-height: 28px;
		display: inline-flex;
		align-items: center;
	}

	:scope.inline .toggle-button:hover {
		background: #222;
	}

	.toggle-button:hover {
		background: #444;
	}

	.editor-panel {
		padding: 1em;
		border-top: 1px solid #444;
		max-height: 60vh;
		overflow-y: auto;
	}

	:scope.inline .editor-panel {
		position: absolute;
		top: calc(100% + 0.35em);
		right: 0;
		min-width: 320px;
		background: rgba(0, 0, 0, 0.95);
		border: 1px solid #444;
		border-radius: 8px;
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
		z-index: 1000;
	}

	@media (max-width: 600px) {
		:scope.inline {
			position: fixed;
			top: 58px;
			right: 8px;
		}
		:scope.inline .editor-panel {
			position: fixed;
			top: 94px;
			left: 8px;
			right: 8px;
			min-width: 0;
			max-height: calc(100dvh - 130px);
		}
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1em;
	}

	.header h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}

	.reset-button {
		padding: 0.4em 0.8em;
		background: #555;
		border: 1px solid #666;
		border-radius: 4px;
		color: white;
		cursor: pointer;
		font-size: 12px;
		transition: background 0.2s;
	}

	.reset-button:hover {
		background: #666;
	}

	.header-actions {
		display: flex;
		gap: 0.4em;
	}

	.cache-bust-button {
		padding: 0.4em 0.8em;
		background: #7a2e2e;
		border: 1px solid #9a3a3a;
		border-radius: 4px;
		color: white;
		cursor: pointer;
		font-size: 12px;
		transition: background 0.2s;
	}

	.cache-bust-button:hover {
		background: #9a3a3a;
	}

	.cache-bust-status {
		font-size: 12px;
		color: #aaa;
		text-align: right;
		margin-bottom: 0.5em;
		font-family: "Courier New", monospace;
	}

	.environment-settings {
		margin: 0 0 1em;
		border: 1px solid #555;
	}
	.environment-settings label {
		display: flex;
		flex-direction: column;
		gap: 0.3em;
		margin: 0.6em 0;
	}
	.environment-settings input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.5em;
		background: #222;
		border: 1px solid #666;
		color: white;
	}
	.environment-settings p {
		font-size: 12px;
		line-height: 1.5;
		color: #ccc;
	}
	.environment-settings input[type="checkbox"] {
		width: auto;
		align-self: flex-start;
	}

	.flags-list {
		display: flex;
		flex-direction: column;
		gap: 0.75em;
	}

	.flag-item {
		display: flex;
		align-items: flex-start;
		gap: 0.75em;
		cursor: pointer;
		padding: 0.5em;
		border-radius: 4px;
		transition: background 0.2s;
	}

	.flag-item:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.flag-item input[type="checkbox"] {
		margin-top: 0.2em;
		cursor: pointer;
		flex-shrink: 0;
	}

	.flag-info {
		display: flex;
		flex-direction: column;
		gap: 0.25em;
		flex: 1;
	}

	.flag-name {
		font-weight: 500;
		color: #fff;
		font-family: "Courier New", monospace;
		font-size: 13px;
	}

	.flag-desc {
		font-size: 12px;
		color: #aaa;
		line-height: 1.4;
	}
`;

export default FlagEditor;
