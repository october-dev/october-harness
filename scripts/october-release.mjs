#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gt, valid } from "semver";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

export const octoberPackageName = "@october-dev/october";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = join(repoRoot, "packages/coding-agent");

export function validateOctoberManifest(manifest) {
	if (manifest.name !== octoberPackageName) throw new Error("Only @october-dev/october may be published by this script");
	if (!valid(manifest.version) || !/^\d+\.\d+\.\d+-october\.\d+$/.test(manifest.version)) throw new Error("Expected a Pi-based X.Y.Z-october.N version");
	if (manifest.bin?.october !== "dist/cli.js" || Object.keys(manifest.bin).length !== 1) throw new Error("Expected only the october CLI");
	if (manifest.piConfig?.name !== "october" || manifest.piConfig?.configDir !== ".october") throw new Error("Expected October runtime identity");
	return manifest.version;
}

function run(command, args, cwd = repoRoot) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000, shell: process.platform === "win32" });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.status}`);
	return result.stdout;
}

export function inspectOctoberTarball(tarball) {
	const manifest = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
	const version = validateOctoberManifest(manifest);
	const files = new Set(run("tar", ["-tzf", tarball]).trim().split("\n"));
	for (const file of ["dist/cli.js", "dist/index.js", "dist/bundle/cli.js", "npm-shrinkwrap.json", "README.md"]) {
		if (!files.has(`package/${file}`)) throw new Error(`Release tarball is missing ${file}`);
	}
	return { version, integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}` };
}

export function prepareOctoberRelease(output) {
	validateOctoberManifest(JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")));
	if (!existsSync(join(packageDirectory, "dist/bundle/cli.js"))) throw new Error("Build the release before packing");
	const root = output ? resolve(output) : mkdtempSync(join(tmpdir(), "october-release-"));
	if (output) mkdirSync(root); // Refuse to overwrite any existing directory.
	const tarballs = packReleasePackages([{ name: octoberPackageName, directory: packageDirectory }], join(root, "tarballs"));
	const tarball = tarballs.get(octoberPackageName);
	const artifact = inspectOctoberTarball(tarball);
	// No Pi workspace overrides: test the exact upstream dependencies npm users get.
	for (const manager of ["npm", "bun"]) {
		const directory = join(root, manager === "npm" ? "node" : "bun-install");
		installCodingAgentConsumer(directory, tarballs, manager);
		smokeTestCodingAgentConsumer(directory, manager === "npm" ? process.execPath : "bun");
		if (process.platform !== "win32") symlinkSync(join("node_modules", ".bin", "october"), join(directory, "october"));
	}
	console.log(JSON.stringify({ root, tarball, ...artifact }, null, 2));
	return { root, tarball, ...artifact };
}

async function registryVersion(version) {
	const response = await fetch(`https://registry.npmjs.org/@october-dev%2foctober/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(30_000) });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`npm metadata query failed: HTTP ${response.status}`);
	return response.json();
}

async function publishOctoberTarball(tarball) {
	const artifact = inspectOctoberTarball(tarball);
	if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "october-dev/october-harness" || process.env.GITHUB_REF !== `refs/tags/october-v${artifact.version}`) {
		throw new Error("Publish only through publish-october.yml from the matching october-v tag");
	}
	const published = await registryVersion(artifact.version);
	if (published) {
		if (published.dist?.integrity !== artifact.integrity) throw new Error("Version already exists with different contents; never overwrite or silently skip it");
		console.log(`Already published: ${octoberPackageName}@${artifact.version}`);
		return;
	}
	const latest = await registryVersion("latest");
	if (latest && gt(latest.version, artifact.version)) throw new Error("Refusing to move latest backwards");
	console.log(run("npm", ["publish", tarball, "--access", "public", "--tag", "latest", "--provenance", "--ignore-scripts"]));
	const verified = await registryVersion(artifact.version);
	if (verified?.dist?.integrity !== artifact.integrity) throw new Error("Published integrity could not be verified; inspect npm before retrying");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, argument, ...extra] = process.argv.slice(2);
	if (extra.length || !["pack", "inspect", "publish"].includes(command) || (command !== "pack" && !argument)) {
		throw new Error("Usage: node scripts/october-release.mjs pack [new-output-directory] | inspect <tarball> | publish <tarball>");
	}
	if (command === "pack") prepareOctoberRelease(argument);
	else if (command === "inspect") console.log(JSON.stringify(inspectOctoberTarball(resolve(argument)), null, 2));
	else await publishOctoberTarball(resolve(argument));
}
