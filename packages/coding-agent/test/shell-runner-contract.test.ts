import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeOutstandingDockerContainers } from "../src/core/docker-shell-runner.ts";
import { resolveShellRunner } from "../src/core/shell-runner.ts";
import {
	type BashOperations,
	createBashTool,
	createLocalBashOperations,
	createLocalShellOperations,
} from "../src/core/tools/bash.ts";
import { installFakeDocker } from "./fake-docker-cli.ts";
import { createFakeShellRunner, type FakeShellRunner } from "./fake-shell-runner.ts";

// issue #17: every runner (host, fake, Docker) must satisfy the same BashOperations contract.

interface RunnerUnderTest {
	operations: BashOperations;
	fake?: FakeShellRunner;
	cleanup?: () => void;
}

const runners: Array<[string, (dir: string) => Promise<RunnerUnderTest>]> = [
	["host", async () => ({ operations: createLocalBashOperations() })],
	[
		"fake",
		async () => {
			const fake = createFakeShellRunner();
			return { operations: fake.operations, fake };
		},
	],
	[
		// The Docker adapter's own code path, against the fake docker CLI. Real Docker is covered by
		// docker-shell-runner.integration.test.ts.
		"docker (fake CLI)",
		async (dir) => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "shell-runner-contract-docker-")));
			const docker = installFakeDocker(root);
			vi.stubEnv("PATH", `${docker.binDir}:${process.env.PATH}`);
			vi.stubEnv("FAKE_DOCKER_STATE", docker.stateDir);
			vi.stubEnv("DOCKER_HOST", undefined);
			vi.stubEnv("DOCKER_CONTEXT", undefined);
			const selection = await resolveShellRunner(
				{ settings: { type: "docker", image: "shell:test", envAllowlist: ["CONTRACT_VAR"] } },
				dir,
			);
			if (selection.kind !== "docker") throw new Error(`expected docker, got ${selection.notice}`);
			return {
				operations: selection.operations,
				cleanup: () => {
					removeOutstandingDockerContainers();
					vi.unstubAllEnvs();
					rmSync(root, { recursive: true, force: true });
				},
			};
		},
	],
];

const describeUnix = process.platform === "win32" ? describe.skip : describe;

function collect() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		onData: (data: Buffer) => stdout.push(data.toString()),
		onStderr: (data: Buffer) => stderr.push(data.toString()),
	};
}

describeUnix.each(runners)("shell runner contract: %s", (_name, create) => {
	let dir: string;
	let runner: RunnerUnderTest;

	beforeEach(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "shell-runner-contract-")));
		runner = await create(dir);
	});

	afterEach(() => {
		runner.cleanup?.();
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes command, cwd, env and timeout through exactly", async () => {
		const output = collect();
		const env = { ...process.env, CONTRACT_VAR: "value with spaces" };
		const result = await runner.operations.exec('printf "%s|%s" "$PWD" "$CONTRACT_VAR"', dir, {
			onData: output.onData,
			env,
			timeout: 30,
		});
		expect(result.exitCode).toBe(0);
		expect(output.stdout.join("")).toBe(`${dir}|value with spaces`);
		if (runner.fake) {
			expect(runner.fake.calls).toEqual([
				{ command: 'printf "%s|%s" "$PWD" "$CONTRACT_VAR"', cwd: dir, env, timeout: 30, hasStdin: false },
			]);
		}
	});

	it("streams stdin and closes it immediately when none is given", async () => {
		const withInput = collect();
		const stdin = new PassThrough();
		const run = runner.operations.exec("cat", dir, { onData: withInput.onData, stdin });
		stdin.write("line one\n");
		stdin.end("line two\n");
		expect((await run).exitCode).toBe(0);
		expect(withInput.stdout.join("")).toBe("line one\nline two\n");
		expect(stdin.listenerCount("error")).toBe(0);

		const withoutInput = collect();
		expect((await runner.operations.exec("cat", dir, { onData: withoutInput.onData, timeout: 10 })).exitCode).toBe(0);
		expect(withoutInput.stdout.join("")).toBe("");
	});

	it("survives an early exit with unread stdin and leaves the caller stream open", async () => {
		const stdin = new PassThrough();
		stdin.write(Buffer.alloc(1024 * 1024, "x"));
		const result = await runner.operations.exec("exit 0", dir, { onData: () => {}, stdin });
		expect(result.exitCode).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(stdin.destroyed).toBe(false);
		stdin.end();
	});

	it("rejects an input failure during preparation without starting the command", async () => {
		const sentinel = join(dir, "sentinel");
		const stdin = new PassThrough();
		const run = runner.operations.exec(`touch ${sentinel}`, dir, { onData: () => {}, stdin });
		stdin.destroy(new Error("broke during preparation"));
		await expect(run).rejects.toThrow(/Failed to stream stdin.*broke during preparation/);
		expect(stdin.listenerCount("error")).toBe(0);

		const alreadyFailed = new PassThrough();
		alreadyFailed.on("error", () => {});
		alreadyFailed.destroy(new Error("failed before the call"));
		await new Promise((resolve) => setImmediate(resolve));
		await expect(
			runner.operations.exec(`touch ${sentinel}`, dir, { onData: () => {}, stdin: alreadyFailed }),
		).rejects.toThrow(/Failed to stream stdin.*failed before the call/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(sentinel)).toBe(false);
		expect(runner.fake?.calls ?? []).toEqual([]);
	});

	it("rejects when the stdin stream fails", async () => {
		const stdin = new PassThrough();
		const run = runner.operations.exec("cat", dir, { onData: () => {}, stdin, timeout: 10 });
		setTimeout(() => stdin.destroy(new Error("input broke")), 50);
		await expect(run).rejects.toThrow(/Failed to stream stdin.*input broke/);
	});

	it("keeps stderr separate when onStderr is given and merges it otherwise", async () => {
		const separate = collect();
		await runner.operations.exec("printf out; printf err >&2", dir, {
			onData: separate.onData,
			onStderr: separate.onStderr,
		});
		expect(separate.stdout.join("")).toBe("out");
		expect(separate.stderr.join("")).toBe("err");

		const merged = collect();
		await runner.operations.exec("printf out; printf err >&2", dir, { onData: merged.onData });
		expect(merged.stdout.join("").split("").sort().join("")).toBe("eorrtu");
	});

	it("reports exit codes, including 128 + signal number", async () => {
		expect((await runner.operations.exec("exit 3", dir, { onData: () => {} })).exitCode).toBe(3);
		expect((await runner.operations.exec("kill -TERM $$", dir, { onData: () => {} })).exitCode).toBe(143);
	});

	it("starts nothing when aborted before the call, during preparation, or given an invalid timeout", async () => {
		const sentinel = join(dir, "sentinel");
		const preAborted = new AbortController();
		preAborted.abort();
		await expect(
			runner.operations.exec(`touch ${sentinel}`, dir, { onData: () => {}, signal: preAborted.signal }),
		).rejects.toThrow(/^aborted$/);

		const duringPreparation = new AbortController();
		const run = runner.operations.exec(`touch ${sentinel}`, dir, {
			onData: () => {},
			signal: duringPreparation.signal,
		});
		duringPreparation.abort();
		await expect(run).rejects.toThrow(/^aborted$/);

		await expect(runner.operations.exec(`touch ${sentinel}`, dir, { onData: () => {}, timeout: -1 })).rejects.toThrow(
			/Invalid timeout/,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(sentinel)).toBe(false);
		expect(runner.fake?.calls ?? []).toEqual([]);
	});

	it("rejects with raw aborted and timeout errors and calls nothing after settling", async () => {
		const received: string[] = [];
		const controller = new AbortController();
		const aborted = runner.operations.exec("printf a; sleep 10", dir, {
			onData: (data) => {
				received.push(data.toString());
				controller.abort();
			},
			signal: controller.signal,
		});
		await expect(aborted).rejects.toThrow(/^aborted$/);
		const countAtSettlement = received.length;

		await expect(runner.operations.exec("sleep 10", dir, { onData: () => {}, timeout: 0.3 })).rejects.toThrow(
			/^timeout:0.3$/,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(received.length).toBe(countAtSettlement);
		expect(received.join("")).toBe("a");
	});

	it("keeps the tool-level abort and timeout text", async () => {
		const tool = createBashTool(dir, { operations: runner.operations });
		await expect(tool.execute("call-1", { command: "sleep 10", timeout: 0.3 })).rejects.toThrow(
			"Command timed out after 0.3 seconds",
		);
		const controller = new AbortController();
		const run = tool.execute("call-2", { command: "sleep 10" }, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(run).rejects.toThrow("Command aborted");
	});
});

describeUnix("host shell runner", () => {
	it("rejects a stdin stream when the shell reads the command from stdin", async () => {
		// issue #17: legacy WSL bash receives the command on stdin, so caller input cannot share it.
		const operations = createLocalShellOperations("bash", () => ({
			shell: "/bin/sh",
			args: ["-s"],
			commandTransport: "stdin",
		}));
		await expect(operations.exec("true", tmpdir(), { onData: () => {}, stdin: new PassThrough() })).rejects.toThrow(
			/cannot be supplied/,
		);
		const output = collect();
		expect((await operations.exec("printf ok", tmpdir(), { onData: output.onData })).exitCode).toBe(0);
		expect(output.stdout.join("")).toBe("ok");
	});
});
