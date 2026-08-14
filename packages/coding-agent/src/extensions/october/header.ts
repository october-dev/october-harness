import { VERSION } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export function registerOctoberHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(): string[] {
				const name = theme.fg("accent", theme.bold("octo"));
				const version = theme.fg("muted", `v${VERSION}`);
				return [
					theme.fg("accent", "  ___   ___ _____ ___  "),
					theme.fg("accent", " / _ \\ / __|_   _/ _ \\ "),
					theme.fg("accent", "| (_) | (__  | || (_) |"),
					theme.fg("accent", " \\___/ \\___| |_| \\___/ "),
					"",
					` ${name}  October coding agent  ${version}`,
					"",
				];
			},
			invalidate() {},
		}));
	});
}
