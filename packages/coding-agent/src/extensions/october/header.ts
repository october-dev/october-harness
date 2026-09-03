import { truncateToWidth } from "@earendil-works/pi-tui";
import { VERSION } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

const OCTOBER_LETTERS: readonly (readonly string[])[] = [
	[" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
	[" ██████╗ ", "██╔════╝ ", "██║      ", "██║      ", "╚██████╗ ", " ╚═════╝ "],
	["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
	[" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
	["██████╗  ", "██╔══██╗ ", "██████╔╝ ", "██╔══██╗ ", "██████╔╝ ", "╚═════╝  "],
	["███████╗ ", "██╔════╝ ", "█████╗   ", "██╔══╝   ", "███████╗ ", "╚══════╝ "],
	["██████╗  ", "██╔══██╗ ", "██████╔╝ ", "██╔══██╗ ", "██║  ██║ ", "╚═╝  ╚═╝ "],
];

const OCTOBER_PALETTE = [
	{ rgb: [242, 184, 75], ansi256: 215 },
	{ rgb: [240, 164, 60], ansi256: 215 },
	{ rgb: [237, 146, 51], ansi256: 209 },
	{ rgb: [230, 109, 44], ansi256: 166 },
	{ rgb: [209, 79, 48], ansi256: 167 },
	{ rgb: [195, 69, 50], ansi256: 131 },
	{ rgb: [169, 54, 54], ansi256: 131 },
] as const;

const WORDMARK_HEIGHT = 6;
const WORDMARK_WIDTH = OCTOBER_LETTERS.reduce((width, letter) => width + letter[0].length, 0);
const ROUTE_SEGMENT = "────○────";

type OctoberHeaderTheme = Pick<Theme, "bold" | "fg" | "getColorMode">;

function autumn(color: (typeof OCTOBER_PALETTE)[number], text: string, theme: OctoberHeaderTheme): string {
	const start =
		theme.getColorMode() === "truecolor"
			? `\x1b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`
			: `\x1b[38;5;${color.ansi256}m`;
	return `${start}${text}\x1b[39m`;
}

function gradient(segments: readonly string[], theme: OctoberHeaderTheme): string {
	return segments.map((segment, index) => autumn(OCTOBER_PALETTE[index], segment, theme)).join("");
}

function gradientName(theme: OctoberHeaderTheme): string {
	return gradient(
		[..."october"].map((letter) => theme.bold(letter)),
		theme,
	);
}

export function renderOctoberHeader(theme: OctoberHeaderTheme, width: number): string[] {
	const name = gradientName(theme);
	const version = theme.fg("muted", `v${VERSION}`);
	if (width < WORDMARK_WIDTH) {
		return [truncateToWidth(` ${name}  ${theme.fg("muted", "coding agent")}  ${version}`, width), ""];
	}

	const wordmark = Array.from({ length: WORDMARK_HEIGHT }, (_, row) =>
		gradient(
			OCTOBER_LETTERS.map((letter) => letter[row]),
			theme,
		),
	);
	const route = gradient(
		OCTOBER_LETTERS.map(() => ROUTE_SEGMENT),
		theme,
	);
	return [...wordmark, route, "", ` ${name}  October coding agent  ${version}`, ""];
}

export function registerOctoberHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderOctoberHeader(theme, width);
			},
			invalidate() {},
		}));
	});
}
