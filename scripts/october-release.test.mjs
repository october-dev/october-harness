import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOctoberManifest } from "./october-release.mjs";

const manifest = {
	name: "@october-dev/october", version: "0.85.1-october.1",
	bin: { october: "dist/cli.js" }, piConfig: { name: "october", configDir: ".october" },
};

test("October publishing has a single-package allowlist", () => {
	assert.equal(validateOctoberManifest(manifest), manifest.version);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "another-package"]) {
		assert.throws(() => validateOctoberManifest({ ...manifest, name }), /Only @october-dev/);
	}
});

test("October publishing rejects upstream versions and incorrect CLI identity", () => {
	for (const version of ["0.85.1", "latest", "0.85.1-october.01"]) {
		assert.throws(() => validateOctoberManifest({ ...manifest, version }), /version/);
	}
	assert.throws(() => validateOctoberManifest({ ...manifest, bin: { pi: "dist/cli.js" } }), /CLI/);
	assert.throws(() => validateOctoberManifest({ ...manifest, piConfig: { name: "pi" } }), /identity/);
});
