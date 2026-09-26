import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkPackageMetadata,
	checkRuntimeIdentity,
	checkSelfUpdateRefusesUpstream,
	checkUpdateSurfaces,
	OCTOBER_PACKAGE_NAME,
	UPSTREAM_PACKAGE_NAMES,
} from "./check-october-identity.mjs";

const octoberPackage = {
	name: "@october-dev/october",
	bin: { october: "dist/cli.js" },
	piConfig: { name: "october", configDir: ".october" },
	repository: { type: "git", url: "git+https://github.com/october-dev/october-harness.git" },
	homepage: "https://www.october.dev",
	bugs: { url: "https://github.com/october-dev/october-harness/issues" },
};

const octoberRuntime = {
	packageName: "@october-dev/october",
	appName: "october",
	configDirName: ".october",
	latestVersionUrl: "https://registry.npmjs.org/@october-dev%2foctober/latest",
	changelogUrl: "https://www.october.dev/changelog",
};

test("accepts October package metadata", () => {
	assert.deepEqual(checkPackageMetadata(octoberPackage), []);
});

test("reports each upstream identity field a sync could restore", () => {
	const problems = checkPackageMetadata({
		name: "@earendil-works/pi-coding-agent",
		bin: { pi: "dist/cli.js" },
		piConfig: { name: "pi", configDir: ".pi" },
		repository: { url: "git+https://github.com/earendil-works/pi.git" },
		homepage: "https://pi.dev",
		bugs: { url: "https://github.com/earendil-works/pi/issues" },
	});

	assert.equal(problems.length, 6);
	for (const field of ["package name", "bin", "piConfig", "repository.url", "homepage", "bugs.url"]) {
		assert.ok(
			problems.some((problem) => problem.startsWith(field)),
			`missing ${field} problem`,
		);
	}
});

test("rejects an extra binary next to october", () => {
	const problems = checkPackageMetadata({ ...octoberPackage, bin: { october: "dist/cli.js", pi: "dist/cli.js" } });
	assert.equal(problems.length, 1);
});

test("accepts October runtime identity and update endpoints", () => {
	assert.deepEqual(checkRuntimeIdentity(octoberRuntime), []);
});

test("reports an upstream update feed or changelog", () => {
	const problems = checkRuntimeIdentity({
		...octoberRuntime,
		latestVersionUrl: "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest",
		changelogUrl: "https://pi.dev/changelog",
	});
	assert.equal(problems.length, 2);
});

test("passes when self-update refuses every upstream package", () => {
	const refusingPlan = (release, options) => {
		if (release.packageName !== options.packageName) throw new Error(`Refusing to install ${release.packageName}`);
	};
	assert.deepEqual(checkSelfUpdateRefusesUpstream(refusingPlan), []);
});

test("fails when self-update would install an upstream package over October", () => {
	const permissivePlan = () => ({ shouldRun: true });
	const problems = checkSelfUpdateRefusesUpstream(permissivePlan);
	assert.equal(problems.length, UPSTREAM_PACKAGE_NAMES.length);
	assert.ok(problems.every((problem) => problem.includes(OCTOBER_PACKAGE_NAME)));
});

test("does not count an unrelated error as a refusal", () => {
	const brokenPlan = () => {
		throw new TypeError("Cannot read properties of undefined");
	};
	const problems = checkSelfUpdateRefusesUpstream(brokenPlan);
	assert.equal(problems.length, UPSTREAM_PACKAGE_NAMES.length);
	assert.ok(problems.every((problem) => problem.includes("without refusing it")));
});

test("flags upstream release endpoints in update code with their location", () => {
	const problems = checkUpdateSurfaces({
		"a.ts": 'const ok = "https://www.october.dev/changelog";\nconst base = "https://pi.dev/api/installer/releases";',
		"b.ts": 'const repo = "https://github.com/earendil-works/pi/releases/latest";',
		"c.ts": 'const feed = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";',
	});

	assert.equal(problems.length, 3);
	assert.ok(problems[0].startsWith("a.ts:2 "));
	assert.ok(problems[1].startsWith("b.ts:1 "));
	assert.ok(problems[2].startsWith("c.ts:1 "));
});

test("does not flag October-owned endpoints or upstream workspace package imports", () => {
	const problems = checkUpdateSurfaces({
		"a.ts": [
			'import { Markdown } from "@earendil-works/pi-tui";',
			'const releases = "https://github.com/october-dev/october-harness/releases/latest";',
			'const feed = "https://registry.npmjs.org/@october-dev%2foctober/latest";',
		].join("\n"),
	});
	assert.deepEqual(problems, []);
});
