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
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { parseTrace } from "../src/core/trace/format.ts";

// Regression: october-dev/october-harness#9

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const fixturePath = resolve(__dirname, "fixtures/trace/synthetic.trace.jsonl");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-trace-cli-")));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string, options: { closeStdin?: boolean } = {}) {
	let stdout = "";
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		// stdin stays open: replay must not wait for piped input.
		const child = spawn(process.execPath, ["--import", sourceResolverPath, cliPath, ...args], {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
		if (options.closeStdin) child.stdin.end();
	});
	return { code, stdout, stderr };
}

function workspace() {
	const cwd = createTempDir();
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	return { cwd, agentDir };
}

function writeTrace(cwd: string, text: string): string {
	const path = join(cwd, "edited.trace.jsonl");
	writeFileSync(path, text);
	return path;
}

describe("--replay-trace", () => {
	it("prints one timeline line per record and exits 0 for the synthetic fixture without bootstrapping", async () => {
		const { cwd, agentDir } = workspace();
		const result = await runCli(["--replay-trace", fixturePath], cwd, agentDir);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const records = readFileSync(fixturePath, "utf-8").trim().split("\n");
		const timeline = result.stdout.split("\n").filter((line) => line.startsWith("#"));
		expect(timeline).toHaveLength(records.length);
		expect(timeline[0]).toMatch(/^#0 \+0ms header pi-trace v1/);
		expect(result.stdout).toContain("replay: 2 runs, 4 model responses, 4 tool calls, 0 mismatches");
		// Nothing was created in the agent directory: no settings, auth, migrations, or packages.
		expect(readdirSync(agentDir)).toEqual([]);
	});

	it("exits 1 for mismatched, incomplete, unsupported, and malformed traces", async () => {
		const { cwd, agentDir } = workspace();
		const lines = readFileSync(fixturePath, "utf-8").trim().split("\n");

		const mismatched = lines
			.map((line) => {
				const record = JSON.parse(line);
				if (record.type === "tool_executed" && record.toolCallId === "call-1") record.preparedArgs = { text: "x" };
				return JSON.stringify(record);
			})
			.join("\n");
		const mismatch = await runCli(["--replay-trace", writeTrace(cwd, `${mismatched}\n`)], cwd, agentDir);
		expect(mismatch.code).toBe(1);
		expect(mismatch.stdout).toMatch(/mismatch: run \S+ seq \d+ tool_arguments/);

		const truncated = `${lines.slice(0, 40).join("\n")}\n${lines[40].slice(0, 20)}`;
		const incomplete = await runCli(["--replay-trace", writeTrace(cwd, truncated)], cwd, agentDir);
		expect(incomplete.code).toBe(1);
		expect(incomplete.stdout).toContain("incomplete: truncated final line 41");
		expect(incomplete.stdout).toContain("replay: 1 runs");

		const header = JSON.parse(lines[0]);
		header.version = 2;
		const unsupported = await runCli(
			["--replay-trace", writeTrace(cwd, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`)],
			cwd,
			agentDir,
		);
		expect(unsupported.code).toBe(1);
		expect(unsupported.stderr).toContain("unsupported trace version 2");

		const malformed = await runCli(
			["--replay-trace", writeTrace(cwd, `${lines[0]}\nnot json\n${lines[1]}\n`)],
			cwd,
			agentDir,
		);
		expect(malformed.code).toBe(1);
		expect(malformed.stderr).toContain("line 2");
	});

	it("rejects conflicting flags before doing anything", async () => {
		const { cwd, agentDir } = workspace();
		for (const extra of [
			["--trace", join(cwd, "t.jsonl")],
			["--export", "x.jsonl"],
			["--import", "x.jsonl"],
			["hello"],
		]) {
			const result = await runCli(["--replay-trace", fixturePath, ...extra], cwd, agentDir);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("--replay-trace cannot be combined with");
		}
		expect(existsSync(join(cwd, "t.jsonl"))).toBe(false);

		const traceExport = await runCli(["--trace", join(cwd, "t.jsonl"), "--export", "x.jsonl"], cwd, agentDir);
		expect(traceExport.code).toBe(1);
		expect(traceExport.stderr).toContain("--trace cannot be combined with --export");
		expect(existsSync(join(cwd, "t.jsonl"))).toBe(false);
	});
});

describe("--trace", () => {
	it("refuses an existing file and closes the capture when the CLI exits", async () => {
		const { cwd, agentDir } = workspace();
		const existing = join(cwd, "existing.jsonl");
		writeFileSync(existing, "keep");
		const refused = await runCli(["--trace", existing, "-p", "hi"], cwd, agentDir, { closeStdin: true });
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("Cannot create trace file");
		expect(readFileSync(existing, "utf-8")).toBe("keep");

		// No model is configured, so print mode exits early; the capture is still closed.
		const path = join(cwd, "run.trace.jsonl");
		const result = await runCli(["--trace", path, "--no-extensions", "-p", "hi"], cwd, agentDir, {
			closeStdin: true,
		});
		expect(result.code).toBe(1);
		const trace = parseTrace(readFileSync(path, "utf-8"));
		expect(trace.complete).toBe(true);
		const types = trace.records.map((record) => record.type);
		expect(types.slice(0, 2)).toEqual(["header", "session_attach"]);
		expect(types.slice(-2)).toEqual(["session_detach", "trace_end"]);
		expect(types).not.toContain("run_start");
	});
});
