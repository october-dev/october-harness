import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSidecarManifestPath,
	readCapabilityManifest,
	validateCapabilityManifest,
} from "../src/core/extensions/capabilities.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// #7: extension capability manifests are read and validated before extension code runs.
describe("extension capability manifests", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-capabilities-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const fullManifest = {
		manifestVersion: 1,
		filesystem: { read: "project", write: "none" },
		shell: false,
		network: ["api.example.com", "*.example.org:8443"],
		environment: ["EXAMPLE_API_KEY"],
		credentials: ["anthropic"],
		octoberBus: true,
	};

	function write(relativePath: string, content: string | object): string {
		const filePath = path.join(tempDir, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content));
		return filePath;
	}

	// Writes a marker when its module body executes, so tests can prove code did or did not run.
	function markerExtension(marker: string): string {
		return `
			import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function(pi) {
				pi.registerCommand("capability-test", { handler: async () => {} });
			}
		`;
	}

	describe("validation", () => {
		it("accepts a complete manifest and a minimal one", () => {
			expect(validateCapabilityManifest(fullManifest)).toEqual({ manifest: fullManifest });
			expect(validateCapabilityManifest({ manifestVersion: 1 })).toEqual({ manifest: { manifestVersion: 1 } });
		});

		it("reports problems by field", () => {
			// TypeBox stops after its global maxErrors (8) raw errors, so problems are split across two manifests.
			expect(
				validateCapabilityManifest({
					manifestVersion: 2,
					filesystem: { read: "everything", execute: "any" },
					shell: "yes",
					sandbox: true,
				}).errors,
			).toEqual(
				expect.arrayContaining([
					"sandbox: unknown field",
					"manifestVersion: must be 1",
					"filesystem.read: must be one of none, project, any",
					"filesystem.execute: unknown field",
					"shell: must be boolean",
				]),
			);
			expect(
				validateCapabilityManifest({
					manifestVersion: 1,
					network: ["bad host!", "ok.example.com", "ok.example.com"],
					environment: ["1BAD"],
					credentials: [""],
					octoberBus: 1,
				}).errors,
			).toEqual([
				'network.0: invalid entry "bad host!"',
				"network: must not have duplicate items",
				'environment.0: invalid entry "1BAD"',
				"credentials.0: must not have fewer than 1 characters",
				"octoberBus: must be boolean",
			]);
		});

		it("rejects non-objects and a missing version", () => {
			expect(validateCapabilityManifest([]).errors).toEqual(["manifest: must be object"]);
			expect(validateCapabilityManifest({}).errors).toEqual(["manifestVersion: is required"]);
		});
	});

	describe("reading", () => {
		it("derives the sidecar path from the entry file", () => {
			expect(getSidecarManifestPath("/x/my-ext.ts")).toBe("/x/my-ext.capabilities.json");
			expect(getSidecarManifestPath("/x/my-ext/index.js")).toBe("/x/my-ext/index.capabilities.json");
		});

		it("reads a sidecar manifest for a single-file extension", () => {
			const entry = write("ext/solo.ts", "export default () => {}");
			write("ext/solo.capabilities.json", fullManifest);
			expect(readCapabilityManifest(entry)).toEqual({
				status: "declared",
				manifest: fullManifest,
				source: path.join(tempDir, "ext/solo.capabilities.json"),
			});
		});

		it("reads pi.capabilities from the package that lists the extension", () => {
			write("pkg/package.json", { name: "pkg", pi: { extensions: ["./src/main.ts"], capabilities: fullManifest } });
			const entry = write("pkg/src/main.ts", "export default () => {}");
			const disclosure = readCapabilityManifest(entry);
			expect(disclosure).toEqual({
				status: "declared",
				manifest: fullManifest,
				source: `${path.join(tempDir, "pkg/package.json")}#pi.capabilities`,
			});
		});

		it("does not attribute an unrelated package.json above a single-file extension", () => {
			write("project/package.json", { name: "project", pi: { capabilities: fullManifest } });
			const entry = write("project/.pi/extensions/local.ts", "export default () => {}");
			expect(readCapabilityManifest(entry)).toEqual({ status: "unclassified" });
		});

		it("reads pi.capabilities for an entry in the conventional extensions/ directory", () => {
			write("pkg/package.json", { name: "pkg", pi: { capabilities: fullManifest } });
			const entry = write("pkg/extensions/foo.ts", "export default () => {}");
			expect(readCapabilityManifest(entry)).toMatchObject({ status: "declared", manifest: fullManifest });
		});

		it("does not use the conventional directory when pi.extensions lists other entries", () => {
			write("pkg/package.json", { name: "pkg", pi: { extensions: ["./src/main.ts"], capabilities: fullManifest } });
			const entry = write("pkg/extensions/other.ts", "export default () => {}");
			expect(readCapabilityManifest(entry)).toEqual({ status: "unclassified" });
		});

		it("treats a manifest declared in two places as invalid", () => {
			write("pkg/package.json", { name: "pkg", pi: { extensions: ["./index.ts"], capabilities: fullManifest } });
			const entry = write("pkg/index.ts", "export default () => {}");
			write("pkg/index.capabilities.json", fullManifest);
			const disclosure = readCapabilityManifest(entry);
			expect(disclosure.status).toBe("invalid");
		});

		it("reports unreadable JSON as invalid", () => {
			const entry = write("ext/broken.ts", "export default () => {}");
			write("ext/broken.capabilities.json", "{ not json");
			const disclosure = readCapabilityManifest(entry);
			expect(disclosure.status).toBe("invalid");
			expect(disclosure.status === "invalid" && disclosure.errors[0]).toMatch(/^manifest: cannot be read as JSON/);
		});

		it("returns unclassified when no manifest exists", () => {
			expect(readCapabilityManifest(write("ext/plain.ts", "export default () => {}"))).toEqual({
				status: "unclassified",
			});
		});
	});

	describe("loading", () => {
		it("never executes an extension whose manifest is invalid", async () => {
			const marker = path.join(tempDir, "executed.txt");
			const entry = write("ext/guarded.ts", markerExtension(marker));
			write("ext/guarded.capabilities.json", { manifestVersion: 1, shell: "sometimes" });

			const result = await discoverAndLoadExtensions([entry], tempDir, path.join(tempDir, "agent"));

			expect(result.extensions).toHaveLength(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].error).toContain("Invalid capability manifest");
			expect(result.errors[0].error).toContain("shell: must be boolean");
			expect(fs.existsSync(marker)).toBe(false);
		});

		it("loads an extension whose manifest is valid", async () => {
			const marker = path.join(tempDir, "executed.txt");
			const entry = write("ext/declared.ts", markerExtension(marker));
			write("ext/declared.capabilities.json", fullManifest);

			const result = await discoverAndLoadExtensions([entry], tempDir, path.join(tempDir, "agent"));

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(fs.existsSync(marker)).toBe(true);
		});

		it("loads an extension without a manifest", async () => {
			const marker = path.join(tempDir, "executed.txt");
			const entry = write("ext/plain.ts", markerExtension(marker));

			const result = await discoverAndLoadExtensions([entry], tempDir, path.join(tempDir, "agent"));

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(fs.existsSync(marker)).toBe(true);
		});

		it("keeps a convention-layout package's extensions when it declares pi.capabilities", async () => {
			const pkgDir = path.join(tempDir, "pkg");
			write("pkg/package.json", { name: "pkg", pi: { capabilities: { manifestVersion: 1, shell: false } } });
			const entry = write("pkg/extensions/foo.ts", "export default () => {}");
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setPackages([pkgDir]);
			const packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir: path.join(tempDir, "agent"),
				settingsManager,
			});

			const resolved = await packageManager.resolve();

			expect(resolved.extensions.map((resource) => resource.path)).toEqual([entry]);
			expect(readCapabilityManifest(entry)).toMatchObject({ status: "declared" });
		});
	});
});
