import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDefaultSessionDirPath, SessionManager } from "../src/core/session-manager.ts";
import { formatPortableSessionDiagnostics, serializePortableSession } from "../src/core/session-portable.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";
import { buildPortableFixture } from "./fixtures/portable-session-fixture.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

async function runCli(
	args: string[],
	cwd: string,
	agentDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	return { code, stdout, stderr };
}

/** A native session file holding the canonical fixture, as the CLI would have stored it. */
function writeNativeFixture(): { path: string; sessionId: string } {
	const sourceCwd = createTempDir("pi-portable-cli-source-");
	const sessionDir = join(sourceCwd, "sessions");
	const source = SessionManager.create(sourceCwd, sessionDir);
	buildPortableFixture(source, join(createTempDir("pi-portable-cli-bash-"), "bash.log"));
	return { path: source.getSessionFile()!, sessionId: source.getSessionId() };
}

function writePortableFixture(): { path: string; sessionId: string } {
	const native = writeNativeFixture();
	const path = join(createTempDir("pi-portable-cli-file-"), "portable.jsonl");
	writeFileSync(path, serializePortableSession(SessionManager.open(native.path)).jsonl);
	return { path, sessionId: native.sessionId };
}

/** A portable file that names no model, so the destination needs no particular model for it. */
function writeModelFreePortableFile(): { path: string; sessionId: string } {
	const source = SessionManager.inMemory(createTempDir("pi-portable-cli-model-free-"));
	source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const path = join(createTempDir("pi-portable-cli-file-"), "portable.jsonl");
	writeFileSync(path, serializePortableSession(source).jsonl);
	return { path, sessionId: source.getSessionId() };
}

function createCliDirs(prefix: string): { cwd: string; agentDir: string } {
	const cwd = createTempDir(prefix);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	return { cwd, agentDir };
}

describe("CLI portable sessions", () => {
	// Regression test for #2.
	it("imports with --import into the CLI cwd and session dir", async () => {
		const portable = writeModelFreePortableFile();
		const cwd = createTempDir("pi-portable-cli-cwd-");
		const sessionDir = join(cwd, "sessions");

		const sm = await createSessionManager(
			parseArgs(["--import", portable.path]),
			cwd,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(sm.getSessionId()).toBe(portable.sessionId);
		expect(sm.getCwd()).toBe(cwd);
		expect(readdirSync(sessionDir)).toHaveLength(1);
		expect(sm.getSessionFile()).toBe(join(sessionDir, readdirSync(sessionDir)[0]));
		expect(sm.getHeader()).not.toHaveProperty("portable");
	});

	it("fails a blocked --import headless with the report, and writes nothing", { timeout: 60_000 }, async () => {
		const { cwd, agentDir } = createCliDirs("pi-portable-cli-blocked-");
		// The fixture's model is not in the CLI's catalog, so the CLI cannot tell if an extension provides it.
		const portable = writePortableFixture();

		const result = await runCli(["--import", portable.path, "--no-extensions", "-p", "hi"], cwd, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("needs a replacement model");
		expect(result.stderr).toContain("Next turn model: faux-provider/faux-model (unknown)");
		expect(result.stderr).toContain("Blocked: choose a replacement model.");
		expect(existsSync(getDefaultSessionDirPath(cwd, agentDir))).toBe(false);
	});

	it(
		"shows the report with --import-report, exits 1 when blocked, and writes nothing",
		{ timeout: 60_000 },
		async () => {
			const { cwd, agentDir } = createCliDirs("pi-portable-cli-report-");
			const portable = writePortableFixture();
			const agentDirBefore = readdirSync(agentDir).sort();

			const result = await runCli(["--import-report", portable.path, "--no-extensions"], cwd, agentDir);

			expect(result.code).toBe(1);
			expect(result.stdout).toContain("Next turn model: faux-provider/faux-model (unknown)");
			expect(result.stdout).toContain("Blocked: choose a replacement model.");
			// Unknown tools and custom message types are reported with remediation, and never block.
			expect(result.stdout).toContain("history tool read");
			expect(result.stdout).toContain("custom message review-note (1)");
			expect(existsSync(getDefaultSessionDirPath(cwd, agentDir))).toBe(false);
			expect(readdirSync(agentDir).sort()).toEqual(agentDirBefore);
		},
	);

	it("reports a compatible file as not blocked with --import-report", { timeout: 60_000 }, async () => {
		const { cwd, agentDir } = createCliDirs("pi-portable-cli-compatible-");
		const portable = writeModelFreePortableFile();

		const result = await runCli(["--import-report", portable.path, "--no-extensions"], cwd, agentDir);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Not blocked.");
		expect(existsSync(getDefaultSessionDirPath(cwd, agentDir))).toBe(false);
	});

	it("rejects a replacement model the CLI cannot verify, before writing", { timeout: 60_000 }, async () => {
		const { cwd, agentDir } = createCliDirs("pi-portable-cli-replacement-");
		const portable = writePortableFixture();

		const result = await runCli(
			["--import", portable.path, "--import-model", "nope/none", "--no-extensions", "-p", "hi"],
			cwd,
			agentDir,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Replacement model nope/none is not available here (unknown)");
		expect(existsSync(getDefaultSessionDirPath(cwd, agentDir))).toBe(false);
	});

	it("rejects --import-model without --import and --import-report with --import", { timeout: 60_000 }, async () => {
		const { cwd, agentDir } = createCliDirs("pi-portable-cli-flags-");
		const portable = writeModelFreePortableFile();

		const withoutImport = await runCli(["--import-model", "a/b", "--no-extensions", "-p", "hi"], cwd, agentDir);
		expect(withoutImport.code).toBe(1);
		expect(withoutImport.stderr).toContain("Error: --import-model requires --import");

		const withImport = await runCli(["--import-report", portable.path, "--import", portable.path], cwd, agentDir);
		expect(withImport.code).toBe(1);
		expect(withImport.stderr).toContain("Error: --import-report cannot be combined with --import");
	});

	// Regression test for #2.
	it("exports a native session to portable JSONL without model setup", async () => {
		const native = writeNativeFixture();
		const cwd = createTempDir("pi-portable-cli-export-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const outputPath = join(cwd, "out", "portable.jsonl");
		const expected = serializePortableSession(SessionManager.open(native.path));

		const result = await runCli(["--export", native.path, outputPath], cwd, agentDir);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(`Exported to: ${outputPath}`);
		expect(readFileSync(outputPath, "utf8")).toBe(expected.jsonl);
		for (const line of formatPortableSessionDiagnostics(expected.diagnostics)) {
			expect(result.stderr).toContain(line);
		}
		expect(result.stderr).toContain("excluded_field header.cwd (1): machine-specific path");
		expect(result.stderr).toContain(
			"excluded_field assistant.content.thinkingSignature (2): provider replay signature",
		);
	});

	// Regression test for #2.
	it("does not create the default session dir when --import input is invalid", async () => {
		const cwd = createTempDir("pi-portable-cli-default-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const inputPath = join(cwd, "malformed.jsonl");
		writeFileSync(inputPath, "{not json\n");

		const result = await runCli(["--import", inputPath, "--no-extensions", "-p", "hi"], cwd, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Invalid portable session ${inputPath} (line 1): malformed JSON`);
		expect(existsSync(getDefaultSessionDirPath(cwd, agentDir))).toBe(false);
	});

	// Regression test for #2.
	it("rejects --import with other session flags and native files", async () => {
		const cwd = createTempDir("pi-portable-cli-reject-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const portable = writePortableFixture();
		const native = writeNativeFixture();

		const combined = await runCli(["--import", portable.path, "--continue", "-p", "hi"], cwd, agentDir);
		expect(combined.code).toBe(1);
		expect(combined.stderr).toContain("Error: --import cannot be combined with --continue");

		const withExport = await runCli(["--import", portable.path, "--export", native.path], cwd, agentDir);
		expect(withExport.code).toBe(1);
		expect(withExport.stderr).toContain("Error: --import cannot be combined with --export");

		const nativeImport = await runCli(["--import", native.path, "--no-extensions", "-p", "hi"], cwd, agentDir);
		expect(nativeImport.code).toBe(1);
		expect(nativeImport.stderr).toContain(
			"not a portable session; open native session files with --session / switch_session",
		);
		expect(nativeImport.stderr).not.toContain("    at ");
	});
});
