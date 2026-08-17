import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, PACKAGE_NAME } from "../src/config.ts";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	describeNewVersionNotification,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	isSelfUpdatePackage,
	LATEST_VERSION_URL,
	planSelfUpdate,
	UPDATE_CHANGELOG_URL,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the october.dev version check api with an October user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(LATEST_VERSION_URL).toBe("https://www.october.dev/api/cli/latest-version");
		expect(fetchMock).toHaveBeenCalledWith(
			LATEST_VERSION_URL,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^october\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("ignores a newer version advertised for a different package", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@earendil-works/pi-coding-agent",
				version: "9.9.9",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("surfaces a newer version when the feed names this package", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: PACKAGE_NAME,
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "1.2.4",
		});
	});

	it("refuses a self-update plan whose packageName is not this install", () => {
		expect(isSelfUpdatePackage("@earendil-works/pi-coding-agent", PACKAGE_NAME)).toBe(false);
		expect(() =>
			planSelfUpdate(
				{ packageName: "@earendil-works/pi-coding-agent", version: "0.84.2" },
				{ force: true, currentVersion: "0.84.2-october.2", packageName: PACKAGE_NAME },
			),
		).toThrow(/will not uninstall October to install another package/);
	});

	it("plans an update only for this package, defaulting omitted packageName to self", () => {
		expect(
			planSelfUpdate({ version: "1.2.4" }, { force: false, currentVersion: "1.2.3", packageName: PACKAGE_NAME }),
		).toEqual({
			packageName: PACKAGE_NAME,
			installSpec: `${PACKAGE_NAME}@1.2.4`,
			version: "1.2.4",
			shouldRun: true,
		});
		expect(
			planSelfUpdate(
				{ packageName: PACKAGE_NAME, version: "1.2.3", note: "read me" },
				{ force: false, currentVersion: "1.2.3", packageName: PACKAGE_NAME },
			),
		).toEqual({
			packageName: PACKAGE_NAME,
			installSpec: `${PACKAGE_NAME}@1.2.3`,
			version: "1.2.3",
			shouldRun: false,
		});
		expect(
			planSelfUpdate(
				{ packageName: PACKAGE_NAME, version: "1.2.3", note: "read me" },
				{ force: true, currentVersion: "1.2.3", packageName: PACKAGE_NAME },
			),
		).toEqual({
			packageName: PACKAGE_NAME,
			installSpec: `${PACKAGE_NAME}@1.2.3`,
			version: "1.2.3",
			shouldRun: true,
			note: "read me",
		});
	});

	it("describes the October update banner and changelog URL", () => {
		expect(describeNewVersionNotification({ version: "1.2.4" }, APP_NAME)).toEqual({
			title: "Update Available",
			instruction: `New version 1.2.4 is available. Run ${APP_NAME} update`,
			changelogUrl: "https://www.october.dev/changelog",
		});
		expect(UPDATE_CHANGELOG_URL).toBe("https://www.october.dev/changelog");
		expect(APP_NAME).toBe("october");
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
