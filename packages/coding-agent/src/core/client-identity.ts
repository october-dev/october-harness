import type { ClientIdentity } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * Identify October to providers, with attribution only while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: { custom: getPiUserAgent(VERSION) },
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager)
			? { name: "october", url: "https://www.october.dev", categories: ["cli-agent"] }
			: null,
	};
}
