import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	OCTOBER_DEFAULT_PACKAGES,
	OCTOBER_DEFAULT_PACKAGES_VERSION,
	seedOctoberDefaultPackages,
} from "../src/extensions/october/default-packages.ts";

const ONLINE: NodeJS.ProcessEnv = {};
const DEFAULT_SOURCES = OCTOBER_DEFAULT_PACKAGES.map((entry) => entry.source);
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fake an installed npm package in the user package root so resolve() needs no network. */
function installFakePackage(agentDir: string, name: string, version: string, dependencies: Record<string, string>) {
	const root = join(agentDir, "npm", "node_modules", name);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name, version, dependencies, pi: { extensions: ["./index.ts"] } }),
	);
	writeFileSync(join(root, "index.ts"), "export default function() {}");
}

async function loadWarnings(source: string, dependencies: Record<string, string>) {
	const tempDir = mkdtempSync(join(tmpdir(), "october-default-packages-"));
	tempDirs.push(tempDir);
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "cwd");
	mkdirSync(cwd, { recursive: true });
	const version = source.slice(source.lastIndexOf("@") + 1);
	installFakePackage(agentDir, "pi-web-access", version, dependencies);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({ packages: [source] }),
	});
	await loader.reload();
	expect(loader.getExtensions().extensions).toHaveLength(1);
	return loader.getExtensions().warnings ?? [];
}

describe("October default packages", () => {
	it("pins every default to an exact npm version", () => {
		for (const source of DEFAULT_SOURCES) {
			expect(source).toMatch(/^npm:(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/);
		}
	});

	it("adds the defaults once, after the user's own packages", () => {
		const settings = SettingsManager.inMemory({ packages: ["npm:some-user-package"] });

		expect(seedOctoberDefaultPackages(settings, ONLINE)).toEqual(DEFAULT_SOURCES);
		expect(settings.getGlobalSettings().packages).toEqual(["npm:some-user-package", ...DEFAULT_SOURCES]);
		expect(settings.getOctoberDefaultPackagesVersion()).toBe(OCTOBER_DEFAULT_PACKAGES_VERSION);

		expect(seedOctoberDefaultPackages(settings, ONLINE)).toEqual([]);
		expect(settings.getGlobalSettings().packages).toHaveLength(DEFAULT_SOURCES.length + 1);
	});

	it("keeps a package the user already configured at another version", () => {
		const userMcp = { source: "npm:pi-mcp-adapter@2.30.0", skills: [] };
		const settings = SettingsManager.inMemory({ packages: [userMcp] });

		const added = seedOctoberDefaultPackages(settings, ONLINE);

		expect(added.some((source) => source.startsWith("npm:pi-mcp-adapter@"))).toBe(false);
		expect(settings.getGlobalSettings().packages?.[0]).toEqual(userMcp);
		expect(added).toHaveLength(DEFAULT_SOURCES.length - 1);
	});

	it("does not re-add a default the user removed", () => {
		const settings = SettingsManager.inMemory();
		seedOctoberDefaultPackages(settings, ONLINE);
		settings.setPackages(DEFAULT_SOURCES.filter((source) => !source.startsWith("npm:pi-lens@")));

		expect(seedOctoberDefaultPackages(settings, ONLINE)).toEqual([]);
		expect(settings.getGlobalSettings().packages?.some((pkg) => String(pkg).startsWith("npm:pi-lens@"))).toBe(false);
	});

	it("skips Desktop-managed and offline runs without recording the defaults as seeded", () => {
		for (const env of [{ OCTOBER_BUS_PORT: "4100" }, { PI_OFFLINE: "1" }, { PI_OFFLINE: "true" }]) {
			const settings = SettingsManager.inMemory();
			expect(seedOctoberDefaultPackages(settings, env)).toEqual([]);
			expect(settings.getGlobalSettings().packages).toBeUndefined();
			expect(settings.getOctoberDefaultPackagesVersion()).toBeUndefined();
		}
	});

	it("does not warn about loader-aliased typebox in a pinned default package", async () => {
		const pinned = DEFAULT_SOURCES.find((source) => source.startsWith("npm:pi-web-access@"))!;
		expect(await loadWarnings(pinned, { typebox: "^1.1.38" })).toEqual([]);
	});

	it("still warns for other host packages or a user-chosen version", async () => {
		const pinned = DEFAULT_SOURCES.find((source) => source.startsWith("npm:pi-web-access@"))!;
		expect(await loadWarnings(pinned, { typebox: "^1.1.38", "@earendil-works/pi-ai": "*" })).toHaveLength(1);
		expect(await loadWarnings("npm:pi-web-access@0.30.0", { typebox: "^1.1.38" })).toHaveLength(1);
	});
});
