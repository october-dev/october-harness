import type { SettingsManager } from "../../core/settings-manager.ts";
import type { PackageSource } from "../../core/settings-schema.ts";
import { isOctoberDesktopMode } from "./auth.ts";

/** One default package: its current pin and the reviewed pins it replaces. */
export interface OctoberDefaultPackage {
	/** Current exact pin, e.g. `npm:pi-lens@4.4.10`. */
	source: string;
	/** Defaults version that introduced the package. */
	since: number;
	/** Defaults version that set `source`; earlier pins in `previous` move to it once. */
	pinnedIn: number;
	/** Exact sources October pinned before, oldest first. */
	previous: readonly string[];
}

/**
 * Pi packages October installs by default, pinned to reviewed releases.
 * To add a package, append it with `since` and `pinnedIn` one above the current
 * OCTOBER_DEFAULT_PACKAGES_VERSION, so existing users receive only the new package and removed
 * defaults stay removed. To upgrade a pin, move the old source to `previous` and set `pinnedIn`
 * one above the current version, so users still on the old pin move to the new one.
 */
export const OCTOBER_DEFAULT_PACKAGES: ReadonlyArray<OctoberDefaultPackage> = [
	{ source: "npm:pi-mcp-adapter@7.0.1", since: 1, pinnedIn: 2, previous: ["npm:pi-mcp-adapter@2.37.0"] },
	{ source: "npm:pi-web-access@0.47.0", since: 1, pinnedIn: 2, previous: ["npm:pi-web-access@0.31.0"] },
	{
		source: "npm:@juicesharp/rpiv-ask-user-question@2.15.0",
		since: 1,
		pinnedIn: 2,
		previous: ["npm:@juicesharp/rpiv-ask-user-question@2.11.0"],
	},
	{
		source: "npm:@juicesharp/rpiv-todo@2.15.0",
		since: 1,
		pinnedIn: 2,
		previous: ["npm:@juicesharp/rpiv-todo@2.11.0"],
	},
	{
		source: "npm:@narumitw/pi-plan-mode@0.60.0",
		since: 1,
		pinnedIn: 2,
		previous: ["npm:@narumitw/pi-plan-mode@0.58.3"],
	},
	{ source: "npm:pi-lens@4.4.10", since: 1, pinnedIn: 2, previous: ["npm:pi-lens@4.2.1"] },
];

export const OCTOBER_DEFAULT_PACKAGES_VERSION = Math.max(
	...OCTOBER_DEFAULT_PACKAGES.map((entry) => Math.max(entry.since, entry.pinnedIn)),
);

/**
 * True for an exact source October pinned, current or previous, not for a user-chosen version of
 * the package. Previous pins count so a user who has not migrated yet (for example while offline)
 * gets the same load-time treatment as before.
 */
export function isOctoberDefaultPackageSource(source: string): boolean {
	return OCTOBER_DEFAULT_PACKAGES.some((entry) => entry.source === source || entry.previous.includes(source));
}

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	return /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/.exec(source.slice(4))?.[1];
}

function packageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

/** Packages a seeding run changed in the user's global `packages` setting. */
export interface OctoberDefaultPackagesSeedResult {
	added: string[];
	upgraded: Array<{ from: string; to: string }>;
}

/**
 * Bring the user's global `packages` setting up to the current defaults version, once per
 * version. Defaults then behave like any user-installed package: listed by `october list`,
 * removable with `october remove`, and installed by the package manager without Pi peer
 * dependencies.
 *
 * - Adds packages introduced after the recorded version, unless the user already configured the
 *   package (any version), so a removed default is not re-added.
 * - Moves an entry whose source is exactly a previous October pin to the current pin, keeping the
 *   entry's other options. A version the user chose stays untouched.
 *
 * Skipped for Desktop-managed runs, whose startup must not block on a package install, and for
 * offline runs, which cannot install; those catch up on a later online run.
 */
export function seedOctoberDefaultPackages(
	settings: SettingsManager,
	env: NodeJS.ProcessEnv = process.env,
): OctoberDefaultPackagesSeedResult {
	const result: OctoberDefaultPackagesSeedResult = { added: [], upgraded: [] };
	if (isOctoberDesktopMode(env) || env.PI_OFFLINE === "1" || env.PI_OFFLINE?.toLowerCase() === "true") return result;
	const seededVersion = settings.getOctoberDefaultPackagesVersion() ?? 0;
	if (seededVersion >= OCTOBER_DEFAULT_PACKAGES_VERSION) return result;

	const existing = settings.getGlobalSettings().packages ?? [];
	const packages = existing.map((pkg): PackageSource => {
		const source = packageSource(pkg);
		const entry = OCTOBER_DEFAULT_PACKAGES.find(
			(candidate) => candidate.pinnedIn > seededVersion && candidate.previous.includes(source),
		);
		if (!entry) return pkg;
		result.upgraded.push({ from: source, to: entry.source });
		return typeof pkg === "string" ? entry.source : { ...pkg, source: entry.source };
	});

	const configured = new Set(packages.map((pkg) => npmPackageName(packageSource(pkg))).filter((name) => name));
	result.added = OCTOBER_DEFAULT_PACKAGES.filter(
		(entry) => entry.since > seededVersion && !configured.has(npmPackageName(entry.source)),
	).map((entry) => entry.source);

	if (result.added.length > 0 || result.upgraded.length > 0) settings.setPackages([...packages, ...result.added]);
	settings.setOctoberDefaultPackagesVersion(OCTOBER_DEFAULT_PACKAGES_VERSION);
	return result;
}
