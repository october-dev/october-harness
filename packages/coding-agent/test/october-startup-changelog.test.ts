import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { type ChangelogEntry, getNewEntries } from "../src/utils/changelog.ts";

type SettingsManagerStub = {
	getLastChangelogVersion: () => string | undefined;
	setLastChangelogVersion: (version: string) => void;
	getEnableInstallTelemetry: () => boolean;
};

type ChangelogDisplayContext = {
	session: {
		state: { messages: unknown[] };
		settingsManager: SettingsManagerStub;
	};
	settingsManager: SettingsManagerStub;
	pendingTelemetryConsent: boolean;
	reportInstallTelemetry: (version: string) => void;
};

type InteractiveModePrivate = {
	getChangelogForDisplay(this: ChangelogDisplayContext): string | undefined;
};

const getChangelogForDisplay = (InteractiveMode.prototype as unknown as InteractiveModePrivate).getChangelogForDisplay;

function createContext(lastVersion: string | undefined, messages: unknown[] = []): ChangelogDisplayContext {
	const settingsManager: SettingsManagerStub = {
		getLastChangelogVersion: () => lastVersion,
		setLastChangelogVersion: vi.fn(),
		getEnableInstallTelemetry: () => false,
	};
	return {
		session: {
			state: { messages },
			settingsManager,
		},
		settingsManager,
		pendingTelemetryConsent: false,
		reportInstallTelemetry: vi.fn(),
	};
}

describe("October interactive startup changelog", () => {
	const originalTelemetry = process.env.PI_TELEMETRY;

	afterEach(() => {
		if (originalTelemetry === undefined) delete process.env.PI_TELEMETRY;
		else process.env.PI_TELEMETRY = originalTelemetry;
	});

	it("treats 0.84.2-october.N as 0.84.0, which would dump every 0.84.x+ entry", () => {
		const entries: ChangelogEntry[] = [
			{ major: 0, minor: 83, patch: 9, content: "## [0.83.9]\nold" },
			{ major: 0, minor: 84, patch: 1, content: "## [0.84.1]\npi notes" },
			{ major: 0, minor: 84, patch: 2, content: "## [0.84.2]\nmore pi notes" },
		];
		expect(getNewEntries(entries, "0.84.2-october.3").map((entry) => `${entry.minor}.${entry.patch}`)).toEqual([
			"84.1",
			"84.2",
		]);
	});

	it("never returns changelog markdown on a version bump", () => {
		const context = createContext("0.84.2-october.2");
		expect(getChangelogForDisplay.call(context)).toBeUndefined();
		expect(context.session.settingsManager.setLastChangelogVersion).toHaveBeenCalledWith(VERSION);
		expect(context.pendingTelemetryConsent).toBe(false);
	});

	it("never returns changelog markdown even when lastVersion would select the full file", () => {
		const context = createContext("0.0.0");
		expect(getChangelogForDisplay.call(context)).toBeUndefined();
		expect(context.session.settingsManager.setLastChangelogVersion).toHaveBeenCalledWith(VERSION);
	});

	it("records lastChangelogVersion on a fresh install without showing changelog", () => {
		delete process.env.PI_TELEMETRY;
		const context = createContext(undefined);
		expect(getChangelogForDisplay.call(context)).toBeUndefined();
		expect(context.session.settingsManager.setLastChangelogVersion).toHaveBeenCalledWith(VERSION);
		expect(context.pendingTelemetryConsent).toBe(true);
	});

	it("skips changelog bookkeeping for resumed sessions", () => {
		const context = createContext("0.84.2-october.2", [{ role: "user" }]);
		expect(getChangelogForDisplay.call(context)).toBeUndefined();
		expect(context.session.settingsManager.setLastChangelogVersion).not.toHaveBeenCalled();
	});

	it("does not rewrite lastChangelogVersion when it already matches VERSION", () => {
		const context = createContext(VERSION);
		expect(getChangelogForDisplay.call(context)).toBeUndefined();
		expect(context.session.settingsManager.setLastChangelogVersion).not.toHaveBeenCalled();
		expect(context.reportInstallTelemetry).not.toHaveBeenCalled();
	});
});
