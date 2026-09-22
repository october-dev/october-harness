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
	vi.unstubAllEnvs();
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
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ packageName: PACKAGE_NAME, version: "1.2.3" });
	});

	it("uses npm latest metadata with an October user agent instead of the unavailable website feed", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) =>
			String(input) === "https://registry.npmjs.org/@october-dev%2foctober/latest"
				? Response.json({ name: PACKAGE_NAME, version: "1.2.4" })
				: new Response("Not found", { status: 404 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(LATEST_VERSION_URL).toBe("https://registry.npmjs.org/@october-dev%2foctober/latest");
		expect(fetchMock).toHaveBeenCalledOnce();
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
				name: "@earendil-works/pi-coding-agent",
				version: "9.9.9",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("surfaces a newer version when npm names this package", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				name: PACKAGE_NAME,
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
			.mockResolvedValueOnce(Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "1.2.4",
		});
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

	it("rejects npm metadata for another package even if it includes a conflicting packageName", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				name: "@new-scope/pi",
				packageName: PACKAGE_NAME,
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).rejects.toThrow(
			"will not uninstall October to install another package",
		);
	});

	it("preserves optional update notes from the published manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ name: PACKAGE_NAME, note: " **Read this** ", version: "1.2.4" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			note: "**Read this**",
			version: "1.2.4",
		});
	});

	it("recognizes newer October prereleases without downgrading a source checkout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "0.87.0-october.1" })),
		);
		await expect(checkForNewPiVersion("0.85.1-october.7")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "0.87.0-october.1",
		});
		await expect(checkForNewPiVersion("0.87.0-october.2")).resolves.toBeUndefined();
	});

	it.each([null, [], "not a manifest", {}, { version: "" }, { version: "latest" }, { version: "^1.2.3" }])(
		"rejects invalid npm metadata: %j",
		async (metadata) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json(metadata)),
			);
			await expect(getLatestPiRelease("1.2.3")).rejects.toThrow("Invalid npm metadata");
			await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		},
	);

	it("rejects manifests without a package identity", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4" })),
		);
		await expect(getLatestPiRelease("1.2.3")).rejects.toThrow("unnamed package");
	});

	it.each([404, 503])(
		"reports npm HTTP %i failures for manual updates but keeps background checks quiet",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("Unavailable", { status })),
			);
			await expect(getLatestPiRelease("1.2.3")).rejects.toThrow(`npm registry returned HTTP ${status}`);
			await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		},
	);

	it("does not query npm while offline", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
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
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
