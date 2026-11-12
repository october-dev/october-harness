import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityPreflightHost } from "../src/cli/capability-preflight.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { readCapabilityManifest } from "../src/core/extensions/capabilities.ts";
import {
	acknowledgeCapabilities,
	CAPABILITY_SKIP_WARNING_PREFIX,
	capabilityFingerprint,
	capabilityPreflightReason,
	clearCapabilityDeclinesForTests,
	formatCapabilityDetails,
	formatCapabilityDisclosureTitle,
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
import { getResourcePathKey } from "../src/core/source-info.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { OCTOBER_DEFAULT_PACKAGES } from "../src/extensions/october/default-packages.ts";
import { main } from "../src/main.ts";
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

	// #7: every per-item choice shows the whole pending set plus the current full disclosure.
	it("presents the pending set together with per-item choices", () => {
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
		expect(first).toContain("npm:example-b@2.0.0");
		expect(first).toContain(plan.pending[0]?.details ?? "");
		const second = formatCapabilityDisclosureTitle(plan.pending, 1);
		expect(second).toContain("2 of 2");
		expect(second).toContain(plan.pending[1]?.details ?? "");
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
});
