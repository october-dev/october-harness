export function parseArgs(argv) {
	return Object.fromEntries(argv.map((arg) => arg.replace(/^--/, "").split("=")));
}
