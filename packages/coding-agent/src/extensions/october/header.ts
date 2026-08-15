import { VERSION } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export function registerOctoberHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(): string[] {
				const name = theme.fg("accent", theme.bold("october"));
				const version = theme.fg("muted", `v${VERSION}`);
				return [
					theme.fg("accent", "  ___   ____ _____ ___  ____  _____ ____  "),
					theme.fg("accent", " / _ \\ / ___|_   _/ _ \\| __ )| ____|  _ \\ "),
					theme.fg("accent", "| | | | |     | || | | |  _ \\|  _| | |_) |"),
					theme.fg("accent", "| |_| | |___  | || |_| | |_) | |___|  _ < "),
					theme.fg("accent", " \\___/ \\____| |_| \\___/|____/|_____|_| \\_\\"),
					"",
					` ${name}  October coding agent  ${version}`,
					"",
				];
			},
			invalidate() {},
		}));
	});
}
