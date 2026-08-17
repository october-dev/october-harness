import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import type { SettingsManager } from "./settings-manager.ts";

export const INSTALL_TELEMETRY_URL = "https://www.october.dev/api/cli/report-install";
export const INSTALL_TELEMETRY_CONSENT_LINE =
	"Anonymous install telemetry is off. Set enableInstallTelemetry to true in settings.json (or PI_TELEMETRY=1) to send a version ping to october.dev.";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

export function shouldOfferInstallTelemetryConsent(options: {
	lastChangelogVersion: string | undefined;
	telemetryEnabled: boolean;
}): boolean {
	return !options.lastChangelogVersion && !options.telemetryEnabled;
}

export function buildInstallTelemetryRequest(version: string): { url: string; headers: { "User-Agent": string } } {
	return {
		url: `${INSTALL_TELEMETRY_URL}?version=${encodeURIComponent(version)}`,
		headers: { "User-Agent": getPiUserAgent(version) },
	};
}
