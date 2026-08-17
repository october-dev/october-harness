import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME, getShareViewerUrl } from "../src/config.ts";
import { resolveRemoteCatalogBaseUrl } from "../src/core/remote-catalog-provider.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	buildInstallTelemetryRequest,
	INSTALL_TELEMETRY_CONSENT_LINE,
	INSTALL_TELEMETRY_URL,
	isInstallTelemetryEnabled,
	shouldOfferInstallTelemetryConsent,
} from "../src/core/telemetry.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("October phone-home defaults", () => {
	const originalCatalog = process.env.OCTOBER_CATALOG_BASE_URL;
	const originalPiCatalog = process.env.PI_CATALOG_BASE_URL;
	const originalShare = process.env.PI_SHARE_VIEWER_URL;
	const originalTelemetry = process.env.PI_TELEMETRY;

	afterEach(() => {
		if (originalCatalog === undefined) delete process.env.OCTOBER_CATALOG_BASE_URL;
		else process.env.OCTOBER_CATALOG_BASE_URL = originalCatalog;
		if (originalPiCatalog === undefined) delete process.env.PI_CATALOG_BASE_URL;
		else process.env.PI_CATALOG_BASE_URL = originalPiCatalog;
		if (originalShare === undefined) delete process.env.PI_SHARE_VIEWER_URL;
		else process.env.PI_SHARE_VIEWER_URL = originalShare;
		if (originalTelemetry === undefined) delete process.env.PI_TELEMETRY;
		else process.env.PI_TELEMETRY = originalTelemetry;
	});

	it("defaults install telemetry off and never reports to pi.dev", () => {
		delete process.env.PI_TELEMETRY;
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		expect(settings.getEnableInstallTelemetry()).toBe(false);
		expect(isInstallTelemetryEnabled(settings)).toBe(false);
		expect(INSTALL_TELEMETRY_URL).toBe("https://www.october.dev/api/cli/report-install");
		expect(INSTALL_TELEMETRY_URL).not.toContain("pi.dev");
		const request = buildInstallTelemetryRequest("1.2.3");
		expect(request.url).toBe("https://www.october.dev/api/cli/report-install?version=1.2.3");
		expect(request.headers["User-Agent"]).toBe(getPiUserAgent("1.2.3"));
		expect(request.headers["User-Agent"].startsWith("october/")).toBe(true);
	});

	it("offers a first-run consent line only when telemetry is off on a fresh install", () => {
		expect(shouldOfferInstallTelemetryConsent({ lastChangelogVersion: undefined, telemetryEnabled: false })).toBe(
			true,
		);
		expect(shouldOfferInstallTelemetryConsent({ lastChangelogVersion: "0.84.2", telemetryEnabled: false })).toBe(
			false,
		);
		expect(shouldOfferInstallTelemetryConsent({ lastChangelogVersion: undefined, telemetryEnabled: true })).toBe(
			false,
		);
		expect(INSTALL_TELEMETRY_CONSENT_LINE).toContain("october.dev");
		expect(INSTALL_TELEMETRY_CONSENT_LINE).toContain("enableInstallTelemetry");
	});

	it("does not default the remote catalog overlay to pi.dev", () => {
		delete process.env.OCTOBER_CATALOG_BASE_URL;
		delete process.env.PI_CATALOG_BASE_URL;
		expect(resolveRemoteCatalogBaseUrl()).toBeUndefined();
		expect(resolveRemoteCatalogBaseUrl("https://pi.dev")).toBe("https://pi.dev");
		process.env.OCTOBER_CATALOG_BASE_URL = "https://catalog.example/base";
		expect(resolveRemoteCatalogBaseUrl()).toBe("https://catalog.example/base");
	});

	it("points the share viewer and UA at October", () => {
		delete process.env.PI_SHARE_VIEWER_URL;
		expect(getShareViewerUrl("gist123")).toBe("https://www.october.dev/session/#gist123");
		expect(APP_NAME).toBe("october");
		expect(getPiUserAgent("9.9.9")).toMatch(/^october\/9\.9\.9 /);
	});
});
