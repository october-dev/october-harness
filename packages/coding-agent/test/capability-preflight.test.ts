import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCapabilityManifest } from "../src/core/extensions/capabilities.ts";
import {
	acknowledgeCapabilities,
	capabilityFingerprint,
	capabilityPreflightReason,
	formatCapabilityDetails,
	formatCapabilitySummary,
	planCapabilityPreflight,
	readCapabilityPreflightStore,
	recordCapabilityInspection,
	registerCapabilityInspection,
} from "../src/core/extensions/capability-preflight.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getResourcePathKey } from "../src/core/source-info.ts";
import { resolvePath } from "../src/utils/paths.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "october-capability-"));
	directories.push(directory);
	return directory;
}

function write(directory: string, relativePath: string, content: string): string {
	const filePath = join(directory, relativePath);
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

describe("capability preflight", () => {
	it("describes declared use and does not call an unclassified extension safe", () => {
		const directory = tempDir();
		const declaredPath = write(directory, "declared.ts", "export default function () {}");
		write(
			directory,
			"declared.capabilities.json",
			JSON.stringify({ manifestVersion: 1, shell: true, network: ["api.example.com"] }),
		);
		const declared = readCapabilityManifest(declaredPath);
		expect(formatCapabilitySummary(declaredPath, declared)).toContain("shell");
		expect(formatCapabilitySummary(declaredPath, declared)).toContain("api.example.com");
		expect(formatCapabilitySummary(declaredPath, declared)).toContain("not a sandbox");
		expect(formatCapabilityDetails(declaredPath, declared)).toContain('"shell": true');

		const unclassifiedPath = write(directory, "plain.ts", "export default function () {}");
		const unclassified = readCapabilityManifest(unclassifiedPath);
		const summary = formatCapabilitySummary(unclassifiedPath, unclassified);
		expect(summary).toContain("unclassified");
		expect(summary).toContain("not treated as safe");
	});

	it("asks only for project-owned and installed extensions, again when the manifest changes", () => {
		expect(capabilityPreflightReason({ source: "auto", scope: "project", origin: "top-level" })).toBe("project");
		expect(capabilityPreflightReason({ source: "npm:example", scope: "user", origin: "package" })).toBe("installed");
		expect(capabilityPreflightReason({ source: "auto", scope: "user", origin: "top-level" })).toBeUndefined();
		expect(capabilityPreflightReason({ source: "cli", scope: "temporary", origin: "top-level" })).toBeUndefined();

		const directory = tempDir();
		const projectPath = write(directory, "project.ts", "export default function () {}");
		write(directory, "project.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: false }));
		const installedPath = write(directory, "installed.ts", "export default function () {}");
		const userPath = write(directory, "user.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([
			[projectPath, { source: "auto", scope: "project", origin: "top-level" }],
			[installedPath, { source: "npm:example", scope: "user", origin: "package" }],
			[userPath, { source: "auto", scope: "user", origin: "top-level" }],
		]);
		const first = planCapabilityPreflight([projectPath, installedPath, userPath], metadata, {});
		expect(first.ready).toEqual([userPath]);
		expect(first.pending.map((item) => item.path)).toEqual([projectPath, installedPath]);
		expect(first.pending[1]?.summary).toContain("unclassified");

		const fingerprint = capabilityFingerprint(readCapabilityManifest(projectPath));
		const remembered = planCapabilityPreflight([projectPath], metadata, {
			[getResourcePathKey(resolvePath(projectPath))]: fingerprint,
		});
		expect(remembered.pending).toEqual([]);

		write(directory, "project.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: true }));
		const changed = planCapabilityPreflight([projectPath], metadata, {
			[getResourcePathKey(resolvePath(projectPath))]: fingerprint,
		});
		expect(changed.pending).toHaveLength(1);
		expect(changed.pending[0]?.fingerprint).not.toBe(fingerprint);
	});

	it("skips extension code when preflight declines and remembers an acceptance", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const marker = join(cwd, "executed.txt");
		write(
			cwd,
			".october/extensions/demo.ts",
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function () {}`,
		);
		write(
			cwd,
			".october/extensions/demo.capabilities.json",
			JSON.stringify({ manifestVersion: 1, octoberBus: true }),
		);
		const seen: string[] = [];
		const decline = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			capabilityPreflight: async (items) => {
				expect(existsSync(marker)).toBe(false);
				seen.push(...items.map((item) => item.summary));
				return items.map((item) => ({ path: item.path, accept: false }));
			},
		});
		await decline.reload();
		expect(existsSync(marker)).toBe(false);
		expect(seen.some((summary) => summary.includes("October Bus"))).toBe(true);
		expect(decline.getExtensions().errors.some((error) => error.error.includes("before loading its code"))).toBe(
			true,
		);

		let prompts = 0;
		const accept = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			capabilityPreflight: async (items) => {
				prompts += 1;
				expect(existsSync(marker)).toBe(false);
				return items.map((item) => ({ path: item.path, accept: true }));
			},
		});
		await accept.reload();
		expect(existsSync(marker)).toBe(true);
		expect(prompts).toBe(1);
		await accept.reload();
		expect(prompts).toBe(1);
		expect(
			readCapabilityPreflightStore(agentDir).entries.some(
				(entry) => entry.acknowledged && entry.details.includes("octoberBus"),
			),
		).toBe(true);
	});

	it("prints the stored manifest from /capabilities", async () => {
		const agentDir = tempDir();
		const extensionPath = write(agentDir, "extensions/demo.ts", "export default function () {}");
		write(agentDir, "extensions/demo.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: true }));
		const metadata = new Map<string, PathMetadata>([
			[extensionPath, { source: "npm:demo", scope: "user", origin: "package" }],
		]);
		const plan = planCapabilityPreflight([extensionPath], metadata, {});
		recordCapabilityInspection(agentDir, plan.pending, {});
		acknowledgeCapabilities(agentDir, plan.pending);
		const notify = { calls: [] as string[] };
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerCapabilityInspection(pi, agentDir)],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({
				notify: (message: string) => {
					notify.calls.push(message);
				},
			}),
		});
		await harness.session.prompt("/capabilities");
		expect(notify.calls.at(-1)).toContain("remembered installed");
		await harness.session.prompt("/capabilities demo");
		expect(notify.calls.at(-1)).toContain('"shell": true');
		expect(notify.calls.at(-1)).toContain("not an operating-system sandbox");
	});
});
