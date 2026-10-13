import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { resolveShellRunner } from "../src/core/shell-runner.ts";

// issue #17: the shell runner policy is read from global settings only and fails closed.

const isRoot = process.getuid?.() === 0;

describe("shell runner settings", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let globalPath: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "shell-runner-settings-")));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".october"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		chmodSync(agentDir, 0o700);
		rmSync(root, { recursive: true, force: true });
	});

	const read = (dir = agentDir) => SettingsManager.create(projectDir, dir).getShellRunnerSettings();

	it.each([
		["missing", undefined],
		["empty", ""],
		["array", "[]"],
		["no shellRunner", JSON.stringify({ theme: "dark" })],
	])("means host with no notice for a %s global file", async (_name, content) => {
		if (content !== undefined) writeFileSync(globalPath, content);
		expect(read()).toEqual({});
		expect(await resolveShellRunner(read(), projectDir)).toEqual({ kind: "host" });
	});

	it("ignores shellRunner in project settings", () => {
		writeFileSync(
			join(projectDir, ".october", "settings.json"),
			JSON.stringify({ shellRunner: { type: "docker", image: "x" } }),
		);
		expect(read()).toEqual({});
		writeFileSync(globalPath, JSON.stringify({ shellRunner: { type: "host" } }));
		writeFileSync(join(projectDir, ".october", "settings.json"), JSON.stringify({ shellRunner: null }));
		expect(read()).toEqual({ settings: { type: "host" } });
	});

	it("returns the explicit host selection with its notice", async () => {
		writeFileSync(globalPath, JSON.stringify({ shellRunner: { type: "host" } }));
		expect(await resolveShellRunner(read(), projectDir)).toEqual({
			kind: "host",
			notice: "Shell runner: host. Commands run directly on this machine.",
		});
	});

	it.each([
		["whitespace-only", "  \n", /could not be loaded/],
		["malformed", "{ nope", /could not be loaded/],
		["null", "null", /could not be loaded: Settings file must contain a JSON object, found null/],
		["scalar", "42", /could not be loaded: Settings file must contain a JSON object, found number/],
	])("blocks shell commands for a %s global file", async (_name, content, cause) => {
		writeFileSync(globalPath, content);
		const result = read();
		expect(result.error).toMatch(cause);
		expect(result.error).toContain(globalPath);
		const selection = await resolveShellRunner(result, projectDir);
		expect(selection.kind).toBe("invalid");
		expect(selection.notice).toMatch(/^Shell runner: blocked\. Global settings file .* restart\.$/);
	});

	it("keeps loading and saving other settings for an empty global file", async () => {
		writeFileSync(globalPath, "");
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.drainErrors()).toEqual([]);
		expect(manager.getShellRunnerSettings()).toEqual({});
		manager.setTheme("light");
		await manager.flush();
		expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ theme: "light" });
	});

	it.skipIf(isRoot)("blocks for an unreadable file or directory", () => {
		writeFileSync(globalPath, JSON.stringify({ shellRunner: { type: "host" } }));
		chmodSync(globalPath, 0o000);
		expect(read().error).toMatch(/could not be loaded: EACCES/);
		chmodSync(globalPath, 0o600);
		chmodSync(agentDir, 0o000);
		expect(read().error).toMatch(/could not be loaded: EACCES/);
	});

	it("blocks when a path component is not a directory", () => {
		const fileAsDir = join(root, "not-a-dir");
		writeFileSync(fileAsDir, "");
		expect(read(join(fileAsDir, "agent")).error).toMatch(/could not be loaded: ENOTDIR/);
	});

	it("re-reads the file on reload, while callers keep their resolved selection", async () => {
		writeFileSync(globalPath, JSON.stringify({}));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(globalPath, JSON.stringify({ shellRunner: { type: "host" } }));
		await manager.reload();
		expect(manager.getShellRunnerSettings()).toEqual({ settings: { type: "host" } });
		writeFileSync(globalPath, "{ nope");
		await manager.reload();
		expect(manager.getShellRunnerSettings().error).toMatch(/could not be loaded/);
	});
});
