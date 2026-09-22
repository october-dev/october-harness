import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOctoberManifest, verifyPublishedOctoberTarball } from "./october-release.mjs";

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

const artifact = { version: manifest.version, integrity: "sha512-original-tarball" };
const published = { name: manifest.name, version: manifest.version, dist: { integrity: artifact.integrity } };

test("published October integrity succeeds without waiting when metadata is available", async () => {
	const result = await verifyPublishedOctoberTarball(artifact, {
		lookup: async (version) => {
			assert.equal(version, artifact.version);
			return published;
		},
		wait: async () => assert.fail("Must not wait after successful verification"),
	});
	assert.equal(result, published);
});

test("published October integrity waits for registry propagation and transient failures", async () => {
	let queries = 0;
	const waits = [];
	const result = await verifyPublishedOctoberTarball(artifact, {
		lookup: async () => {
			queries++;
			if (queries === 1) return undefined;
			if (queries === 2) throw new Error("Registry unavailable");
			if (queries === 3) return { ...published, dist: {} };
			return published;
		},
		wait: async (milliseconds) => { waits.push(milliseconds); },
	});
	assert.equal(result, published);
	assert.equal(queries, 4);
	assert.deepEqual(waits, [5_000, 5_000, 5_000]);
});

test("published October integrity never retries or accepts different contents", async () => {
	await assert.rejects(verifyPublishedOctoberTarball(artifact, {
		lookup: async () => ({ ...published, dist: { integrity: "sha512-rebuilt-tarball" } }),
		wait: async () => assert.fail("Must not retry an integrity mismatch"),
	}), /different contents/);
});

test("published October integrity rejects another package or version", async () => {
	for (const metadata of [{ ...published, name: "other-package" }, { ...published, version: "0.85.1-october.2" }]) {
		await assert.rejects(verifyPublishedOctoberTarball(artifact, {
			lookup: async () => metadata,
			wait: async () => assert.fail("Must not retry an identity mismatch"),
		}), /package identity/);
	}
});

test("published October verification stops after bounded retries", async () => {
	for (const metadata of [undefined, { ...published, dist: {} }]) {
		let queries = 0;
		let waits = 0;
		await assert.rejects(verifyPublishedOctoberTarball(artifact, {
			lookup: async () => { queries++; return metadata; },
			wait: async () => { waits++; },
			attempts: 3,
		}), /inspect npm before retrying/);
		assert.equal(queries, 3);
		assert.equal(waits, 2);
	}
});

test("published October verification preserves the last registry error", async () => {
	const error = new Error("Registry connection failed");
	await assert.rejects(verifyPublishedOctoberTarball(artifact, {
		lookup: async () => { throw error; },
		wait: async () => assert.fail("Must not wait after the final attempt"),
		attempts: 1,
	}), (failure) => failure.cause === error && /inspect npm/.test(failure.message));
});
