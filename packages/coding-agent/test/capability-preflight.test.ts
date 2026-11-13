import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { createCapabilityPreflightHost } from "../src/cli/capability-preflight.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { readCapabilityManifest } from "../src/core/extensions/capabilities.ts";
import {
	acknowledgeCapabilities,
	CAPABILITY_LOAD_CHOICE,
	CAPABILITY_SKIP_CHOICE,
	CAPABILITY_SKIP_RECOVERY_HINT,
	CAPABILITY_SKIP_WARNING_PREFIX,
	capabilityFingerprint,
	capabilityPreflightReason,
	clearCapabilityDeclinesForTests,
	formatCapabilityDetails,
	formatCapabilityDisclosureDetails,
	formatCapabilityDisclosureTitle,
	formatCapabilityInspection,
	formatCapabilitySummary,
	planCapabilityPreflight,
	readCapabilityPreflightStore,
	recordCapabilityInspection,
	registerCapabilityInspection,
} from "../src/core/extensions/capability-preflight.ts";
import { emitProjectTrustEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { flushRawStdout } from "../src/core/output-guard.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getResourcePathKey, type SourceInfo } from "../src/core/source-info.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { OCTOBER_DEFAULT_PACKAGES } from "../src/extensions/october/default-packages.ts";
import { main } from "../src/main.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { resolvePath } from "../src/utils/paths.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const { mockShowStartupSelector } = vi.hoisted(() => ({ mockShowStartupSelector: vi.fn() }));
vi.mock("../src/cli/startup-ui.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cli/startup-ui.ts")>();
	return { ...actual, showStartupSelector: mockShowStartupSelector };
});

const directories: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	clearCapabilityDeclinesForTests();
	mockShowStartupSelector.mockReset();
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

function projectMetadata(entryPath: string): [string, PathMetadata] {
	return [entryPath, { source: "auto", scope: "project", origin: "top-level" }];
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
		expect(first.skipped).toEqual([]);
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

	// #7: duplicate entry names stay distinguishable; project paths are project-relative.
	it("identifies installed extensions by package source and project extensions by relative path", () => {
		const directory = tempDir();
		const packageRootA = join(directory, "pkg-a");
		const packageRootB = join(directory, "pkg-b");
		const entryA = write(directory, "pkg-a/dist/index.ts", "export default function () {}");
		const entryB = write(directory, "pkg-b/dist/index.ts", "export default function () {}");
		const projectPath = write(directory, "project/.october/extensions/demo.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([
			[entryA, { source: "npm:example-a@1.0.0", scope: "user", origin: "package", packageRoot: packageRootA }],
			[entryB, { source: "npm:example-b@2.0.0", scope: "user", origin: "package", packageRoot: packageRootB }],
			[projectPath, { source: "auto", scope: "project", origin: "top-level" }],
		]);
		const plan = planCapabilityPreflight(
			[entryA, entryB, projectPath],
			metadata,
			{},
			{
				cwd: join(directory, "project"),
			},
		);
		expect(plan.pending).toHaveLength(3);
		const identities = plan.pending.map((item) => item.identity);
		expect(new Set(identities).size).toBe(3);
		expect(identities[0]).toBe(`npm:example-a@1.0.0 (${join("dist", "index.ts")})`);
		expect(identities[1]).toBe(`npm:example-b@2.0.0 (${join("dist", "index.ts")})`);
		expect(identities[2]).toBe(join(".october", "extensions", "demo.ts"));
		expect(plan.pending[0]?.summary).toContain("npm:example-a@1.0.0");
		expect(plan.pending[2]?.summary).toContain(join(".october", "extensions", "demo.ts"));
	});

	// #7: the six default packages stay within disclosure coverage with distinct identities.
	it("discloses every default package with a distinct identity", () => {
		const directory = tempDir();
		expect(OCTOBER_DEFAULT_PACKAGES).toHaveLength(6);
		const entries = OCTOBER_DEFAULT_PACKAGES.map((pkg, index) => {
			const packageRoot = join(directory, `defaults/pkg-${index}`);
			const entry = write(directory, `defaults/pkg-${index}/dist/index.js`, "export default function () {}");
			return { entry, source: pkg.source, packageRoot };
		});
		const metadata = new Map<string, PathMetadata>(
			entries.map(({ entry, source, packageRoot }) => [
				entry,
				{ source, scope: "user", origin: "package", packageRoot },
			]),
		);
		const plan = planCapabilityPreflight(
			entries.map((item) => item.entry),
			metadata,
			{},
		);
		expect(plan.pending).toHaveLength(6);
		expect(new Set(plan.pending.map((item) => item.identity)).size).toBe(6);
		for (const [position, item] of plan.pending.entries()) {
			expect(item.identity).toContain(entries[position]?.source ?? "");
			expect(item.disclosure.status).toBe("unclassified");
		}
	});

	// #7: the choice title stays short; the whole pending set plus the current full
	// disclosure print where they can scroll.
	it("presents a short choice with scrollable full disclosure", () => {
		const directory = tempDir();
		const entryA = write(directory, "pkg-a/index.ts", "export default function () {}");
		const entryB = write(directory, "pkg-b/index.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([
			[entryA, { source: "npm:example-a@1.0.0", scope: "user", origin: "package" }],
			[entryB, { source: "npm:example-b@2.0.0", scope: "user", origin: "package" }],
		]);
		const plan = planCapabilityPreflight([entryA, entryB], metadata, {});
		expect(plan.pending).toHaveLength(2);
		const first = formatCapabilityDisclosureTitle(plan.pending, 0);
		expect(first).toContain("1 of 2");
		expect(first).toContain("npm:example-a@1.0.0");
		expect(first).not.toContain("npm:example-b@2.0.0");
		expect(first).not.toContain(plan.pending[0]?.details ?? "missing");
		expect(first).toContain("scroll to review");
		const second = formatCapabilityDisclosureTitle(plan.pending, 1);
		expect(second).toContain("2 of 2");
		expect(second).toContain("npm:example-b@2.0.0");
		expect(second).not.toContain("npm:example-a@1.0.0");

		const details = formatCapabilityDisclosureDetails(plan.pending, 0);
		expect(details).toContain("1 of 2");
		expect(details).toContain("npm:example-a@1.0.0");
		expect(details).toContain("npm:example-b@2.0.0");
		expect(details).toContain(plan.pending[0]?.details ?? "missing");
	});

	// #7: Skip continues without the extension: no load error, no code execution.
	it("skips without an error when preflight declines and remembers the decline for the process", async () => {
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
		let prompts = 0;
		const makeLoader = () =>
			new DefaultResourceLoader({
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
					seen.push(...items.map((item) => item.summary));
					return items.map((item) => ({ path: item.path, accept: false }));
				},
			});
		const first = makeLoader();
		await first.reload();
		expect(existsSync(marker)).toBe(false);
		expect(seen.some((summary) => summary.includes("October Bus"))).toBe(true);
		expect(first.getExtensions().errors).toEqual([]);
		const warnings = first.getExtensions().warnings ?? [];
		expect(warnings.some((warning) => warning.warning.startsWith(CAPABILITY_SKIP_WARNING_PREFIX))).toBe(true);

		// A second load in the same process does not prompt again for the declined manifest.
		await first.reload();
		expect(prompts).toBe(1);
		// A fresh loader, as built for /new, /fork and /resume, does not prompt again either.
		const second = makeLoader();
		await second.reload();
		expect(prompts).toBe(1);
		expect(existsSync(marker)).toBe(false);
		expect(second.getExtensions().errors).toEqual([]);

		// A changed manifest asks again.
		write(
			cwd,
			".october/extensions/demo.capabilities.json",
			JSON.stringify({ manifestVersion: 1, octoberBus: false }),
		);
		const third = makeLoader();
		await third.reload();
		expect(prompts).toBe(2);
	});

	// #7
	it("remembers an acceptance", async () => {
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
		expect(accept.getExtensions().errors).toEqual([]);
		await accept.reload();
		expect(prompts).toBe(1);
		expect(
			readCapabilityPreflightStore(agentDir).entries.some(
				(entry) => entry.acknowledged && entry.details.includes("octoberBus"),
			),
		).toBe(true);
	});

	// #7: a decline in the pre-trust pass is not prompted again in the final pass.
	it("prompts once per extension across the pre-trust and final passes", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const packageRoot = join(tempDir(), "user-package");
		const installedMarker = join(cwd, "installed-executed.txt");
		const projectMarker = join(cwd, "project-executed.txt");
		mkdirSync(join(packageRoot, "extensions"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "user-package", version: "1.0.0" }));
		writeFileSync(
			join(packageRoot, "extensions", "installed.ts"),
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(installedMarker)}, "executed");
			export default function () {}`,
		);
		write(
			cwd,
			".october/extensions/project.ts",
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(projectMarker)}, "executed");
			export default function () {}`,
		);
		write(cwd, ".october/settings.json", JSON.stringify({}));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const calls: string[][] = [];
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			capabilityPreflight: async (items) => {
				calls.push(items.map((item) => basename(item.path)));
				// Decline the installed package; accept the project extension.
				return items.map((item) => ({
					path: item.path,
					accept: basename(item.path) === "project.ts",
				}));
			},
		});
		await loader.reload({ resolveProjectTrust: async () => true });
		expect(calls).toEqual([["installed.ts"], ["project.ts"]]);
		expect(loader.getExtensions().errors).toEqual([]);
		expect(existsSync(installedMarker)).toBe(false);
		expect(existsSync(projectMarker)).toBe(true);
		const warnings = loader.getExtensions().warnings ?? [];
		expect(
			warnings.some(
				(warning) =>
					warning.path.endsWith("installed.ts") && warning.warning.startsWith(CAPABILITY_SKIP_WARNING_PREFIX),
			),
		).toBe(true);
	});

	// #7: disclosure preserves extension order and project_trust precedence.
	it("keeps the original load order for a pending extension ahead of a remembered one", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const marker = join(cwd, "order.txt");
		const extDir = join(cwd, ".october", "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "alpha.ts"), "export default function () {}");
		writeFileSync(join(extDir, "beta.ts"), "export default function () {}");
		// Discovery follows directory order; make the first entry pending and remember the second.
		const [firstName, secondName] = readdirSync(extDir).filter((name) => name.endsWith(".ts"));
		const firstPath = join(extDir, firstName ?? "");
		const secondPath = join(extDir, secondName ?? "");
		writeFileSync(
			firstPath,
			`import { appendFileSync } from "node:fs";
			appendFileSync(${JSON.stringify(marker)}, "first\\n");
			export default function (pi) {
				pi.on("project_trust", () => ({ trusted: "no" }));
			}`,
		);
		writeFileSync(
			secondPath,
			`import { appendFileSync } from "node:fs";
			appendFileSync(${JSON.stringify(marker)}, "second\\n");
			export default function (pi) {
				pi.on("project_trust", () => ({ trusted: "yes" }));
			}`,
		);
		const metadata = new Map<string, PathMetadata>([projectMetadata(firstPath), projectMetadata(secondPath)]);
		const seed = planCapabilityPreflight([firstPath, secondPath], metadata, {}, { cwd });
		const remembered = seed.pending.find((item) => item.path === secondPath);
		expect(remembered).toBeDefined();
		acknowledgeCapabilities(agentDir, [remembered!]);
		const trustContext: ProjectTrustContext = {
			cwd,
			mode: "print",
			hasUI: false,
			ui: {
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
			},
		};
		const makeLoader = (onPrompt: (items: Array<{ path: string }>) => void) =>
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				capabilityPreflight: async (items) => {
					onPrompt(items);
					return items.map((item) => ({ path: item.path, accept: true }));
				},
			});
		const prompted: string[] = [];
		const loader = makeLoader((items) => prompted.push(...items.map((item) => basename(item.path))));
		await loader.reload();
		expect(prompted).toEqual([firstName]);
		expect(loader.getExtensions().extensions.map((extension) => basename(extension.path))).toEqual([
			firstName,
			secondName,
		]);
		expect(readFileSync(marker, "utf-8")).toBe("first\nsecond\n");
		const { result } = await emitProjectTrustEvent(
			loader.getExtensions(),
			{ type: "project_trust", cwd },
			trustContext,
		);
		expect(result?.trusted).toBe("no");

		// After acknowledgement the order and precedence are unchanged.
		const again = makeLoader(() => {
			throw new Error("should not prompt once every manifest is remembered");
		});
		await again.reload();
		expect(again.getExtensions().extensions.map((extension) => basename(extension.path))).toEqual([
			firstName,
			secondName,
		]);
		const { result: againResult } = await emitProjectTrustEvent(
			again.getExtensions(),
			{ type: "project_trust", cwd },
			trustContext,
		);
		expect(againResult?.trusted).toBe("no");
	});

	// #7: concurrent processes merge instead of clobbering remembered choices.
	it("merges store updates against the latest contents", () => {
		const agentDir = tempDir();
		const directory = tempDir();
		const pathA = write(directory, "a.ts", "export default function () {}");
		const pathB = write(directory, "b.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([projectMetadata(pathA), projectMetadata(pathB)]);
		const plan = planCapabilityPreflight([pathA, pathB], metadata, {});
		const [itemA, itemB] = plan.pending;
		expect(itemA).toBeDefined();
		expect(itemB).toBeDefined();
		acknowledgeCapabilities(agentDir, [itemA!]);
		// A second writer that started from an empty snapshot must not drop A.
		recordCapabilityInspection(agentDir, [itemB!]);
		const store = readCapabilityPreflightStore(agentDir);
		expect(store.acknowledgements[getResourcePathKey(resolvePath(pathA))]).toBe(itemA!.fingerprint);
		expect(store.entries.map((entry) => entry.path)).toEqual([pathB]);
		acknowledgeCapabilities(agentDir, [itemB!]);
		expect(Object.keys(readCapabilityPreflightStore(agentDir).acknowledgements)).toHaveLength(2);
	});

	// #7: invalid manifests refresh their record; removed extensions are pruned.
	it("refreshes invalid manifests and drops records for removed extensions", () => {
		const agentDir = tempDir();
		const directory = tempDir();
		const live = write(directory, "live.ts", "export default function () {}");
		write(directory, "live.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: true }));
		const gone = write(directory, "gone.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([projectMetadata(live), projectMetadata(gone)]);
		const first = planCapabilityPreflight([live, gone], metadata, {});
		recordCapabilityInspection(agentDir, first.considered);
		expect(readCapabilityPreflightStore(agentDir).entries).toHaveLength(2);

		// The manifest turns invalid: the record refreshes instead of showing stale text.
		write(directory, "live.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: "yes" }));
		const second = planCapabilityPreflight([live], metadata, {});
		expect(second.ready).toEqual([live]);
		expect(second.considered).toHaveLength(1);
		recordCapabilityInspection(agentDir, second.considered);

		rmSync(gone);
		recordCapabilityInspection(agentDir, second.considered);
		const store = readCapabilityPreflightStore(agentDir);
		expect(store.entries.map((entry) => entry.path)).toEqual([live]);
		expect(store.entries[0]?.status).toBe("invalid");
		expect(store.entries[0]?.acknowledged).toBe(false);
	});

	// #7: after startup, disclosure routes through the active UI handler.
	it("routes interactive disclosure through the registered UI handler", async () => {
		const directory = tempDir();
		const entry = write(directory, "demo.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([projectMetadata(entry)]);
		const plan = planCapabilityPreflight([entry], metadata, {});
		const host = createCapabilityPreflightHost({
			settingsManager: SettingsManager.inMemory({}),
			getMode: () => "interactive",
		});
		host.setInteractiveHandler(async (items) => items.map((item) => ({ path: item.path, accept: false })));
		const decisions = await host.disclose(plan.pending);
		expect(decisions).toEqual([{ path: entry, accept: false }]);
		expect(mockShowStartupSelector).not.toHaveBeenCalled();
	});

	// #7: print mode prints the summary; json mode uses the NDJSON diagnostic channel.
	it("prints and auto-accepts outside the interactive terminal", async () => {
		const directory = tempDir();
		const entry = write(directory, "demo.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([projectMetadata(entry)]);
		const plan = planCapabilityPreflight([entry], metadata, {});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const printHost = createCapabilityPreflightHost({
				settingsManager: SettingsManager.inMemory({}),
				getMode: () => "print",
			});
			const printDecisions = await printHost.disclose(plan.pending);
			expect(printDecisions).toEqual([{ path: entry, accept: true }]);
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("unclassified");
		} finally {
			errorSpy.mockRestore();
		}

		const writes: string[] = [];
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: unknown) => {
			writes.push(String(chunk));
			if (typeof callback === "function") (callback as (error?: Error | null) => void)();
			return true;
		}) as typeof process.stdout.write);
		try {
			const jsonHost = createCapabilityPreflightHost({
				settingsManager: SettingsManager.inMemory({}),
				getMode: () => "json",
			});
			const jsonDecisions = await jsonHost.disclose(plan.pending);
			expect(jsonDecisions).toEqual([{ path: entry, accept: true }]);
			await flushRawStdout();
			const line = writes
				.join("")
				.split("\n")
				.find((candidate) => candidate.includes("capability_preflight"));
			const record = JSON.parse(line ?? "") as { type: string; code: string; message: string };
			expect(record.type).toBe("diagnostic");
			expect(record.code).toBe("capability_preflight");
			expect(record.message).toContain("unclassified");
		} finally {
			writeSpy.mockRestore();
		}
	});

	// #7: metadata commands never prompt, even on a terminal.
	it("does not prompt for --help on an interactive terminal", async () => {
		const tempRoot = tempDir();
		const projectDir = join(tempRoot, "project");
		const agentDir = join(tempRoot, "agent");
		mkdirSync(join(projectDir, ".october", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const marker = join(projectDir, "executed.txt");
		writeFileSync(
			join(projectDir, ".october", "extensions", "demo.ts"),
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function () {}`,
		);
		writeFileSync(join(projectDir, ".october", "settings.json"), JSON.stringify({}));
		new ProjectTrustStore(agentDir).set(projectDir, true);

		class ProcessExit extends Error {
			code?: unknown;
			constructor(code?: unknown) {
				super(`process exit ${String(code)}`);
				this.code = code;
			}
		}
		const originalCwd = process.cwd();
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const exitCodes: unknown[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
			exitCodes.push(code);
			throw new ProcessExit(code);
		}) as typeof process.exit);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			mockShowStartupSelector.mockResolvedValue(undefined);
			await expect(main(["--help"])).rejects.toThrow(ProcessExit);
			expect(exitCodes).toEqual([0]);
			expect(mockShowStartupSelector).not.toHaveBeenCalled();
			// Print-mode disclosure remembered the extension and it loaded.
			expect(existsSync(marker)).toBe(true);
			expect(Object.keys(readCapabilityPreflightStore(agentDir).acknowledgements)).toHaveLength(1);
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
			else delete (process.stdin as { isTTY?: unknown }).isTTY;
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
			else delete (process.stdout as { isTTY?: unknown }).isTTY;
			exitSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	// #7: print mode binds no UI, so the command succeeds silently there.
	it("notes that /capabilities only shows output in the interactive terminal", async () => {
		const agentDir = tempDir();
		const extensionPath = write(agentDir, "extensions/demo.ts", "export default function () {}");
		write(agentDir, "extensions/demo.capabilities.json", JSON.stringify({ manifestVersion: 1, shell: true }));
		const metadata = new Map<string, PathMetadata>([
			[extensionPath, { source: "npm:demo", scope: "user", origin: "package" }],
		]);
		const plan = planCapabilityPreflight([extensionPath], metadata, {});
		recordCapabilityInspection(agentDir, plan.pending);
		acknowledgeCapabilities(agentDir, plan.pending);

		const registered: Array<{ name: string; description?: string }> = [];
		registerCapabilityInspection(
			{
				registerCommand: (name: string, options: { description?: string }) => {
					registered.push({ name, description: options.description });
				},
			} as unknown as ExtensionAPI,
			agentDir,
		);
		expect(registered[0]?.description).toContain("interactive terminal");

		// Real print-mode behavior: no UI context, notify is a no-op, the command still succeeds.
		const printHarness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerCapabilityInspection(pi, agentDir)],
		});
		harnesses.push(printHarness);
		await printHarness.session.bindExtensions({ mode: "print" });
		await printHarness.session.prompt("/capabilities");

		// With a UI bound, the remembered summary and full manifest are shown.
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
		expect(notify.calls.at(-1)).toContain(extensionPath);
		await harness.session.prompt("/capabilities demo");
		expect(notify.calls.at(-1)).toContain('"shell": true');
		expect(notify.calls.at(-1)).toContain("not an operating-system sandbox");
	});

	// #7: manifest values are untrusted display text: escapes, newlines, and
	// bidirectional controls must not reach the terminal or forge new lines.
	it("cleans credential escapes and newlines from display text", () => {
		const directory = tempDir();
		const entryPath = write(directory, "evil.ts", "export default function () {}");
		write(
			directory,
			"evil.capabilities.json",
			JSON.stringify({
				manifestVersion: 1,
				credentials: ["tok\u001b[8m\nVerified safe", "ok\u202eRTL"],
			}),
		);
		const disclosure = readCapabilityManifest(entryPath);
		expect(disclosure.status).toBe("declared");
		const summary = formatCapabilitySummary(entryPath, disclosure);
		expect(summary).not.toContain("\u001b");
		expect(summary).not.toContain("\n");
		expect(summary).not.toContain("\u202e");
		// The credential is still named, flattened onto the summary line.
		expect(summary).toContain("tok Verified safe");
		expect(summary).toContain("okRTL");
		const details = formatCapabilityDetails(entryPath, disclosure);
		expect(details).not.toContain("\u001b");
		expect(details).not.toContain("\u202e");
		expect(details).toContain("Verified safe");
	});

	// #7: package sources and paths come from the filesystem, not from us.
	it("cleans package and path text in identities", () => {
		const directory = tempDir();
		const entryPath = write(directory, "pkg/index.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([
			[entryPath, { source: "npm:evil\u001b[31m\npkg", scope: "user", origin: "package" }],
		]);
		const plan = planCapabilityPreflight([entryPath], metadata, {});
		expect(plan.pending).toHaveLength(1);
		const identity = plan.pending[0]?.identity ?? "";
		expect(identity).not.toContain("\u001b");
		expect(identity).not.toContain("\n");
		expect(identity).toContain("npm:evil");
		expect(identity).toContain("pkg");
		expect(plan.pending[0]?.summary ?? "").not.toContain("\u001b");
	});

	// #7: validation errors echo extension-authored field names and paths.
	it("cleans validation errors and sources in display text", () => {
		const directory = tempDir();
		const entryPath = write(directory, "bad.ts", "export default function () {}");
		write(
			directory,
			"bad.capabilities.json",
			JSON.stringify({ manifestVersion: 1, "evil\u001b\nfield": true, shell: "yes" }),
		);
		const disclosure = readCapabilityManifest(entryPath);
		expect(disclosure.status).toBe("invalid");
		const summary = formatCapabilitySummary(entryPath, disclosure);
		expect(summary).not.toContain("\u001b");
		expect(summary).not.toContain("\n");
		expect(summary).toContain("invalid capability manifest");
		const details = formatCapabilityDetails(entryPath, disclosure);
		expect(details).not.toContain("\u001b");
		expect(details).toContain("unknown field");
	});

	// #7: the composed CLI diagnostic cleans the hostile path prefix, not just the
	// inner loader error; the extension never executes.
	it("cleans hostile paths from CLI load diagnostics and never executes", async () => {
		const tempRoot = tempDir();
		const projectDir = join(tempRoot, "project");
		const agentDir = join(tempRoot, "agent");
		const extensionsDir = join(projectDir, ".october", "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const hostileBase = "evil\u001b[2J\nname";
		const marker = join(projectDir, "executed.txt");
		write(
			extensionsDir,
			`${hostileBase}.ts`,
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function () {}`,
		);
		write(
			extensionsDir,
			`${hostileBase}.capabilities.json`,
			JSON.stringify({ manifestVersion: 1, "bad\u001b[0m\nkey": true }),
		);
		writeFileSync(join(projectDir, ".october", "settings.json"), JSON.stringify({}));
		new ProjectTrustStore(agentDir).set(projectDir, true);

		class ProcessExit extends Error {
			code?: unknown;
			constructor(code?: unknown) {
				super(`process exit ${String(code)}`);
				this.code = code;
			}
		}
		const originalCwd = process.cwd();
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
			throw new ProcessExit(code);
		}) as typeof process.exit);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		try {
			await expect(main(["--help"])).rejects.toThrow(ProcessExit);
			const output = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain("Failed to load extension");
			expect(output).toContain("Invalid capability manifest");
			expect(output).toContain("unknown field");
			expect(output).not.toContain("\u001b");
			expect(output).not.toContain("[2J");
			expect(output).not.toContain(hostileBase);
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			exitSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	// #7: declining a hostile-named extension cleans the path in its skip warning.
	// The invalid sibling forces the run to exit after diagnostics, before the TUI boots.
	it("cleans hostile paths from CLI skip warnings", async () => {
		const tempRoot = tempDir();
		const projectDir = join(tempRoot, "project");
		const agentDir = join(tempRoot, "agent");
		const extensionsDir = join(projectDir, ".october", "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const declinedBase = "evil\u001b[2J\nname";
		const invalidBase = "bad\u001b[2J\next";
		const declinedMarker = join(projectDir, "declined-executed.txt");
		const invalidMarker = join(projectDir, "invalid-executed.txt");
		const markerSource = (marker: string): string => `import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function () {}`;
		write(extensionsDir, `${declinedBase}.ts`, markerSource(declinedMarker));
		write(extensionsDir, `${declinedBase}.capabilities.json`, JSON.stringify({ manifestVersion: 1, shell: true }));
		write(extensionsDir, `${invalidBase}.ts`, markerSource(invalidMarker));
		write(
			extensionsDir,
			`${invalidBase}.capabilities.json`,
			JSON.stringify({ manifestVersion: 1, "bad\u001b[0m\nkey": true }),
		);
		writeFileSync(join(projectDir, ".october", "settings.json"), JSON.stringify({}));
		new ProjectTrustStore(agentDir).set(projectDir, true);

		class ProcessExit extends Error {
			code?: unknown;
			constructor(code?: unknown) {
				super(`process exit ${String(code)}`);
				this.code = code;
			}
		}
		const originalCwd = process.cwd();
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
			throw new ProcessExit(code);
		}) as typeof process.exit);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			mockShowStartupSelector.mockResolvedValue(undefined);
			await expect(main([])).rejects.toThrow("process exit 1");
			expect(mockShowStartupSelector).toHaveBeenCalled();
			const output = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain(CAPABILITY_SKIP_WARNING_PREFIX);
			expect(output).toContain("Failed to load extension");
			expect(output).not.toContain("\u001b");
			expect(output).not.toContain(declinedBase);
			expect(output).not.toContain(invalidBase);
			expect(existsSync(declinedMarker)).toBe(false);
			expect(existsSync(invalidMarker)).toBe(false);
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
			else delete (process.stdin as { isTTY?: unknown }).isTTY;
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
			else delete (process.stdout as { isTTY?: unknown }).isTTY;
			exitSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	// #7: package commands clean hostile paths in their composed diagnostics.
	// The bootstrap pass skips project extensions, so the hostile extension lives in
	// the user extensions directory; the project settings file triggers that pass.
	it("cleans hostile paths from package-command diagnostics", async () => {
		const tempRoot = tempDir();
		const projectDir = join(tempRoot, "project");
		const agentDir = join(tempRoot, "agent");
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(join(projectDir, ".october"), { recursive: true });
		const hostileBase = "evil\u001b[2J\nname";
		const marker = join(tempRoot, "executed.txt");
		write(
			extensionsDir,
			`${hostileBase}.ts`,
			`import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "executed");
			export default function () {}`,
		);
		write(
			extensionsDir,
			`${hostileBase}.capabilities.json`,
			JSON.stringify({ manifestVersion: 1, "bad\u001b[0m\nkey": true }),
		);
		writeFileSync(join(projectDir, ".october", "settings.json"), JSON.stringify({}));
		new ProjectTrustStore(agentDir).set(projectDir, true);

		const originalCwd = process.cwd();
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const originalExitCode = process.exitCode;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		try {
			expect(await handlePackageCommand(["list"])).toBe(true);
			const output = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain("Failed to load extension");
			expect(output).not.toContain("\u001b");
			expect(output).not.toContain(hostileBase);
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.chdir(originalCwd);
			process.exitCode = originalExitCode;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	// #7: the interactive diagnostics renderer cleans hostile paths, names, and messages.
	it("cleans hostile paths and messages from in-app diagnostics", () => {
		initTheme("dark");
		const proto = InteractiveMode.prototype as unknown as {
			formatDiagnostics: (
				diagnostics: readonly ResourceDiagnostic[],
				sourceInfos: Map<string, SourceInfo>,
			) => string;
			formatPathWithSource: (p: string, sourceInfo?: SourceInfo) => string;
		};
		const hostilePath = "/extensions/evil\u001b[2J\n.ts";
		const hostileName = "evil\u001b[2J\nname";
		const diagnostics: ResourceDiagnostic[] = [
			{
				type: "error",
				path: hostilePath,
				message: `Invalid capability manifest for ${hostilePath} (sidecar): bad\u001b[0m\nkey: unknown field`,
			},
			{
				type: "collision",
				message: "",
				collision: {
					resourceType: "extension",
					name: hostileName,
					winnerPath: hostilePath,
					loserPath: hostilePath,
				},
			},
		];
		const output = stripAnsi(
			proto.formatDiagnostics.call(
				{
					formatPathWithSource: proto.formatPathWithSource,
					findSourceInfoForPath: () => undefined,
					formatDisplayPath: (p: string) => p,
				},
				diagnostics,
				new Map<string, SourceInfo>(),
			),
		);
		expect(output).toContain("unknown field");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("[2J");
		expect(output).not.toContain(hostilePath);
		expect(output).not.toContain(hostileName);
		// No forged lines: two lines for the error plus three for the collision.
		expect(output.split("\n")).toHaveLength(5);
	});

	// #7: both inspection forms clean their output, including records stored
	// before display cleaning existed.
	it("cleans both inspection forms, including dirty stored records", () => {
		const agentDir = tempDir();
		const directory = tempDir();
		const entryPath = write(directory, "evil.ts", "export default function () {}");
		write(
			directory,
			"evil.capabilities.json",
			JSON.stringify({ manifestVersion: 1, credentials: ["tok\u001b[8m\nVerified safe"] }),
		);
		const metadata = new Map<string, PathMetadata>([projectMetadata(entryPath)]);
		const plan = planCapabilityPreflight([entryPath], metadata, {});
		recordCapabilityInspection(agentDir, plan.pending);
		const list = formatCapabilityInspection(agentDir);
		expect(list).not.toContain("\u001b");
		expect(list).not.toContain("Verified safe\n");
		const single = formatCapabilityInspection(agentDir, "evil");
		expect(single).not.toContain("\u001b");

		// A pre-cleaning store keeps raw text on disk; reads still clean it.
		const storePath = join(agentDir, "capability-preflight.json");
		const stored = JSON.parse(readFileSync(storePath, "utf-8")) as {
			entries: Array<{ summary: string; details: string; path: string }>;
		};
		stored.entries[0]!.summary = "evil: credentials tok\u001b[8m\nVerified safe";
		stored.entries[0]!.details = "evil: pwned\u001b\nline";
		writeFileSync(storePath, JSON.stringify(stored));
		expect(formatCapabilityInspection(agentDir)).not.toContain("\u001b");
		expect(formatCapabilityInspection(agentDir, "evil")).not.toContain("\u001b");
	});

	// #7: cleaning is display-only; fingerprints still see raw manifest values.
	it("fingerprints raw manifests, not cleaned display", () => {
		const directory = tempDir();
		const newlinePath = write(directory, "newline.ts", "export default function () {}");
		write(directory, "newline.capabilities.json", JSON.stringify({ manifestVersion: 1, credentials: ["a\nb"] }));
		const spacePath = write(directory, "space.ts", "export default function () {}");
		write(directory, "space.capabilities.json", JSON.stringify({ manifestVersion: 1, credentials: ["a b"] }));
		// These clean to the same display text but must not share a fingerprint.
		expect(formatCapabilitySummary(newlinePath, readCapabilityManifest(newlinePath))).toContain("a b");
		expect(capabilityFingerprint(readCapabilityManifest(newlinePath))).not.toBe(
			capabilityFingerprint(readCapabilityManifest(spacePath)),
		);
	});

	// #7: another process accepting the same manifest must not undo this process's Skip.
	it("keeps a process-local skip ahead of another process's acknowledgement", async () => {
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
		let prompts = 0;
		const makeLoader = () =>
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				capabilityPreflight: async (items) => {
					prompts += 1;
					return items.map((item) => ({ path: item.path, accept: false }));
				},
			});
		const first = makeLoader();
		await first.reload();
		expect(prompts).toBe(1);
		expect(existsSync(marker)).toBe(false);

		// Another process accepts the same manifest while this one runs.
		const metadata = new Map<string, PathMetadata>([projectMetadata(join(cwd, ".october", "extensions", "demo.ts"))]);
		const plan = planCapabilityPreflight([join(cwd, ".october", "extensions", "demo.ts")], metadata, {});
		// The decline is process-local, so a fresh plan call still lists it pending here;
		// acknowledge it the way the other process would.
		const pending = plan.pending.length > 0 ? plan.pending : plan.skipped;
		expect(pending).toHaveLength(1);
		acknowledgeCapabilities(agentDir, [pending[0]!]);

		// Reloading the original loader imports nothing, prompts nothing, and warns.
		await first.reload();
		expect(prompts).toBe(1);
		expect(existsSync(marker)).toBe(false);
		const warnings = first.getExtensions().warnings ?? [];
		const skipWarning = warnings.find((warning) => warning.warning.startsWith(CAPABILITY_SKIP_WARNING_PREFIX));
		expect(skipWarning).toBeDefined();
		expect(skipWarning?.warning).toContain(CAPABILITY_SKIP_RECOVERY_HINT);

		// A fresh loader in this process honors the decline too.
		const second = makeLoader();
		await second.reload();
		expect(prompts).toBe(1);
		expect(existsSync(marker)).toBe(false);

		// A changed manifest matches neither the decline nor the acknowledgement.
		write(
			cwd,
			".october/extensions/demo.capabilities.json",
			JSON.stringify({ manifestVersion: 1, octoberBus: false }),
		);
		const third = makeLoader();
		await third.reload();
		expect(prompts).toBe(2);
	});

	// #7: store writes replace the file atomically and leave no temp files behind.
	it("replaces the preflight store atomically", () => {
		const agentDir = tempDir();
		const directory = tempDir();
		const entryPath = write(directory, "demo.ts", "export default function () {}");
		const metadata = new Map<string, PathMetadata>([projectMetadata(entryPath)]);
		const plan = planCapabilityPreflight([entryPath], metadata, {});
		acknowledgeCapabilities(agentDir, plan.pending);
		recordCapabilityInspection(agentDir, plan.pending);
		expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(() => JSON.parse(readFileSync(join(agentDir, "capability-preflight.json"), "utf-8"))).not.toThrow();
		expect(Object.keys(readCapabilityPreflightStore(agentDir).acknowledgements)).toHaveLength(1);
	});

	describe("disclosure layout", () => {
		beforeAll(() => {
			initTheme("dark");
		});

		// Mount the choice the way the running UI does: details in the scrollable
		// transcript document, the selector in the editor slot, and a footer below.
		function mountDisclosure(
			title: string,
			details: string,
		): {
			render: (width: number, height: number) => string[];
			transcript: { scrollToStart: () => void; scrollToEnd: () => void };
		} {
			const document = new Container();
			document.addChild(new Spacer(1));
			document.addChild(new Text(details, 1, 0));
			const selector = new ExtensionSelectorComponent(
				title,
				[CAPABILITY_LOAD_CHOICE, CAPABILITY_SKIP_CHOICE],
				() => {},
				() => {},
			);
			const viewport = createChatViewport({
				document,
				pendingMessages: new Container(),
				status: new Container(),
				editor: selector,
				footer: new Text("enter select · esc skip", 1, 0),
			});
			return {
				transcript: viewport.transcript,
				render: (width: number, height: number) =>
					renderLayoutFrame(viewport.root, width, height, () => {}).lines.map((line) => stripAnsi(line).trimEnd()),
			};
		}

		function planLongDeclaration(directory: string) {
			const manifest = {
				manifestVersion: 1,
				shell: true,
				network: ["api.example.com", "files.example.com"],
				environment: Array.from({ length: 30 }, (_, index) => `OCTOBER_LONG_VARIABLE_${index}`),
				credentials: ["deploy-token"],
			};
			const longDir = join(directory, "deeply", "nested", "project", "with-a-very-long-directory-name");
			const current = write(longDir, "current-extension-entry.ts", "export default function () {}");
			write(longDir, "current-extension-entry.capabilities.json", JSON.stringify(manifest));
			const others = [0, 1, 2, 3].map((index) => {
				const entry = write(directory, `pkg-${index}/dist/index.ts`, "export default function () {}");
				write(
					directory,
					`pkg-${index}/dist/index.capabilities.json`,
					JSON.stringify({ manifestVersion: 1, shell: false }),
				);
				return entry;
			});
			const metadata = new Map<string, PathMetadata>([
				[current, { source: "auto", scope: "project", origin: "top-level" }],
				...others.map((entry, index): [string, PathMetadata] => [
					entry,
					{ source: `npm:example-${index}@1.0.0`, scope: "user", origin: "package" },
				]),
			]);
			return planCapabilityPreflight([current, ...others], metadata, {}, { cwd: directory });
		}

		// #7: in an 80x24 fullscreen frame, a long declaration must not push the
		// choices out of the dock. Full details stay reachable in the transcript.
		it("keeps both choices visible in an 80x24 frame with a long declaration", () => {
			const plan = planLongDeclaration(tempDir());
			expect(plan.pending).toHaveLength(5);
			const title = formatCapabilityDisclosureTitle(plan.pending, 0);
			// The title carries counts, not values, so it cannot grow with the manifest.
			expect(title).toContain("30 vars");
			expect(title).toContain("current-extension-entry");
			expect(title).not.toContain("OCTOBER_LONG_VARIABLE_29");
			const details = formatCapabilityDisclosureDetails(plan.pending, 0);
			expect(details).toContain("OCTOBER_LONG_VARIABLE_29");
			expect(details).toContain("npm:example-3@1.0.0");
			expect(details).toContain('"deploy-token"');
			const frame = mountDisclosure(title, details);
			const visible = frame.render(80, 24);
			expect(visible).toHaveLength(24);
			const text = visible.join("\n");
			expect(text).toContain("Load and remember");
			expect(text).toContain("Skip");
			expect(text).toContain("→");
			// Page keys drive the transcript: scrolling reaches the full declaration
			// while the choices stay put.
			frame.transcript.scrollToStart();
			const scrolled = frame.render(80, 24).join("\n");
			expect(scrolled).toContain("Pending extensions:");
			expect(scrolled).toContain("Load and remember");
			expect(scrolled).toContain("Skip");
			frame.transcript.scrollToEnd();
			const tail = frame.render(80, 24).join("\n");
			expect(tail).toContain("does not prove what the extension does");
			expect(tail).toContain("Load and remember");
		});

		// #7: a hostile single-line summary cannot push the choices out either.
		it("bounds the choice title against hostile manifest values", () => {
			const directory = tempDir();
			const entryPath = write(directory, "evil.ts", "export default function () {}");
			write(
				directory,
				"evil.capabilities.json",
				JSON.stringify({ manifestVersion: 1, credentials: [`x`.repeat(10000)] }),
			);
			const metadata = new Map<string, PathMetadata>([projectMetadata(entryPath)]);
			const plan = planCapabilityPreflight([entryPath], metadata, {});
			const title = formatCapabilityDisclosureTitle(plan.pending, 0);
			expect(title.length).toBeLessThan(400);
			expect(title).toContain("1 name");
			expect(title).not.toContain("x".repeat(100));
			const details = formatCapabilityDisclosureDetails(plan.pending, 0);
			expect(details).toContain("x".repeat(100));
			const frame = mountDisclosure(title, details);
			const text = frame.render(40, 24).join("\n");
			expect(text).toContain("Load and remember");
			expect(text).toContain("Skip");
			expect(text).toContain("→");
		});

		// #7: wide characters wrap by column, not by character, and the choices
		// stay visible in a narrow frame.
		it("keeps both choices visible with wide characters in a 40x24 frame", () => {
			const directory = tempDir();
			const entryPath = write(directory, "日本語-extension/拡張機能-entry.ts", "export default function () {}");
			write(
				directory,
				"日本語-extension/拡張機能-entry.capabilities.json",
				JSON.stringify({ manifestVersion: 1, shell: true, network: ["api.example.com"] }),
			);
			const metadata = new Map<string, PathMetadata>([projectMetadata(entryPath)]);
			const plan = planCapabilityPreflight([entryPath], metadata, {}, { cwd: directory });
			const title = formatCapabilityDisclosureTitle(plan.pending, 0);
			expect(title).toContain("拡張機能");
			const details = formatCapabilityDisclosureDetails(plan.pending, 0);
			const frame = mountDisclosure(title, details);
			const text = frame.render(40, 24).join("\n");
			expect(text).toContain("Load and remember");
			expect(text).toContain("Skip");
			expect(text).toContain("→");
		});

		// #7: shrinking the terminal with a choice open keeps both actions visible.
		it("keeps both choices visible when the frame shrinks with a choice open", () => {
			const plan = planLongDeclaration(tempDir());
			const title = formatCapabilityDisclosureTitle(plan.pending, 0);
			const details = formatCapabilityDisclosureDetails(plan.pending, 0);
			const frame = mountDisclosure(title, details);
			expect(frame.render(80, 24).join("\n")).toContain("Load and remember");
			const shrunk = frame.render(80, 18).join("\n");
			expect(shrunk).toContain("Load and remember");
			expect(shrunk).toContain("Skip");
			const narrowShrunk = frame.render(40, 20).join("\n");
			expect(narrowShrunk).toContain("Load and remember");
			expect(narrowShrunk).toContain("Skip");
		});
	});
});
