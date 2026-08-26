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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var), but the
	// spawned CLI sees the physical path via process.cwd(). Session cwd
	// filtering compares paths textually, so the fixture must use physical paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-id-readonly-")));
	tempDirs.push(dir);
	return dir;
}

function hasSessionWithId(root: string, sessionId: string): boolean {
	if (!existsSync(root)) return false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && hasSessionWithId(path, sessionId)) return true;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

		try {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return true;
		} catch {
			// Ignore malformed session files.
		}
	}
	return false;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; agentDir: string; stderr: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...resolvedArgs], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, agentDir: dirs.agentDir, stderr };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

function args(overrides: Partial<Args>): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
		...overrides,
	};
}

function persistSession(session: SessionManager, content: string): void {
	session.appendMessage({ role: "user", content, timestamp: Date.now() });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "persisted" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("--session-id", () => {
	it("does not persist a custom ID for metadata commands", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-help")).toBe(false);
	});

	it("creates missing IDs and reopens existing IDs in process", async () => {
		const tempRoot = createTempDir();
		const projectDir = join(tempRoot, "project");
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(projectDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const readOnly = await createSessionManager(
			args({ sessionId: "read-only", help: true }),
			projectDir,
			sessionDir,
			settingsManager,
		);
		expect(readOnly.getSessionId()).toBe("read-only");
		expect(readOnly.getSessionFile()).toBeUndefined();

		const created = await createSessionManager(
			args({ sessionId: "persisted-id" }),
			projectDir,
			sessionDir,
			settingsManager,
		);
		persistSession(created, "persist me");
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("creating a new session"));

		consoleError.mockClear();
		const reopened = await createSessionManager(
			args({ sessionId: "persisted-id" }),
			projectDir,
			sessionDir,
			settingsManager,
		);
		expect(reopened.getSessionFile()).toBe(created.getSessionFile());
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("rejects an existing fork target in process", async () => {
		const tempRoot = createTempDir();
		const projectDir = join(tempRoot, "project");
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(projectDir, { recursive: true });
		const source = SessionManager.create(projectDir, sessionDir, { id: "source-id" });
		persistSession(source, "source");
		const target = SessionManager.create(projectDir, sessionDir, { id: "existing-id" });
		persistSession(target, "target");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		await expect(
			createSessionManager(
				args({ fork: "source-id", sessionId: "existing-id" }),
				projectDir,
				sessionDir,
				SettingsManager.inMemory(),
			),
		).rejects.toThrow("exit:1");
	});
});

describe("--resume <id>", () => {
	it("opens an existing session file by id in print mode", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--resume",
				"existing-resume-id",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-resume-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No session found matching");
	});

	it("errors when the id does not match a session", async () => {
		const result = await runCli((dirs) => [
			"--session-dir",
			dirs.sessionDir,
			"--resume",
			"missing-resume-id",
			"-p",
			"hi",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No session found matching 'missing-resume-id'");
	});

	it("rejects --resume <id> combined with --session", async () => {
		const result = await runCli(["--resume", "abc", "--session", "def", "-p", "hi"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--resume <id> cannot be combined with --session");
	});
});
