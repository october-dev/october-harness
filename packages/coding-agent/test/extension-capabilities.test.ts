import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatCapabilitySummary,
	getSidecarManifestPath,
	readCapabilityManifest,
	validateCapabilityManifest,
} from "../src/core/extensions/capabilities.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";

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

		it("reports every problem with its field", () => {
			const result = validateCapabilityManifest({
				manifestVersion: 2,
				filesystem: { read: "everything", execute: "any" },
				shell: "yes",
				network: ["bad host!", "ok.example.com", "ok.example.com"],
				environment: ["1BAD"],
				credentials: [""],
				octoberBus: 1,
				sandbox: true,
			});
			expect(result.errors).toEqual(
				expect.arrayContaining([
					"sandbox: unknown field",
					"manifestVersion: must be 1, got 2",
					"filesystem.read: must be one of none, project, any",
					"filesystem.execute: unknown field",
					"shell: must be a boolean",
					"octoberBus: must be a boolean",
					'network: invalid entry "bad host!"',
					"network: contains duplicate entries",
					'environment: invalid entry "1BAD"',
					"credentials: must be an array of non-empty strings",
				]),
			);
		});

		it("rejects non-objects and a missing version", () => {
			expect(validateCapabilityManifest([]).errors).toEqual(["manifest: must be an object"]);
			expect(validateCapabilityManifest({}).errors).toEqual(["manifestVersion: must be 1, got null"]);
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

	describe("presentation", () => {
		it("summarizes declared capabilities and distinguishes omitted from none", () => {
			const lines = formatCapabilitySummary({
				status: "declared",
				source: "x",
				manifest: { manifestVersion: 1, filesystem: { read: "project" }, network: [], shell: true },
			});
			expect(lines).toEqual([
				"Filesystem: read project, write not declared",
				"Shell: runs commands",
				"Network: none",
				"Environment: not declared",
				"Credentials: not declared",
				"October Bus: not declared",
				"Declared by the extension author; this is disclosure, not a sandbox.",
			]);
		});

		it("marks extensions without a manifest as unclassified, not safe", () => {
			expect(formatCapabilitySummary({ status: "unclassified" })).toEqual([
				"Unclassified: no capability manifest. It may use any capability the host allows.",
			]);
		});

		it("lists every validation problem for an invalid manifest", () => {
			expect(formatCapabilitySummary({ status: "invalid", source: "m.json", errors: ["a: x", "b: y"] })).toEqual([
				"Invalid capability manifest (m.json):",
				"  a: x",
				"  b: y",
			]);
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
			expect(result.errors[0].error).toContain("shell: must be a boolean");
			expect(fs.existsSync(marker)).toBe(false);
		});

		it("attaches a declared manifest to the loaded extension", async () => {
			const marker = path.join(tempDir, "executed.txt");
			const entry = write("ext/declared.ts", markerExtension(marker));
			write("ext/declared.capabilities.json", fullManifest);

			const result = await discoverAndLoadExtensions([entry], tempDir, path.join(tempDir, "agent"));

			expect(result.errors).toHaveLength(0);
			expect(result.extensions[0].capabilities).toMatchObject({ status: "declared", manifest: fullManifest });
			expect(fs.existsSync(marker)).toBe(true);
		});

		it("loads an extension without a manifest as unclassified", async () => {
			const entry = write("ext/plain.ts", markerExtension(path.join(tempDir, "executed.txt")));

			const result = await discoverAndLoadExtensions([entry], tempDir, path.join(tempDir, "agent"));

			expect(result.errors).toHaveLength(0);
			expect(result.extensions[0].capabilities).toEqual({ status: "unclassified" });
		});
	});
});
