import type { SettingsManager } from "../../core/settings-manager.ts";
import { isOctoberDesktopMode } from "./auth.ts";

/**
 * Pi packages October installs by default, pinned to reviewed releases. `since` is the defaults
 * version that introduced the package: to add one, append it with `since` one above the current
 * maximum, so existing users receive only the new package and removed defaults stay removed.
 */
export const OCTOBER_DEFAULT_PACKAGES: ReadonlyArray<{ source: string; since: number }> = [
	{ source: "npm:pi-mcp-adapter@2.37.0", since: 1 },
	{ source: "npm:pi-web-access@0.31.0", since: 1 },
	{ source: "npm:@juicesharp/rpiv-ask-user-question@2.11.0", since: 1 },
	{ source: "npm:@juicesharp/rpiv-todo@2.11.0", since: 1 },
	{ source: "npm:@narumitw/pi-plan-mode@0.58.3", since: 1 },
	{ source: "npm:pi-lens@4.2.1", since: 1 },
];

export const OCTOBER_DEFAULT_PACKAGES_VERSION = Math.max(...OCTOBER_DEFAULT_PACKAGES.map((entry) => entry.since));

/** True for the exact pinned source October seeded, not for a user-chosen version of the package. */
export function isOctoberDefaultPackageSource(source: string): boolean {
	return OCTOBER_DEFAULT_PACKAGES.some((entry) => entry.source === source);
}

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	return /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/.exec(source.slice(4))?.[1];
}

/**
 * Add October's default packages to the user's global `packages` setting, once per defaults
 * version. They then behave like any user-installed package: listed by `october list`, removable
 * with `october remove`, and installed by the package manager without Pi peer dependencies.
 * A package the user already configured (any version) is left untouched, and only packages newer
 * than the recorded defaults version are considered, so a removed default is not re-added.
 * Skipped for Desktop-managed runs, whose startup must not block on a first-run install, and for
 * offline runs, which cannot install; those seed on a later online run.
 */
export function seedOctoberDefaultPackages(settings: SettingsManager, env: NodeJS.ProcessEnv = process.env): string[] {
	if (isOctoberDesktopMode(env) || env.PI_OFFLINE === "1" || env.PI_OFFLINE?.toLowerCase() === "true") return [];
	const seededVersion = settings.getOctoberDefaultPackagesVersion() ?? 0;
	if (seededVersion >= OCTOBER_DEFAULT_PACKAGES_VERSION) return [];

	const existing = settings.getGlobalSettings().packages ?? [];
	const configured = new Set(
		existing.map((pkg) => npmPackageName(typeof pkg === "string" ? pkg : pkg.source)).filter((name) => name),
	);
	const added = OCTOBER_DEFAULT_PACKAGES.filter(
		(entry) => entry.since > seededVersion && !configured.has(npmPackageName(entry.source)),
	).map((entry) => entry.source);
	if (added.length > 0) settings.setPackages([...existing, ...added]);
	settings.setOctoberDefaultPackagesVersion(OCTOBER_DEFAULT_PACKAGES_VERSION);
	return added;
}
