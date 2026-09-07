import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { renderOctoberHeader } from "../src/extensions/october/header.ts";
import { getThemeByName } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => {
	resetCapabilitiesCache();
});

function getDarkTheme() {
	const theme = getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	return theme;
}

describe("October header", () => {
	it("renders the Bus-inspired block wordmark and transit line in truecolor", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const lines = renderOctoberHeader(getDarkTheme(), 80);
		const plain = lines.map(stripAnsi);

		expect(lines).toHaveLength(10);
		expect(plain[0]).toBe(" ██████╗  ██████╗ ████████╗ ██████╗ ██████╗  ███████╗ ██████╗  ");
		expect(plain[6]).toBe("────○────".repeat(7));
		expect(lines[0]).toContain("\x1b[38;2;255;196;82m");
		expect(lines[0]).toContain("\x1b[38;2;190;64;12m");
		expect(lines[8]).toContain("\x1b[38;2;247;130;14mOctober coding agent");
		expect(plain[8]).toContain("october  October coding agent");
		expect(plain.slice(0, 7).every((line) => visibleWidth(line) === 63)).toBe(true);
	});

	it("uses the matching autumn palette in 256-color terminals", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const lines = renderOctoberHeader(getDarkTheme(), 80);

		expect(lines[0]).toContain("\x1b[38;5;221m");
		expect(lines[0]).toContain("\x1b[38;5;130m");
	});

	it("falls back to a compact header without overflowing narrow terminals", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const lines = renderOctoberHeader(getDarkTheme(), 32);
		const plain = lines.map(stripAnsi);

		expect(lines).toHaveLength(2);
		expect(plain[0]).toContain("october");
		expect(plain[0]).not.toContain("█");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});
});
