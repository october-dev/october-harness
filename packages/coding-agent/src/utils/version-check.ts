import { compare, valid } from "semver";
import { APP_NAME, PACKAGE_NAME } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

export const LATEST_VERSION_URL = "https://registry.npmjs.org/@october-dev%2foctober/latest";
export const UPDATE_CHANGELOG_URL = "https://www.october.dev/changelog";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

/** True when the feed omitted packageName or advertised this install's own package. */
export function isSelfUpdatePackage(advertisedPackageName: string | undefined, selfPackageName: string): boolean {
	return advertisedPackageName === undefined || advertisedPackageName === selfPackageName;
}

/**
 * Build a self-update plan from a latest-version payload.
 * Refuses any advertised packageName that is not this install — never uninstall October to install another package.
 */
export function planSelfUpdate(
	latestRelease: LatestPiRelease,
	options: { force: boolean; currentVersion: string; packageName: string },
): SelfUpdatePlan {
	if (!isSelfUpdatePackage(latestRelease.packageName, options.packageName)) {
		throw new Error(
			`Refusing to install ${latestRelease.packageName}: this install is ${options.packageName}. ` +
				`${APP_NAME} update will not uninstall October to install another package.`,
		);
	}

	const packageName = options.packageName;
	const installSpec = `${packageName}@${latestRelease.version}`;
	if (options.force || isNewerPackageVersion(latestRelease.version, options.currentVersion)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			shouldRun: true,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
		};
	}

	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

export function describeNewVersionNotification(
	release: LatestPiRelease,
	appName: string,
): { title: string; instruction: string; changelogUrl: string } {
	return {
		title: "Update Available",
		instruction: `New version ${release.version} is available. Run ${appName} update`,
		changelogUrl: UPDATE_CHANGELOG_URL,
	};
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) {
		throw new Error(`npm registry returned HTTP ${response.status} for ${PACKAGE_NAME}.`);
	}

	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`Invalid npm metadata for ${PACKAGE_NAME}: expected a package manifest.`);
	}
	const version = "version" in data && typeof data.version === "string" ? valid(data.version.trim()) : null;
	if (!version) {
		throw new Error(`Invalid npm metadata for ${PACKAGE_NAME}: expected an exact package version.`);
	}
	const packageName = "name" in data && typeof data.name === "string" ? data.name : undefined;
	if (packageName !== PACKAGE_NAME) {
		throw new Error(
			`Refusing to install ${packageName ?? "an unnamed package"}: npm metadata does not match this install (${PACKAGE_NAME}). ` +
				`${APP_NAME} update will not uninstall October to install another package.`,
		);
	}
	const note = "note" in data && typeof data.note === "string" ? data.note.trim() : undefined;
	return {
		version,
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (
			latestRelease &&
			isSelfUpdatePackage(latestRelease.packageName, PACKAGE_NAME) &&
			isNewerPackageVersion(latestRelease.version, currentVersion)
		) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
