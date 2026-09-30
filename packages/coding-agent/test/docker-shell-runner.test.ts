import { spawnSync } from "node:child_process";
import fs, {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import {
	buildDockerEnvFile,
	buildDockerRunArgs,
	removeOutstandingDockerContainers,
} from "../src/core/docker-shell-runner.ts";
import type { ShellRunnerSettings } from "../src/core/settings-manager.ts";
import { resolveShellRunner, type ShellRunnerSelection } from "../src/core/shell-runner.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker-cli.ts";

// issue #17: Docker shell runner behavior against a fake docker CLI.

const describeUnix = process.platform === "win32" ? describe.skip : describe;
const isRoot = process.getuid?.() === 0;

function collect() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		onData: (data: Buffer) => stdout.push(data.toString()),
		onStderr: (data: Buffer) => stderr.push(data.toString()),
		text: () => stdout.join("") + stderr.join(""),
	};
}

function operationsOf(selection: ShellRunnerSelection): BashOperations {
	if (selection.kind === "host") throw new Error("expected a non-host selection");
	return selection.operations;
}

describeUnix("Docker shell runner (fake docker CLI)", () => {
	let root: string;
	let workspace: string;
	let privateTmp: string;
	let docker: FakeDocker;

	const docker_ = (settings: Partial<Extract<ShellRunnerSettings, { type: "docker" }>> = {}) =>
		resolveShellRunner({ settings: { type: "docker", image: "shell:test", ...settings } }, workspace);

	/** Abort once the fake CLI has recorded the next `docker run`, so the abort cannot land during setup. */
	const abortWhenRunning = async (controller: AbortController) => {
		const expected = docker.calls("run").length + 1;
		await vi.waitFor(() => expect(docker.calls("run")).toHaveLength(expected), { timeout: 10_000, interval: 20 });
		controller.abort();
	};

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "docker-shell-runner-")));
		workspace = join(root, "workspace");
		privateTmp = join(root, "private-tmp");
		mkdirSync(workspace);
		mkdirSync(privateTmp);
		docker = installFakeDocker(root);
		vi.stubEnv("PATH", `${docker.binDir}:${process.env.PATH}`);
		vi.stubEnv("FAKE_DOCKER_STATE", docker.stateDir);
		vi.stubEnv("TMPDIR", privateTmp);
		vi.stubEnv("DOCKER_HOST", undefined);
		vi.stubEnv("DOCKER_CONTEXT", undefined);
	});

	afterEach(() => {
		removeOutstandingDockerContainers();
		vi.unstubAllEnvs();
		spawnSync("chmod", ["-R", "u+rwx", root]);
		rmSync(root, { recursive: true, force: true });
	});

	it("builds the documented docker run argv", () => {
		const args = buildDockerRunArgs({
			endpoint: "unix:///run/docker.sock",
			configDir: "/private/config",
			name: "october-shell-42-0a1b2c3d",
			owner: { pid: 42, host: "box", uid: 1000, pidns: "pid:[1]" },
			user: "1000:1000",
			mounts: [
				{ configuredAbsolute: "/w", real: "/w", readOnly: false },
				{ configuredAbsolute: "/w/.git", real: "/w/.git", readOnly: true },
			],
			cwd: "/w/src",
			envFile: "/private/env",
			interactive: false,
			image: "shell:test",
		});
		expect(args).toEqual([
			"--host",
			"unix:///run/docker.sock",
			"--config",
			"/private/config",
			"run",
			"--rm",
			"--pull=never",
			"--name",
			"october-shell-42-0a1b2c3d",
			"--label",
			"dev.october.shell-runner=1",
			"--label",
			"dev.october.shell-runner.pid=42",
			"--label",
			"dev.october.shell-runner.host=box",
			"--label",
			"dev.october.shell-runner.uid=1000",
			"--label",
			"dev.october.shell-runner.pidns=pid:[1]",
			"--user",
			"1000:1000",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--mount",
			"type=bind,source=/w,target=/w",
			"--mount",
			"type=bind,source=/w/.git,target=/w/.git,readonly",
			"-w",
			"/w/src",
			"--env-file",
			"/private/env",
			"--entrypoint",
			"bash",
			"shell:test",
			"-c",
		]);
	});

	it("runs through the frozen absolute executable and endpoint with -i only for stdin", async () => {
		const selection = await docker_({ envAllowlist: ["SECRET_VALUE"] });
		expect(selection.kind).toBe("docker");
		const output = collect();
		const env = { ...process.env, SECRET_VALUE: "do-not-leak-into-argv" };
		const result = await operationsOf(selection).exec("printf hi", workspace, { onData: output.onData, env });
		expect(result.exitCode).toBe(0);
		expect(output.text()).toBe("hi");

		const [run] = docker.calls("run");
		expect(run.executable).toBe(docker.executable);
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		const argv = run.argv;
		expect(argv.slice(0, 2)).toEqual(["--host", "unix:///fake/docker.sock"]);
		expect(argv[2]).toBe("--config");
		expect(argv[3]).toMatch(new RegExp(`^${privateTmp}/october-shell-[^/]+/config$`));
		expect(argv.slice(4, 8)).toEqual(["run", "--rm", "--pull=never", "--name"]);
		expect(argv[8]).toMatch(new RegExp(`^october-shell-${process.pid}-[0-9a-f]{8}$`));
		expect(argv).toContain(`dev.october.shell-runner.pid=${process.pid}`);
		expect(argv).toContain(`dev.october.shell-runner.uid=${uid}`);
		expect(argv.join(" ")).toContain(`--user ${uid}:${gid} --cap-drop=ALL --security-opt=no-new-privileges`);
		expect(argv.join(" ")).toContain(`--mount type=bind,source=${workspace},target=${workspace} -w ${workspace}`);
		expect(argv.slice(-4)).toEqual(["bash", "shell:test", "-c", "printf hi"]);
		expect(argv).not.toContain("-i");
		expect(argv.join("\n")).not.toContain("do-not-leak-into-argv");
		expect(run.run?.interactive).toBe(false);

		const stdin = new PassThrough();
		const echoed = collect();
		const piped = operationsOf(selection).exec("cat", workspace, { onData: echoed.onData, stdin });
		stdin.end("from stdin\n");
		expect((await piped).exitCode).toBe(0);
		expect(echoed.text()).toBe("from stdin\n");
		expect(docker.calls("run")[1].argv).toContain("-i");
	});

	it("writes only allowlisted values to a private env file and an empty client config", async () => {
		const selection = await docker_({
			envAllowlist: ["CI", "EMPTY", "UNICODE", "EQUALS", "MISSING", "HTTPS_PROXY", "DOCKER_HOST"],
		});
		const env = {
			PATH: "/host/bin",
			HOME: "/home/host",
			DOCKER_CONFIG: "/host/docker",
			HTTP_PROXY: "http://not-listed:1",
			HTTPS_PROXY: "http://proxy:3128",
			DOCKER_HOST: "tcp://container-only:2375",
			CI: "true",
			EMPTY: "",
			UNICODE: "héllo ☃ 世界",
			EQUALS: "a=b=c",
			COMMAND_ONLY: "command-env-value",
		};
		const output = collect();
		await operationsOf(selection).exec('printf "%s|%s" "$UNICODE" "$HOME"', workspace, {
			onData: output.onData,
			env,
		});
		expect(output.text()).toBe("héllo ☃ 世界|/tmp");

		const [run] = docker.calls("run");
		expect(run.run?.envFile).toBe(
			"CI=true\nEMPTY=\nUNICODE=héllo ☃ 世界\nEQUALS=a=b=c\nHTTPS_PROXY=http://proxy:3128\nDOCKER_HOST=tcp://container-only:2375\nHOME=/tmp\n",
		);
		expect(run.run?.config).toBe("{}");
		expect(run.run?.modes).toEqual({ dir: "700", envFile: "600", configDir: "700", configFile: "600" });
		// The client keeps its own environment; command values never reach it.
		expect(run.env.COMMAND_ONLY).toBeUndefined();
		expect(run.env.DOCKER_HOST).toBeUndefined();
		expect(run.argv.slice(0, 2)).toEqual(["--host", "unix:///fake/docker.sock"]);
		expect(readdirSync(privateTmp)).toEqual([]);
	});

	it("uses the host shell env when the command env is omitted and keeps an allowlisted HOME", async () => {
		const selection = await docker_({ envAllowlist: ["CI", "HOME"] });
		vi.stubEnv("CI", "from-host");
		vi.stubEnv("HOME", "/home/allowlisted");
		await operationsOf(selection).exec("true", workspace, { onData: () => {} });
		expect(docker.calls("run")[0].run?.envFile).toBe("CI=from-host\nHOME=/home/allowlisted\n");

		const undefinedHome = await docker_({ envAllowlist: ["HOME"] });
		await operationsOf(undefinedHome).exec("true", workspace, { onData: () => {}, env: { PATH: "/bin" } });
		expect(docker.calls("run")[1].run?.envFile).toBe("HOME=/tmp\n");
	});

	it("rejects an input failure during preparation before creating files or a container", async () => {
		const selection = await docker_();
		const stdin = new PassThrough();
		const run = operationsOf(selection).exec("cat", workspace, { onData: () => {}, stdin });
		stdin.destroy(new Error("broke during preparation"));
		await expect(run).rejects.toThrow(/Failed to stream stdin to docker: broke during preparation/);
		expect(stdin.listenerCount("error")).toBe(0);

		const alreadyFailed = new PassThrough();
		alreadyFailed.on("error", () => {});
		alreadyFailed.destroy(new Error("failed before the call"));
		await new Promise((resolve) => setImmediate(resolve));
		await expect(
			operationsOf(selection).exec("cat", workspace, { onData: () => {}, stdin: alreadyFailed }),
		).rejects.toThrow(/failed before the call/);
		expect(docker.calls("run")).toEqual([]);
		expect(docker.calls("rm")).toEqual([]);
		expect(readdirSync(privateTmp)).toEqual([]);
	});

	it.each([
		["LF", "a\nb"],
		["CR", "a\rb"],
		["NUL", "a\0b"],
	])("rejects a %s value before anything starts", async (_name, value) => {
		const selection = await docker_({ envAllowlist: ["BAD"] });
		await expect(
			operationsOf(selection).exec("true", workspace, { onData: () => {}, env: { BAD: value } }),
		).rejects.toThrow(/environment variable BAD contains a line break or NUL/);
		expect(docker.calls("run")).toEqual([]);
		expect(readdirSync(privateTmp)).toEqual([]);
		expect(buildDockerEnvFile({ GOOD: "x" }, ["GOOD"])).toBe("GOOD=x\nHOME=/tmp\n");
	});

	it.each<[string, { host?: string; context?: string; currentContext?: string }, string]>([
		["DOCKER_CONTEXT", { context: "second" }, "unix:///second.sock"],
		["DOCKER_HOST", { host: "unix:///from-docker-host.sock" }, "unix:///from-docker-host.sock"],
		// docker/cli resolveContextName: a non-empty DOCKER_HOST selects the default context first.
		[
			"DOCKER_HOST over DOCKER_CONTEXT",
			{ host: "unix:///from-docker-host.sock", context: "second" },
			"unix:///from-docker-host.sock",
		],
		["the config's currentContext", { currentContext: "first" }, "unix:///first.sock"],
		["DOCKER_CONTEXT over currentContext", { context: "second", currentContext: "first" }, "unix:///second.sock"],
		["the default context", {}, "unix:///fake/docker.sock"],
	])("resolves the endpoint through %s", async (_name, env, expected) => {
		docker.set("contexts.json", JSON.stringify({ first: "unix:///first.sock", second: "unix:///second.sock" }));
		const configDir = join(root, "docker-config");
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify(env.currentContext ? { currentContext: env.currentContext } : {}),
		);
		vi.stubEnv("DOCKER_CONFIG", configDir);
		vi.stubEnv("DOCKER_HOST", env.host);
		vi.stubEnv("DOCKER_CONTEXT", env.context);

		const selection = await docker_();
		await operationsOf(selection).exec("true", workspace, { onData: () => {} });
		const run = docker.calls("run").at(-1);
		expect(run?.argv.slice(0, 2)).toEqual(["--host", expected]);
		// The frozen --host is the only endpoint the client sees.
		expect(run?.env.DOCKER_HOST).toBeUndefined();
		expect(run?.env.DOCKER_CONTEXT).toBeUndefined();
	});

	it("keeps the startup endpoint and executable after context, config or PATH changes", async () => {
		docker.set("contexts.json", JSON.stringify({ first: "unix:///first.sock", second: "unix:///second.sock" }));
		vi.stubEnv("DOCKER_CONTEXT", "first");
		const selection = await docker_();
		expect(selection.kind).toBe("docker");

		vi.stubEnv("DOCKER_CONTEXT", "second");
		vi.stubEnv("DOCKER_HOST", "unix:///changed.sock");
		vi.stubEnv("DOCKER_CONFIG", join(root, "other-config"));
		const other = installFakeDocker(join(root, "other"));
		vi.stubEnv("PATH", `${other.binDir}:${process.env.PATH}`);
		docker.set("ps.json", "[]");

		const controller = new AbortController();
		const run = operationsOf(selection).exec("sleep 10", workspace, { onData: () => {}, signal: controller.signal });
		await abortWhenRunning(controller);
		await expect(run).rejects.toThrow(/^aborted$/);
		removeOutstandingDockerContainers();

		expect(other.calls()).toEqual([]);
		const calls = docker.calls();
		expect(calls.map((call) => call.sub)).toEqual(["context", "ps", "run", "rm", "rm"]);
		for (const call of calls.slice(1)) {
			expect(call.argv.slice(0, 2)).toEqual(["--host", "unix:///first.sock"]);
			expect(call.executable).toBe(docker.executable);
		}
	});

	it("freezes an absolute executable found through a relative PATH entry", async () => {
		const previousCwd = process.cwd();
		vi.stubEnv("PATH", `${relative(root, docker.binDir)}:${process.env.PATH}`);
		process.chdir(root);
		let selection: ShellRunnerSelection;
		try {
			selection = await docker_();
		} finally {
			process.chdir(previousCwd);
		}
		expect(selection.kind).toBe("docker");
		expect((await operationsOf(selection).exec("true", workspace, { onData: () => {} })).exitCode).toBe(0);
		expect(docker.calls("run")[0].executable).toBe(docker.executable);
	});

	it.each(["tcp://127.0.0.1:2375", "ssh://user@host"])("rejects every command for endpoint %s", async (endpoint) => {
		vi.stubEnv("DOCKER_HOST", endpoint);
		const selection = await docker_();
		expect(selection.kind).toBe("invalid");
		expect(selection.notice).toContain(`endpoint ${endpoint} is not a local unix:// socket`);
		const sentinel = join(workspace, "sentinel");
		await expect(operationsOf(selection).exec(`touch ${sentinel}`, workspace, { onData: () => {} })).rejects.toThrow(
			/Shell runner: blocked/,
		);
		expect(existsSync(sentinel)).toBe(false);
		expect(docker.calls("run")).toEqual([]);
	});

	it("reports a missing docker CLI without running anything", async () => {
		vi.stubEnv("PATH", "/nonexistent-bin");
		const selection = await docker_();
		expect(selection.kind).toBe("invalid");
		expect(selection.notice).toContain("docker CLI not found");
		expect(selection.notice).toContain("restart");
		await expect(operationsOf(selection).exec("true", workspace, { onData: () => {} })).rejects.toThrow(
			/docker CLI not found/,
		);
	});

	describe("settings validation", () => {
		it.each<[string, unknown, RegExp]>([
			["null", null, /shellRunner must be an object/],
			["unknown type", { type: "podman" }, /shellRunner.type must be "host" or "docker"/],
			["unknown field", { type: "docker", image: "x", mount: [] }, /shellRunner.mount is not a supported field/],
			["empty image", { type: "docker", image: "" }, /shellRunner.image/],
			["option-like image", { type: "docker", image: "--privileged" }, /shellRunner.image/],
			["mounts not an array", { type: "docker", image: "x", mounts: "." }, /mounts must be an array/],
			["mount without path", { type: "docker", image: "x", mounts: [{}] }, /mounts\[0\] must be an object/],
			[
				"non-boolean readOnly",
				{ type: "docker", image: "x", mounts: [{ path: ".", readOnly: "yes" }] },
				/mounts\[0\].readOnly/,
			],
			["bad env name", { type: "docker", image: "x", envAllowlist: ["1BAD"] }, /envAllowlist entry "1BAD"/],
			["bad user", { type: "docker", image: "x", user: "root" }, /shellRunner.user/],
			[
				"missing mount",
				{ type: "docker", image: "x", mounts: [{ path: "missing" }] },
				/mount missing does not exist/,
			],
		])("rejects %s", async (_name, settings, cause) => {
			const selection = await resolveShellRunner({ settings: settings as ShellRunnerSettings }, workspace);
			expect(selection.kind).toBe("invalid");
			expect(selection.notice).toMatch(cause);
			const sentinel = join(workspace, "sentinel");
			await expect(
				operationsOf(selection).exec(`touch ${sentinel}`, workspace, { onData: () => {} }),
			).rejects.toThrow(cause);
			expect(existsSync(sentinel)).toBe(false);
		});

		it("rejects a file mount, duplicate mounts and characters Docker mount options cannot carry", async () => {
			writeFileSync(join(workspace, "file"), "");
			expect((await docker_({ mounts: [{ path: "file" }] })).notice).toMatch(/is not a directory/);

			symlinkSync(workspace, join(root, "link"));
			const duplicate = await docker_({ mounts: [{ path: "." }, { path: join(root, "link") }] });
			expect(duplicate.notice).toMatch(/both resolve to .*workspace; list each directory once/);

			mkdirSync(join(workspace, "a,b"));
			expect((await docker_({ mounts: [{ path: "a,b" }] })).notice).toMatch(/comma, quote or control character/);
		});

		it("resolves default, relative, ~ and nested mounts against the initial cwd", async () => {
			mkdirSync(join(workspace, ".git"));
			const home = join(root, "home");
			mkdirSync(join(home, "cache"), { recursive: true });
			vi.stubEnv("HOME", home);

			const defaults = await docker_();
			expect(defaults.notice).toContain(`Mounts: ${workspace} (read-write).`);
			expect(defaults.notice).toContain("Environment allowlist: none.");
			expect(defaults.notice).toContain("Only the built-in bash tool and ! commands run in the container");

			const selection = await docker_({
				mounts: [{ path: "." }, { path: ".git", readOnly: true }, { path: "~/cache" }],
				envAllowlist: ["CI", "TERM"],
			});
			expect(selection.kind).toBe("docker");
			expect(selection.notice).toBe(
				`Shell runner: docker (image shell:test). Mounts: ${workspace} (read-write), ${workspace}/.git (read-only), ${home}/cache (read-write). Environment allowlist: CI, TERM. Only the built-in bash tool and ! commands run in the container; other built-in tools and the Harness run on the host, and extension-provided shell routes are extension-owned and outside this policy.`,
			);
		});

		it("warns when a mount contains the agent directory", async () => {
			const home = join(root, "home");
			mkdirSync(join(home, ".october", "agent"), { recursive: true });
			vi.stubEnv("HOME", home);
			vi.stubEnv(ENV_AGENT_DIR, undefined);
			const agentDir = join(home, ".october", "agent");
			const warning = `Warning: mount ${home} contains the agent directory ${agentDir}; commands can read its credentials (auth.json).`;

			expect((await docker_({ mounts: [{ path: "~", readOnly: true }] })).notice).toContain(
				`outside this policy. ${warning}`,
			);
			expect((await docker_({ mounts: [{ path: "~/.october/agent" }] })).notice).toContain(
				`mount ${agentDir} contains the agent directory ${agentDir}`,
			);
			expect((await docker_()).notice).not.toContain("agent directory");
			// A sibling with the same prefix does not contain it.
			mkdirSync(join(home, ".october", "agent2"));
			expect((await docker_({ mounts: [{ path: "~/.october/agent2" }] })).notice).not.toContain("agent directory");
		});

		it("rejects the Docker runner on a Windows host", async () => {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				const selection = await docker_();
				expect(selection.kind).toBe("invalid");
				expect(selection.notice).toContain("not supported on Windows hosts");
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
			expect(docker.calls()).toEqual([]);
		});
	});

	describe("working directory and mount checks", () => {
		it("rejects a cwd outside every mount, including a sibling with the same prefix", async () => {
			const sibling = `${workspace}2`;
			mkdirSync(sibling);
			const selection = await docker_();
			const sentinel = join(sibling, "sentinel");
			await expect(operationsOf(selection).exec(`touch ${sentinel}`, sibling, { onData: () => {} })).rejects.toThrow(
				`working directory ${sibling} is outside every configured mount`,
			);
			expect(existsSync(sentinel)).toBe(false);

			const noMounts = await docker_({ mounts: [] });
			expect(noMounts.notice).toContain("Mounts: none.");
			await expect(operationsOf(noMounts).exec("true", workspace, { onData: () => {} })).rejects.toThrow(
				/outside every configured mount/,
			);
			expect(docker.calls("run")).toEqual([]);
		});

		it("accepts nested cwd and the root mount", async () => {
			mkdirSync(join(workspace, "src"));
			const selection = await docker_({ mounts: [{ path: "/", readOnly: true }] });
			expect(selection.notice).toContain("Mounts: / (read-only).");
			expect(
				(await operationsOf(selection).exec("true", join(workspace, "src"), { onData: () => {} })).exitCode,
			).toBe(0);
			expect(docker.calls("run")[0].argv).toContain("type=bind,source=/,target=/,readonly");
		});

		it("rejects a mount that was replaced or whose symlink was retargeted after startup", async () => {
			const target = join(root, "target");
			const other = join(root, "other");
			mkdirSync(target);
			mkdirSync(other);
			symlinkSync(target, join(root, "via-link"));
			const viaLink = await docker_({ mounts: [{ path: join(root, "via-link") }, { path: "." }] });
			rmSync(join(root, "via-link"));
			symlinkSync(other, join(root, "via-link"));
			await expect(operationsOf(viaLink).exec("true", workspace, { onData: () => {} })).rejects.toThrow(
				`mount ${join(root, "via-link")} now resolves to ${other} instead of ${target}`,
			);

			const direct = await docker_({ mounts: [{ path: target }, { path: "." }] });
			rmSync(target, { recursive: true });
			symlinkSync(other, target);
			await expect(operationsOf(direct).exec("true", workspace, { onData: () => {} })).rejects.toThrow(
				/now resolves to .*other/,
			);
			rmSync(target);
			await expect(operationsOf(direct).exec("true", workspace, { onData: () => {} })).rejects.toThrow(
				`mount ${target} no longer exists`,
			);
			expect(docker.calls("run")).toEqual([]);
		});
	});

	describe("container cleanup", () => {
		function lastName(): string {
			const run = docker.calls("run").at(-1)!;
			return run.argv[run.argv.indexOf("--name") + 1];
		}

		it.each<[string, string, string | undefined, number | undefined]>([
			["success", "true", undefined, 0],
			["non-zero exit", "exit 3", undefined, 3],
			["client exit 1", "exit 1", undefined, 1],
			["client exit 125", "true", "missing-image", 125],
		])("removes the container after %s and forgets it", async (_name, command, behavior, exitCode) => {
			if (behavior) docker.set("run-behavior", behavior);
			const selection = await docker_();
			const output = collect();
			const result = await operationsOf(selection).exec(command, workspace, {
				onData: output.onData,
				onStderr: output.onStderr,
			});
			expect(result.exitCode).toBe(exitCode);
			const name = lastName();
			const [rm] = docker.calls("rm");
			expect(rm.argv).toEqual(["--host", "unix:///fake/docker.sock", "rm", "-f", "-v", name]);
			expect(output.text()).not.toContain("could not confirm removal");
			expect(readdirSync(privateTmp)).toEqual([]);
			removeOutstandingDockerContainers();
			expect(docker.calls("rm")).toHaveLength(1);
		});

		it.each(["abort", "timeout"])("removes the container after %s and keeps it for the exit hook", async (kind) => {
			const selection = await docker_();
			const controller = new AbortController();
			const run = operationsOf(selection).exec("sleep 10", workspace, {
				onData: () => {},
				signal: controller.signal,
				timeout: kind === "timeout" ? 0.5 : undefined,
			});
			if (kind === "abort") await abortWhenRunning(controller);
			await expect(run).rejects.toThrow(kind === "abort" ? /^aborted$/ : /^timeout:0.5$/);
			const name = lastName();
			expect(docker.containerExists(name)).toBe(false);
			expect(docker.calls("rm").map((call) => call.argv.at(-1))).toEqual([name]);
			removeOutstandingDockerContainers();
			expect(docker.calls("rm").map((call) => call.argv.at(-1))).toEqual([name, name]);
			expect(readdirSync(privateTmp)).toEqual([]);
		});

		it("starts nothing when aborted during setup", async () => {
			const selection = await docker_();
			const controller = new AbortController();
			const run = operationsOf(selection).exec("true", workspace, { onData: () => {}, signal: controller.signal });
			controller.abort();
			await expect(run).rejects.toThrow(/^aborted$/);
			expect(docker.calls("run")).toEqual([]);
			expect(docker.calls("rm")).toEqual([]);
			expect(readdirSync(privateTmp)).toEqual([]);
		});

		it.each<[string, "mkdir" | "writeFile", string]>([
			["creating the config directory", "mkdir", "config"],
			["writing config.json", "writeFile", "config.json"],
		])("cleans up and runs nothing when %s fails after the env file exists", async (_step, operation, target) => {
			const selection = await docker_({ envAllowlist: ["CI"] });
			const sentinel = join(workspace, "sentinel");
			const original = fsPromises[operation];
			const seen: string[] = [];
			// Fail only the chosen private setup step; earlier steps (mkdtemp, env file) really happen.
			const failing = (async (path: fs.PathLike, ...rest: unknown[]) => {
				const text = String(path);
				if (text.startsWith(privateTmp)) {
					seen.push(...readdirSync(join(privateTmp, readdirSync(privateTmp)[0])));
					if (text.endsWith(`/${target}`)) throw new Error(`injected ${operation} failure`);
				}
				return (original as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
			}) as typeof original;
			(fsPromises as Record<string, unknown>)[operation] = failing;
			syncBuiltinESMExports();
			try {
				await expect(
					operationsOf(selection).exec(`touch ${sentinel}`, workspace, { onData: () => {}, env: { CI: "1" } }),
				).rejects.toThrow(`injected ${operation} failure`);
			} finally {
				(fsPromises as Record<string, unknown>)[operation] = original;
				syncBuiltinESMExports();
			}
			// The env file existed when the failing step ran, so this was a partial setup.
			expect(seen).toContain("env");
			expect(docker.calls("run")).toEqual([]);
			expect(docker.calls("rm")).toEqual([]);
			expect(existsSync(sentinel)).toBe(false);
			expect(readdirSync(privateTmp)).toEqual([]);
		});

		it("removes a container created after an aborted client exited, from the exit hook", async () => {
			expect(process.listeners("exit")).toContain(removeOutstandingDockerContainers);
			docker.set("run-behavior", "late-create");
			const selection = await docker_();
			const controller = new AbortController();
			const run = operationsOf(selection).exec("sleep 10", workspace, {
				onData: () => {},
				signal: controller.signal,
			});
			await abortWhenRunning(controller);
			await expect(run).rejects.toThrow(/^aborted$/);
			const name = lastName();
			await new Promise((resolve) => setTimeout(resolve, 700));
			expect(docker.containerExists(name)).toBe(true);
			removeOutstandingDockerContainers();
			expect(docker.containerExists(name)).toBe(false);
		});

		it("reports a failed removal without changing a successful result", async () => {
			docker.set("rm-behavior", "fail");
			const selection = await docker_();
			const output = collect();
			const result = await operationsOf(selection).exec("printf done", workspace, {
				onData: output.onData,
				onStderr: output.onStderr,
			});
			expect(result.exitCode).toBe(0);
			expect(output.stdout.join("")).toBe("done");
			expect(output.stderr.join("")).toContain(
				`Docker shell runner: could not confirm removal of container ${lastName()} on unix:///fake/docker.sock: Cannot connect to the Docker daemon`,
			);
		});

		it("keeps the removal failure line in a cancelled ! command result", async () => {
			docker.set("rm-behavior", "fail");
			const selection = await docker_();
			const controller = new AbortController();
			const run = executeBashWithOperations("sleep 10", workspace, operationsOf(selection), {
				signal: controller.signal,
			});
			await abortWhenRunning(controller);
			const result = await run;
			expect(result.cancelled).toBe(true);
			expect(result.output).toContain("could not confirm removal of container october-shell-");
		});

		it("keeps an already-in-progress removal silently for the exit hook", async () => {
			docker.set("rm-behavior", "in-progress");
			const selection = await docker_();
			const output = collect();
			await operationsOf(selection).exec("true", workspace, { onData: output.onData });
			expect(output.text()).toBe("");
			docker.set("rm-behavior", "");
			removeOutstandingDockerContainers();
			expect(docker.calls("rm")).toHaveLength(2);
		});

		it("reports a spawn failure and still attempts removal", async () => {
			const selection = await docker_();
			rmSync(docker.executable);
			const output = collect();
			await expect(
				operationsOf(selection).exec("true", workspace, { onData: output.onData, onStderr: output.onStderr }),
			).rejects.toThrow(/ENOENT/);
			expect(output.stderr.join("")).toMatch(/could not confirm removal of container october-shell-.*ENOENT/);
			expect(readdirSync(privateTmp)).toEqual([]);
		});

		it.skipIf(isRoot)("reports a private file deletion failure and still removes the container", async () => {
			docker.set("run-behavior", "lock-private-dir");
			const selection = await docker_();
			const output = collect();
			const result = await operationsOf(selection).exec("printf ok", workspace, {
				onData: output.onData,
				onStderr: output.onStderr,
			});
			expect(result.exitCode).toBe(0);
			expect(output.stdout.join("")).toBe("ok");
			expect(output.stderr.join("")).toMatch(
				new RegExp(
					`could not remove the private env/config directory ${privateTmp}/october-shell-[^:]+: .*Remove it manually`,
				),
			);
			expect(docker.calls("rm")).toHaveLength(1);
			expect(readdirSync(privateTmp)).toHaveLength(1);
			for (const entry of readdirSync(privateTmp)) chmodSync(join(privateTmp, entry, "locked"), 0o700);
		});

		it("cleans up each runner on its own endpoint", async () => {
			vi.stubEnv("DOCKER_HOST", "unix:///a.sock");
			const first = await docker_();
			vi.stubEnv("DOCKER_HOST", "unix:///b.sock");
			const second = await docker_();
			for (const selection of [first, second]) {
				const controller = new AbortController();
				const run = operationsOf(selection).exec("sleep 10", workspace, {
					onData: () => {},
					signal: controller.signal,
				});
				await abortWhenRunning(controller);
				await expect(run).rejects.toThrow(/^aborted$/);
			}
			const names = docker.calls("run").map((call) => call.argv[call.argv.indexOf("--name") + 1]);
			const before = docker.calls("rm").length;
			removeOutstandingDockerContainers();
			const hookCalls = docker.calls("rm").slice(before);
			expect(hookCalls.map((call) => [call.argv[1], call.argv.slice(5)])).toEqual([
				["unix:///a.sock", [names[0]]],
				["unix:///b.sock", [names[1]]],
			]);
		});
	});

	describe("startup sweep", () => {
		function deadPid(): number {
			const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
				encoding: "utf8",
			});
			return Number(child.stdout);
		}

		function labels(pid: number | string, overrides: Record<string, string> = {}) {
			return {
				"dev.october.shell-runner": "1",
				"dev.october.shell-runner.pid": String(pid),
				"dev.october.shell-runner.host": hostname(),
				"dev.october.shell-runner.uid": String(process.getuid?.()),
				"dev.october.shell-runner.pidns": ownPidns(),
				...overrides,
			};
		}

		function ownPidns(): string {
			return process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : "none";
		}

		const id = (n: number) => n.toString(16).padStart(64, "0");

		it("removes only same-host, same-uid, same-namespace containers whose owner is dead", async () => {
			const dead = deadPid();
			docker.set(
				"ps.json",
				JSON.stringify([
					{ id: id(1), labels: labels(dead) },
					{ id: id(2), labels: labels(process.ppid) },
					{ id: id(3), labels: labels(1) },
					{ id: id(4), labels: labels(dead, { "dev.october.shell-runner.pidns": "pid:[999]" }) },
					{ id: id(5), labels: labels(dead, { "dev.october.shell-runner.host": "other-host" }) },
					{ id: id(6), labels: labels(dead, { "dev.october.shell-runner.uid": "99999" }) },
					{ id: id(7), labels: labels("not-a-pid") },
					{ id: id(8), labels: { ...labels(process.ppid), note: `dev.october.shell-runner.pid=${dead},x=y` } },
					{ id: "short", labels: labels(dead) },
				]),
			);
			const selection = await docker_();
			await operationsOf(selection).exec("true", workspace, { onData: () => {} });
			const [ps] = docker.calls("ps");
			expect(ps.argv.slice(0, 2)).toEqual(["--host", "unix:///fake/docker.sock"]);
			const sweepRemovals = docker.calls("rm").filter((call) => call.argv.some((arg) => /^[0-9a-f]{64}$/.test(arg)));
			// Live (parent), EPERM (pid 1 when not root), foreign and malformed records are kept.
			expect(sweepRemovals.map((call) => call.argv.slice(5))).toEqual([[id(1)]]);
		});

		it("reports a sweep failure once and still runs commands", async () => {
			docker.set("ps-fail", "");
			const unhandled = vi.fn();
			process.on("unhandledRejection", unhandled);
			try {
				const selection = await docker_();
				await new Promise((resolve) => setTimeout(resolve, 300));
				const first = collect();
				const second = collect();
				await Promise.all([
					operationsOf(selection).exec("printf one", workspace, {
						onData: first.onData,
						onStderr: first.onStderr,
					}),
					operationsOf(selection).exec("printf two", workspace, {
						onData: second.onData,
						onStderr: second.onStderr,
					}),
				]);
				const reports = [first, second].filter((output) =>
					output.stderr.join("").includes("could not list stale containers on unix:///fake/docker.sock"),
				);
				expect(reports).toHaveLength(1);
				expect(first.stdout.join("") + second.stdout.join("")).toMatch(/^(onetwo|twoone)$/);
				expect(docker.calls("ps")).toHaveLength(1);
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off("unhandledRejection", unhandled);
			}
		});

		it.runIf(process.platform === "linux")("skips the sweep when the PID namespace cannot be read", async () => {
			const original = fs.readlinkSync;
			fs.readlinkSync = (() => {
				throw new Error("EACCES");
			}) as typeof fs.readlinkSync;
			syncBuiltinESMExports();
			let selection: ShellRunnerSelection;
			try {
				selection = await docker_();
			} finally {
				fs.readlinkSync = original;
				syncBuiltinESMExports();
			}
			const output = collect();
			await operationsOf(selection).exec("true", workspace, { onData: output.onData, onStderr: output.onStderr });
			expect(docker.calls("ps")).toEqual([]);
			expect(output.stderr.join("")).toContain("skipped removing stale containers");
			expect(docker.calls("run")[0].argv).toContain("dev.october.shell-runner.pidns=unknown");
		});
	});
});
