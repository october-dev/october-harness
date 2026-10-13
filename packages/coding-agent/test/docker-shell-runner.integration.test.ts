import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeOutstandingDockerContainers } from "../src/core/docker-shell-runner.ts";
import type { ShellRunnerSettings } from "../src/core/settings-manager.ts";
import { resolveShellRunner } from "../src/core/shell-runner.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

// issue #17: Docker shell runner against a real local Docker daemon. Runs only when `docker info`
// succeeds on a unix:// endpoint and the test image is already present; it never pulls images.

const image = process.env.PI_DOCKER_TEST_IMAGE ?? "bash:5.2";

function preflight(): { skip: string } | { endpoint: string } {
	if (process.platform === "win32") return { skip: "Windows host" };
	const run = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 15_000 });
	const context = run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
	if (context.error) return { skip: "docker CLI not found" };
	const endpoint = context.stdout.trim();
	if (context.status !== 0 || !endpoint.startsWith("unix://")) {
		return { skip: `Docker endpoint ${endpoint || "unknown"} is not a local unix:// socket` };
	}
	if (run(["info"]).status !== 0) return { skip: "docker info failed" };
	if (run(["image", "inspect", image]).status !== 0) {
		return { skip: `image ${image} is not present locally; run docker pull ${image}` };
	}
	return { endpoint };
}

const status = preflight();
const skipReason = "skip" in status ? status.skip : undefined;

describe.skipIf(skipReason !== undefined)(
	`Docker shell runner with real Docker${skipReason ? ` (skipped: ${skipReason})` : ""}`,
	() => {
		const endpoint = "endpoint" in status ? status.endpoint : "";
		let root: string;
		let workspace: string;

		beforeEach(() => {
			root = realpathSync(mkdtempSync(join(tmpdir(), "docker-shell-runner-it-")));
			workspace = join(root, "workspace");
			mkdirSync(join(workspace, "ro", "nested"), { recursive: true });
			vi.stubEnv("DOCKER_HOST", endpoint);
			vi.stubEnv("DOCKER_CONTEXT", undefined);
		});

		afterEach(() => {
			removeOutstandingDockerContainers();
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		});

		async function runner(settings: Partial<Extract<ShellRunnerSettings, { type: "docker" }>> = {}) {
			const selection = await resolveShellRunner({ settings: { type: "docker", image, ...settings } }, workspace);
			if (selection.kind !== "docker") throw new Error(`expected docker, got ${selection.notice}`);
			return selection.operations;
		}

		async function exec(
			operations: BashOperations,
			command: string,
			options: { env?: NodeJS.ProcessEnv; stdin?: PassThrough; signal?: AbortSignal; timeout?: number } = {},
		) {
			let stdout = "";
			let stderr = "";
			const result = await operations.exec(command, workspace, {
				onData: (data) => {
					stdout += data.toString();
				},
				onStderr: (data) => {
					stderr += data.toString();
				},
				env: options.env ?? { PATH: "/usr/bin:/bin" },
				...options,
			});
			return { exitCode: result.exitCode, stdout, stderr };
		}

		/** Shell snippet printing each variable's value, or `unset`, followed by `|`. */
		function printVariables(names: string[]): string {
			return `for v in ${names.join(" ")}; do if [ -v "$v" ]; then printf "%s|" "$(printenv "$v")"; else printf "unset|"; fi; done`;
		}

		/** Containers owned by this process. A failed listing is a test failure, never an empty list. */
		function ownContainers(): string {
			const list = spawnSync(
				"docker",
				["ps", "-a", "-q", "--filter", `label=dev.october.shell-runner.pid=${process.pid}`],
				{ encoding: "utf8", timeout: 15_000 },
			);
			if (list.error || list.status !== 0) {
				throw new Error(
					`docker ps failed after preflight (status ${list.status}): ${list.error?.message ?? list.stderr.trim()}`,
				);
			}
			return list.stdout.trim();
		}

		it("reads and writes the mounted cwd as the configured user", { timeout: 60_000 }, async () => {
			writeFileSync(join(workspace, "input"), "from host");
			const result = await exec(await runner(), "cat input; printf written > output; id -u");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(`from host${process.getuid?.()}\n`);
			expect(readFileSync(join(workspace, "output"), "utf8")).toBe("written");
			expect(statSync(join(workspace, "output")).uid).toBe(process.getuid?.());
		});

		it("rejects writes to read-only and nested read-only mounts", { timeout: 60_000 }, async () => {
			const operations = await runner({
				mounts: [{ path: "." }, { path: "ro", readOnly: true }, { path: "ro/nested", readOnly: true }],
			});
			expect((await exec(operations, "touch ro/file")).exitCode).not.toBe(0);
			expect((await exec(operations, "touch ro/nested/file")).exitCode).not.toBe(0);
			expect((await exec(operations, "touch file")).exitCode).toBe(0);
			expect(existsSync(join(workspace, "ro", "file"))).toBe(false);
		});

		it("does not expose unmounted host files", { timeout: 60_000 }, async () => {
			const outside = join(root, "outside-secret");
			writeFileSync(outside, "secret");
			expect((await exec(await runner(), `test -e ${outside}`)).exitCode).toBe(1);
		});

		it("passes only allowlisted variables, including multi-byte values", { timeout: 60_000 }, async () => {
			const result = await exec(
				await runner({ envAllowlist: ["KEEP"] }),
				`${printVariables(["KEEP", "DROP"])}; printf "%s" "$HOME"`,
				{ env: { KEEP: "ünï ☃ 世界", DROP: "dropped" } },
			);
			expect(result.stdout).toBe("ünï ☃ 世界|unset|/tmp");
		});

		it(
			"ignores Docker client proxy settings unless a proxy variable is allowlisted",
			{ timeout: 60_000 },
			async () => {
				const configDir = join(root, "docker-config");
				mkdirSync(configDir);
				writeFileSync(
					join(configDir, "config.json"),
					JSON.stringify({
						proxies: { default: { httpProxy: "http://sentinel-proxy:1", httpsProxy: "http://sentinel-proxy:1" } },
					}),
				);
				vi.stubEnv("DOCKER_CONFIG", configDir);
				const command = printVariables(["HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]);
				expect((await exec(await runner(), command)).stdout).toBe("unset|unset|unset|");
				const allowlisted = await exec(await runner({ envAllowlist: ["HTTPS_PROXY"] }), command, {
					env: { HTTPS_PROXY: "http://allowlisted:2" },
				});
				expect(allowlisted.stdout).toBe("unset|unset|http://allowlisted:2|");
			},
		);

		it("streams stdin, keeps stderr separate and reports non-zero exits", { timeout: 60_000 }, async () => {
			const stdin = new PassThrough();
			const operations = await runner();
			const run = exec(operations, "cat; echo err >&2; exit 7", { stdin });
			stdin.end("hello\n");
			const result = await run;
			expect(result).toEqual({ exitCode: 7, stdout: "hello\n", stderr: "err\n" });
		});

		it("leaves no container after abort or timeout", { timeout: 90_000 }, async () => {
			const operations = await runner();
			const controller = new AbortController();
			const aborted = exec(operations, "sleep 60", { signal: controller.signal });
			setTimeout(() => controller.abort(), 3_000);
			await expect(aborted).rejects.toThrow(/^aborted$/);
			// Per-command cleanup must remove the container; the exit fallback is not invoked here.
			expect(ownContainers()).toBe("");
			await expect(exec(operations, "sleep 60", { timeout: 3 })).rejects.toThrow(/^timeout:3$/);
			expect(ownContainers()).toBe("");
		});
	},
);
