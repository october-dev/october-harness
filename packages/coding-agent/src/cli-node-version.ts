/** Minimum Node for this CLI. Checked before any import that loads undici. */
export const MIN_NODE_VERSION = "22.19.0";

export function parseNodeVersion(version: string): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	return [major, minor, patch];
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
