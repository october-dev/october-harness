#!/usr/bin/env node
// Guards October's package identity across upstream Pi syncs (#1).
// Upstream release commits touch the same metadata and update code as this package. A merge can
// type-check while restoring Pi names, binaries, or release endpoints, so check them explicitly.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, CONFIG_DIR_NAME, PACKAGE_NAME } from "../packages/coding-agent/src/config.ts";
import {
	LATEST_VERSION_URL,
	planSelfUpdate,
	UPDATE_CHANGELOG_URL,
} from "../packages/coding-agent/src/utils/version-check.ts";

export const OCTOBER_PACKAGE_NAME = "@october-dev/october";
const OCTOBER_REPOSITORY_URL = "git+https://github.com/october-dev/october-harness.git";
const OCTOBER_BUGS_URL = "https://github.com/october-dev/october-harness/issues";
const OCTOBER_LATEST_VERSION_URL = "https://registry.npmjs.org/@october-dev%2foctober/latest";
const OCTOBER_OWNED_URL_PREFIXES = [
	"https://www.october.dev",
	"https://october.dev",
	"https://github.com/october-dev/",
	"https://registry.npmjs.org/@october-dev",
];

// Upstream package names a self-update must never install over October.
export const UPSTREAM_PACKAGE_NAMES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];

// Files that decide where October updates come from. Upstream hosts must not appear in them.
// This list is fixed: a new file that decides update sources is not scanned until it is added here.
export const UPDATE_SURFACE_FILES = [
	"packages/coding-agent/src/config.ts",
	"packages/coding-agent/src/package-manager-cli.ts",
	"packages/coding-agent/src/utils/version-check.ts",
	"packages/coding-agent/src/utils/windows-self-update.ts",
];
const UPSTREAM_ENDPOINT_PATTERNS = [
	/https?:\/\/(?:[a-z0-9-]+\.)*pi\.dev\b/i,
	/github\.com\/(?:badlogic|earendil-works)\/pi(?:-mono)?\b/i,
	/registry\.npmjs\.org\/@(?:earendil-works|mariozechner)\b/i,
];

function isOctoberOwnedUrl(url) {
	return typeof url === "string" && OCTOBER_OWNED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Check package.json identity fields; returns one message per problem. */
export function checkPackageMetadata(pkg) {
	const problems = [];
	if (pkg.name !== OCTOBER_PACKAGE_NAME) {
		problems.push(`package name is ${JSON.stringify(pkg.name)}, expected ${OCTOBER_PACKAGE_NAME}`);
	}
	if (JSON.stringify(pkg.bin) !== JSON.stringify({ october: "dist/cli.js" })) {
		problems.push(`bin is ${JSON.stringify(pkg.bin)}, expected {"october":"dist/cli.js"}`);
	}
	if (pkg.piConfig?.name !== "october" || pkg.piConfig?.configDir !== ".october") {
		problems.push(`piConfig is ${JSON.stringify(pkg.piConfig)}, expected name october and configDir .october`);
	}
	if (pkg.repository?.url !== OCTOBER_REPOSITORY_URL) {
		problems.push(`repository.url is ${JSON.stringify(pkg.repository?.url)}, expected ${OCTOBER_REPOSITORY_URL}`);
	}
	if (!isOctoberOwnedUrl(pkg.homepage)) {
		problems.push(`homepage is ${JSON.stringify(pkg.homepage)}, expected an October-owned URL`);
	}
	if (pkg.bugs?.url !== OCTOBER_BUGS_URL) {
		problems.push(`bugs.url is ${JSON.stringify(pkg.bugs?.url)}, expected ${OCTOBER_BUGS_URL}`);
	}
	return problems;
}

/** Check the identity and update endpoints the running CLI resolves. */
export function checkRuntimeIdentity(runtime) {
	const problems = [];
	if (runtime.packageName !== OCTOBER_PACKAGE_NAME) {
		problems.push(`runtime PACKAGE_NAME is ${runtime.packageName}, expected ${OCTOBER_PACKAGE_NAME}`);
	}
	if (runtime.appName !== "october") problems.push(`runtime APP_NAME is ${runtime.appName}, expected october`);
	if (runtime.configDirName !== ".october") {
		problems.push(`runtime CONFIG_DIR_NAME is ${runtime.configDirName}, expected .october`);
	}
	if (runtime.latestVersionUrl !== OCTOBER_LATEST_VERSION_URL) {
		problems.push(`LATEST_VERSION_URL is ${runtime.latestVersionUrl}, expected ${OCTOBER_LATEST_VERSION_URL}`);
	}
	if (!isOctoberOwnedUrl(runtime.changelogUrl)) {
		problems.push(`UPDATE_CHANGELOG_URL is ${runtime.changelogUrl}, expected an October-owned URL`);
	}
	return problems;
}

/**
 * Self-update must refuse to replace October with an upstream package. Only the planner's own
 * "Refusing to install" error counts as a refusal, so an unrelated exception cannot pass the check.
 */
export function checkSelfUpdateRefusesUpstream(plan) {
	const problems = [];
	for (const packageName of UPSTREAM_PACKAGE_NAMES) {
		try {
			plan({ version: "999.0.0", packageName }, { force: true, currentVersion: "0.0.1", packageName: OCTOBER_PACKAGE_NAME });
			problems.push(`self-update planned an install of ${packageName} over ${OCTOBER_PACKAGE_NAME}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.startsWith("Refusing to install")) {
				problems.push(`self-update failed for ${packageName} without refusing it: ${message}`);
			}
		}
	}
	return problems;
}

/** Find upstream release endpoints in the files that decide where updates come from. */
export function checkUpdateSurfaces(sources) {
	const problems = [];
	for (const [path, text] of Object.entries(sources)) {
		text.split("\n").forEach((line, index) => {
			const pattern = UPSTREAM_ENDPOINT_PATTERNS.find((candidate) => candidate.test(line));
			if (pattern) problems.push(`${path}:${index + 1} references an upstream endpoint: ${line.trim()}`);
		});
	}
	return problems;
}

function main() {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
	const sources = Object.fromEntries(
		UPDATE_SURFACE_FILES.map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]),
	);
	const problems = [
		...checkPackageMetadata(pkg),
		...checkRuntimeIdentity({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
			latestVersionUrl: LATEST_VERSION_URL,
			changelogUrl: UPDATE_CHANGELOG_URL,
		}),
		...checkSelfUpdateRefusesUpstream(planSelfUpdate),
		...checkUpdateSurfaces(sources),
	];
	if (problems.length > 0) {
		console.error("October identity check failed:");
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log("October identity check passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
