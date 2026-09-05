/** Minimum Node for this CLI. Checked before any import that loads undici. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NODE_VERSION = "22.19.0";

export function parseNodeVersion(version: string): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	return [major, minor, patch];
}

/** True when argv asks for --version / -v. Checked before any undici import. */
export function argvRequestsVersion(argv: readonly string[]): boolean {
	return argv.includes("--version") || argv.includes("-v");
}

/**
 * Walk up from the compiled (or source) file to package.json. Node-builtin only —
 * Desktop's `october --version` gate must not load config/main/undici.
 */
export function readCliPackageVersion(
	startDir?: string,
	moduleUrl = import.meta.url,
	executablePath = process.execPath,
): string {
	// Match Pi's compiled-Bun package lookup without importing config/undici.
	const compiled = moduleUrl.includes("$bunfs") || moduleUrl.includes("~BUN") || moduleUrl.includes("%7EBUN");
	let dir = startDir ?? (compiled ? dirname(executablePath) : dirname(fileURLToPath(moduleUrl)));
	for (;;) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			try {
				const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
				if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
			} catch {
				// keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "0.0.0";
}

/** Print the package version to stdout. Caller exits 0. */
export function printCliVersion(): void {
	console.log(readCliPackageVersion());
}

export function isSupportedNodeVersion(version: string, minimum = MIN_NODE_VERSION): boolean {
	const [major, minor, patch] = parseNodeVersion(version);
	const [minMajor, minMinor, minPatch] = parseNodeVersion(minimum);
	if (major !== minMajor) return major > minMajor;
	if (minor !== minMinor) return minor > minMinor;
	return patch >= minPatch;
}

export function formatUnsupportedNodeMessage(version: string): string {
	return (
		`october requires Node.js >= ${MIN_NODE_VERSION} (this is ${version}). ` +
		"Install a current Node from https://nodejs.org or use the October installer."
	);
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
	if (!isSupportedNodeVersion(version)) {
		console.error(formatUnsupportedNodeMessage(version));
		process.exit(1);
	}
}
