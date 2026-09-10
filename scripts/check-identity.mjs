#!/usr/bin/env node
/**
 * October identity regression check.
 *
 * Upstream (Pi) release commits touch the same metadata and update surfaces as
 * the downstream October package. A merge can pass type checks while restoring
 * Pi names, binaries, or release endpoints. This script asserts the October
 * identity is intact. Run from `npm run check` (check:identity).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_PACKAGE_NAME = "@october-dev/october";
const EXPECTED_REPO = "github.com/october-dev/october-harness";
const EXPECTED_HOST = "october.dev";

let failures = 0;

function fail(message) {
	failures += 1;
	console.error(`identity check FAIL: ${message}`);
}

function check(label, ok, detail) {
	if (ok) {
		console.log(`ok: ${label}`);
	} else {
		fail(`${label} — ${detail}`);
	}
}

// --- package.json metadata ---------------------------------------------------

const pkgPath = join(root, "packages/coding-agent/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

check(
	"package name is @october-dev/october",
	pkg.name === EXPECTED_PACKAGE_NAME,
	`packages/coding-agent/package.json name is ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(EXPECTED_PACKAGE_NAME)}`,
);

check(
	"october bin points to dist/cli.js",
	pkg.bin?.october === "dist/cli.js",
	`bin.october is ${JSON.stringify(pkg.bin?.october)}, expected "dist/cli.js"`,
);

check(
	"repository url is October-owned",
	typeof pkg.repository?.url === "string" && pkg.repository.url.includes(EXPECTED_REPO),
	`repository.url is ${JSON.stringify(pkg.repository?.url)}, expected it to contain ${EXPECTED_REPO}`,
);

check(
	"homepage is October-owned",
	typeof pkg.homepage === "string" && pkg.homepage.includes(EXPECTED_HOST),
	`homepage is ${JSON.stringify(pkg.homepage)}, expected it to contain ${EXPECTED_HOST}`,
);

check(
	"bugs url is October-owned",
	typeof pkg.bugs?.url === "string" && pkg.bugs.url.includes(EXPECTED_REPO),
	`bugs.url is ${JSON.stringify(pkg.bugs?.url)}, expected it to contain ${EXPECTED_REPO}`,
);

check(
	"piConfig name is october",
	pkg.piConfig?.name === "october",
	`piConfig.name is ${JSON.stringify(pkg.piConfig?.name)}, expected "october"`,
);

check(
	"piConfig configDir is .october",
	pkg.piConfig?.configDir === ".october",
	`piConfig.configDir is ${JSON.stringify(pkg.piConfig?.configDir)}, expected ".october"`,
);

// --- self-update surfaces ----------------------------------------------------
// The self-update flow reads its feed URL, changelog URL, and fallback package
// name from source. If an upstream merge restores Pi endpoints or the upstream
// package name here, October installs would phone home to (or be replaced by)
// the upstream project.

const versionCheckPath = join(root, "packages/coding-agent/src/utils/version-check.ts");
const versionCheck = readFileSync(versionCheckPath, "utf-8");

check(
	"latest-version feed is October-owned",
	/https:\/\/www\.october\.dev\/api\/cli\/latest-version/.test(versionCheck),
	`LATEST_VERSION_URL in ${versionCheckPath} does not point at www.october.dev`,
);

check(
	"update changelog url is October-owned",
	/https:\/\/www\.october\.dev\/changelog/.test(versionCheck),
	`UPDATE_CHANGELOG_URL in ${versionCheckPath} does not point at www.october.dev`,
);

check(
	"self-update refuses foreign packages",
	versionCheck.includes("Refusing to install") && versionCheck.includes("isSelfUpdatePackage"),
	`planSelfUpdate in ${versionCheckPath} lost its guard against advertised packageName != this install`,
);

const configPath = join(root, "packages/coding-agent/src/config.ts");
const config = readFileSync(configPath, "utf-8");

check(
	"fallback PACKAGE_NAME is @october-dev/october",
	config.includes(`pkg.name || "${EXPECTED_PACKAGE_NAME}"`),
	`PACKAGE_NAME fallback in ${configPath} is not "${EXPECTED_PACKAGE_NAME}"`,
);

check(
	"binary release url is October-owned",
	config.includes(`https://${EXPECTED_REPO}/releases/latest`),
	`bun-binary release URL in ${configPath} does not point at ${EXPECTED_REPO}/releases/latest`,
);

// --- result ------------------------------------------------------------------

if (failures > 0) {
	console.error(`\n${failures} October identity check(s) failed.`);
	console.error("An upstream sync likely restored Pi identity. Restore the October values above.");
	process.exit(1);
}
console.log("\nOctober identity check passed.");
