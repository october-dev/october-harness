/**
 * Docker reference adapter for the shell runner boundary.
 *
 * Each command runs in a fresh `docker run --rm` container. The docker executable and the daemon
 * endpoint are frozen when the runner is created, so a later context or environment change cannot
 * redirect commands. Workspace directories are bind-mounted at the same path, and only allowlisted
 * environment variables reach the container, through a private env file.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { findExecutableOnPath, getShellEnv } from "../utils/shell.ts";
import type { ShellRunnerSettings } from "./settings-manager.ts";
import {
	type BashExecOptions,
	type BashOperations,
	createLocalShellOperations,
	resolveTimeoutMs,
	type StdinErrorWatch,
	watchStdinErrors,
} from "./tools/bash.ts";

export type DockerShellRunnerSettings = Extract<ShellRunnerSettings, { type: "docker" }>;

const SHELL_RUNNER_SCOPE_NOTICE =
	"Only the built-in bash tool and ! commands run in the container; other built-in tools and the Harness run on the host, and extension-provided shell routes are extension-owned and outside this policy.";

const LABEL = "dev.october.shell-runner";
const CLI_TIMEOUT_MS = 5_000;
const REMOVE_TIMEOUT_MS = 10_000;
const EXIT_CLEANUP_BUDGET_MS = 5_000;

export interface DockerMount {
	configuredAbsolute: string;
	real: string;
	readOnly: boolean;
}

export interface OwnerIdentity {
	pid: number;
	host: string;
	uid: number;
	/** PID namespace of this process; undefined when it could not be determined. */
	pidns: string | undefined;
}

interface DockerClient {
	executable: string;
	endpoint: string;
	env: NodeJS.ProcessEnv;
}

interface ContainerRecord extends DockerClient {
	name: string;
}

export interface DockerRunArgsInput {
	endpoint: string;
	configDir: string;
	name: string;
	owner: OwnerIdentity;
	user: string;
	mounts: readonly DockerMount[];
	cwd: string;
	envFile: string;
	interactive: boolean;
	image: string;
}

/** Containers that may still exist. The exit hook removes whatever is left when the process exits. */
const outstandingContainers = new Set<ContainerRecord>();
let exitHookRegistered = false;

/** Docker CLI argv (after the executable) up to and including `-c`; the command is appended by the caller. */
export function buildDockerRunArgs(input: DockerRunArgsInput): string[] {
	const args = [
		"--host",
		input.endpoint,
		"--config",
		input.configDir,
		"run",
		"--rm",
		"--pull=never",
		"--name",
		input.name,
		"--label",
		`${LABEL}=1`,
		"--label",
		`${LABEL}.pid=${input.owner.pid}`,
		"--label",
		`${LABEL}.host=${input.owner.host}`,
		"--label",
		`${LABEL}.uid=${input.owner.uid}`,
		"--label",
		`${LABEL}.pidns=${input.owner.pidns ?? "unknown"}`,
		"--user",
		input.user,
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
	];
	for (const mount of input.mounts) {
		args.push("--mount", `type=bind,source=${mount.real},target=${mount.real}${mount.readOnly ? ",readonly" : ""}`);
	}
	args.push("-w", input.cwd, "--env-file", input.envFile);
	if (input.interactive) args.push("-i");
	args.push("--entrypoint", "bash", input.image, "-c");
	return args;
}

/** Env file content: allowlisted values that are defined, plus `HOME=/tmp` unless HOME was written. */
export function buildDockerEnvFile(source: NodeJS.ProcessEnv, allowlist: readonly string[]): string {
	const lines: string[] = [];
	let wroteHome = false;
	for (const name of allowlist) {
		const value = source[name];
		if (value === undefined) continue;
		if (/[\r\n\0]/.test(value)) {
			throw new Error(
				`Docker shell runner: environment variable ${name} contains a line break or NUL character, which an env file cannot carry. The command was not run.`,
			);
		}
		lines.push(`${name}=${value}`);
		if (name === "HOME") wroteHome = true;
	}
	if (!wroteHome) lines.push("HOME=/tmp");
	return `${lines.join("\n")}\n`;
}

function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

interface CliResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** First stderr line, or the process error when stderr is empty. */
	failure: string;
}

function runDockerCli(
	client: Pick<DockerClient, "executable" | "env">,
	args: string[],
	timeoutMs: number,
): Promise<CliResult> {
	return new Promise((resolveResult) => {
		execFile(
			client.executable,
			args,
			{ env: client.env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const timedOut = error?.killed === true;
				const failure = timedOut
					? `timed out after ${timeoutMs / 1000} s`
					: firstLine(stderr) || (error ? error.message : "");
				resolveResult({ ok: error === null, stdout, stderr, failure });
			},
		);
	});
}

/**
 * Synchronously remove every container that may still exist, grouped per executable and endpoint,
 * within one overall time budget. Runs from the process exit hook.
 */
export function removeOutstandingDockerContainers(): void {
	const deadline = Date.now() + EXIT_CLEANUP_BUDGET_MS;
	const groups = new Map<string, ContainerRecord[]>();
	for (const record of outstandingContainers) {
		const key = `${record.executable}\0${record.endpoint}`;
		const group = groups.get(key);
		if (group) group.push(record);
		else groups.set(key, [record]);
	}
	outstandingContainers.clear();
	for (const records of groups.values()) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const { executable, endpoint, env } = records[0];
		try {
			spawnSync(executable, ["--host", endpoint, "rm", "-f", "-v", ...records.map((record) => record.name)], {
				env,
				timeout: remaining,
				killSignal: "SIGKILL",
				stdio: "ignore",
			});
		} catch {
			// The process is exiting; the next startup sweep handles what is left.
		}
	}
}

function readOwnerIdentity(): OwnerIdentity {
	let pidns: string | undefined = "none";
	if (process.platform === "linux") {
		try {
			pidns = readlinkSync("/proc/self/ns/pid");
		} catch {
			pidns = undefined;
		}
	}
	return { pid: process.pid, host: hostname(), uid: process.getuid?.() ?? -1, pidns };
}

function isOwnerDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// EPERM means the process exists under another user: keep its containers.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

interface SweepRecord {
	id: string;
	marker: string;
	host: string;
	uid: string;
	pidns: string;
	pid: string;
}

function parseSweepRecord(line: string): SweepRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Record<string, unknown>;
		const fields = ["id", "marker", "host", "uid", "pidns", "pid"] as const;
		if (!fields.every((field) => typeof record[field] === "string")) return undefined;
		return record as unknown as SweepRecord;
	} catch {
		return undefined;
	}
}

const SWEEP_FORMAT = `{"id":{{json .ID}},"marker":{{json (.Label "${LABEL}")}},"host":{{json (.Label "${LABEL}.host")}},"uid":{{json (.Label "${LABEL}.uid")}},"pidns":{{json (.Label "${LABEL}.pidns")}},"pid":{{json (.Label "${LABEL}.pid")}}}`;

/**
 * Remove containers left by earlier October processes of this user on this host and PID namespace
 * whose owner process is confirmed dead. Everything uncertain is kept. Returns a diagnostic or undefined.
 */
async function sweepOrphanedContainers(client: DockerClient, owner: OwnerIdentity): Promise<string | undefined> {
	if (owner.pidns === undefined) {
		return "Docker shell runner: skipped removing stale containers because this process's PID namespace could not be read.";
	}
	const list = await runDockerCli(
		client,
		[
			"--host",
			client.endpoint,
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			`label=${LABEL}=1`,
			"--filter",
			`label=${LABEL}.host=${owner.host}`,
			"--filter",
			`label=${LABEL}.uid=${owner.uid}`,
			"--format",
			SWEEP_FORMAT,
		],
		CLI_TIMEOUT_MS,
	);
	if (!list.ok) {
		return `Docker shell runner: could not list stale containers on ${client.endpoint}: ${list.failure}`;
	}
	const staleIds: string[] = [];
	for (const line of list.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const record = parseSweepRecord(line);
		if (!record || !/^[0-9a-f]{64}$/.test(record.id)) continue;
		if (record.marker !== "1" || record.host !== owner.host || record.uid !== String(owner.uid)) continue;
		if (record.pidns !== owner.pidns || !/^[1-9][0-9]*$/.test(record.pid)) continue;
		const pid = Number(record.pid);
		if (!Number.isSafeInteger(pid) || pid === owner.pid || !isOwnerDead(pid)) continue;
		staleIds.push(record.id);
	}
	if (staleIds.length === 0) return undefined;
	const removal = await runDockerCli(
		client,
		["--host", client.endpoint, "rm", "-f", "-v", ...staleIds],
		REMOVE_TIMEOUT_MS,
	);
	return removal.ok
		? undefined
		: `Docker shell runner: could not remove stale containers on ${client.endpoint}: ${removal.failure}`;
}

/** Component-aware containment: /proj2 is not inside /proj, and / contains everything. */
function isWithin(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function resolveMounts(settings: DockerShellRunnerSettings, cwd: string): DockerMount[] | string {
	const mounts: DockerMount[] = [];
	for (const mount of settings.mounts ?? [{ path: cwd }]) {
		const configuredAbsolute = resolvePath(mount.path, cwd);
		let real: string;
		try {
			real = realpathSync(configuredAbsolute);
		} catch {
			return `mount ${mount.path} does not exist (${configuredAbsolute})`;
		}
		if (!statSync(real).isDirectory()) {
			return `mount ${mount.path} is not a directory (${real})`;
		}
		// Docker parses --mount as comma-separated fields, so these characters cannot be expressed safely.
		if (/[,"\u0000-\u001f\u007f]/.test(real)) {
			return `mount ${real} contains a comma, quote or control character, which Docker mount options cannot carry`;
		}
		const duplicate = mounts.find((existing) => existing.real === real);
		if (duplicate) {
			return `mounts ${duplicate.configuredAbsolute} and ${configuredAbsolute} both resolve to ${real}; list each directory once`;
		}
		mounts.push({ configuredAbsolute, real, readOnly: mount.readOnly ?? false });
	}
	return mounts;
}

async function resolveEndpoint(client: Pick<DockerClient, "executable" | "env">): Promise<string> {
	// Uses the user's environment and config, so Docker's own precedence
	// (DOCKER_HOST, DOCKER_CONTEXT, currentContext) picks the endpoint once.
	const result = await runDockerCli(
		client,
		["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
		CLI_TIMEOUT_MS,
	);
	if (!result.ok) {
		throw new Error(`could not determine the Docker endpoint: ${result.failure}`);
	}
	return result.stdout.trim();
}

/** Warn when a mount exposes the agent directory, which holds credentials such as auth.json. */
function formatAgentDirWarning(mounts: readonly DockerMount[]): string {
	let agentDir = resolve(getAgentDir());
	try {
		agentDir = realpathSync(agentDir);
	} catch {
		// A missing agent directory is still checked by its configured path.
	}
	const exposing = mounts.find((mount) => isWithin(agentDir, mount.real));
	return exposing
		? ` Warning: mount ${exposing.real} contains the agent directory ${agentDir}; commands can read its credentials (auth.json).`
		: "";
}

function formatNotice(settings: DockerShellRunnerSettings, mounts: readonly DockerMount[]): string {
	const mountText =
		mounts.length === 0
			? "none"
			: mounts.map((mount) => `${mount.real} (${mount.readOnly ? "read-only" : "read-write"})`).join(", ");
	const allowlist =
		settings.envAllowlist && settings.envAllowlist.length > 0 ? settings.envAllowlist.join(", ") : "none";
	return `Shell runner: docker (image ${settings.image}). Mounts: ${mountText}. Environment allowlist: ${allowlist}. ${SHELL_RUNNER_SCOPE_NOTICE}${formatAgentDirWarning(mounts)}`;
}

/**
 * Create the Docker runner once per process. Returns an error string (the cause) when the runner
 * cannot be used; the caller turns it into a selection that rejects every command.
 */
export async function createDockerShellRunner(
	settings: DockerShellRunnerSettings,
	cwd: string,
): Promise<{ notice: string; operations: BashOperations } | { error: string }> {
	const discovered = findExecutableOnPath("docker");
	if (!discovered) {
		return { error: "Docker shell runner: docker CLI not found on PATH" };
	}
	// Freeze an absolute path so a relative PATH entry is not re-resolved against a later command cwd.
	const executable = resolve(process.cwd(), discovered);
	const env = { ...process.env };
	delete env.DOCKER_HOST;
	delete env.DOCKER_CONTEXT;

	let endpoint: string;
	try {
		endpoint = await resolveEndpoint({ executable, env: process.env });
	} catch (error) {
		return { error: `Docker shell runner: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!endpoint.startsWith("unix://")) {
		return {
			error: `Docker shell runner: endpoint ${endpoint || "(empty)"} is not a local unix:// socket; only local sockets are supported`,
		};
	}

	const mounts = resolveMounts(settings, cwd);
	if (typeof mounts === "string") {
		return { error: `Docker shell runner: ${mounts}` };
	}

	const client: DockerClient = { executable, endpoint, env };
	const owner = readOwnerIdentity();
	const user = settings.user ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
	const allowlist = [...new Set(settings.envAllowlist ?? [])];
	// Settle the startup sweep into a diagnostic right away so a failure is never an unhandled rejection.
	const sweep = sweepOrphanedContainers(client, owner).catch(
		(error: unknown) =>
			`Docker shell runner: stale container cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	let sweepReported = false;
	if (!exitHookRegistered) {
		exitHookRegistered = true;
		process.once("exit", removeOutstandingDockerContainers);
	}

	const runInContainer = async (
		command: string,
		commandCwd: string,
		options: BashExecOptions,
		input: StdinErrorWatch,
	): Promise<{ exitCode: number | null }> => {
		const { onData, onStderr, signal, timeout, env: commandEnv, stdin } = options;
		const report = (text: string) => (onStderr ?? onData)(Buffer.from(text));

		for (const mount of mounts) {
			let current: string[];
			try {
				current = await Promise.all([realpath(mount.configuredAbsolute), realpath(mount.real)]);
			} catch {
				throw new Error(`Docker shell runner: mount ${mount.real} no longer exists. The command was not run.`);
			}
			const changed = current.find((path) => path !== mount.real);
			if (changed) {
				throw new Error(
					`Docker shell runner: mount ${mount.configuredAbsolute} now resolves to ${changed} instead of ${mount.real}. The command was not run; restart to use the new location.`,
				);
			}
		}
		let realCwd: string;
		try {
			realCwd = await realpath(commandCwd);
		} catch {
			throw new Error(`Working directory does not exist: ${commandCwd}\nCannot execute docker commands.`);
		}
		if (!mounts.some(({ real }) => isWithin(realCwd, real))) {
			throw new Error(
				`Docker shell runner: working directory ${realCwd} is outside every configured mount. The command was not run.`,
			);
		}
		const envFileContent = buildDockerEnvFile(commandEnv ?? getShellEnv(), allowlist);

		const sweepDiagnostic = await sweep;
		if (sweepDiagnostic && !sweepReported) {
			sweepReported = true;
			report(`${sweepDiagnostic}\n`);
		}

		const record: ContainerRecord = {
			...client,
			name: `october-shell-${process.pid}-${randomBytes(4).toString("hex")}`,
		};
		let privateDir: string | undefined;
		let spawned = false;
		let outcome: { ok: true; value: { exitCode: number | null } } | { ok: false; error: unknown };
		try {
			privateDir = await mkdtemp(join(tmpdir(), "october-shell-"));
			const envFile = join(privateDir, "env");
			const configDir = join(privateDir, "config");
			await writeFile(envFile, envFileContent, { mode: 0o600 });
			await mkdir(configDir, { mode: 0o700 });
			// An empty client config: no proxy injection, credential helpers or other client-side defaults.
			await writeFile(join(configDir, "config.json"), "{}", { mode: 0o600 });
			// The abort or an input failure may arrive during preparation; no container starts after either.
			if (signal?.aborted) throw new Error("aborted");
			input.check();

			const args = buildDockerRunArgs({
				endpoint,
				configDir,
				name: record.name,
				owner,
				user,
				mounts,
				cwd: realCwd,
				envFile,
				interactive: stdin !== undefined,
				image: settings.image,
			});
			outstandingContainers.add(record);
			spawned = true;
			const operations = createLocalShellOperations("docker", () => ({ shell: executable, args }));
			outcome = {
				ok: true,
				value: await operations.exec(command, commandCwd, { onData, onStderr, signal, timeout, env, stdin }),
			};
		} catch (error) {
			outcome = { ok: false, error };
		}

		// Cleanup never replaces the command's own result; failures are reported before settling.
		if (privateDir) {
			try {
				await rm(privateDir, { recursive: true, force: true });
			} catch (error) {
				report(
					`\nDocker shell runner: could not remove the private env/config directory ${privateDir}: ${error instanceof Error ? error.message : String(error)}. Remove it manually.\n`,
				);
			}
		}
		if (spawned) {
			const interrupted =
				signal?.aborted === true ||
				(!outcome.ok && outcome.error instanceof Error && outcome.error.message.startsWith("timeout:"));
			const removal = await runDockerCli(
				record,
				["--host", endpoint, "rm", "-f", "-v", record.name],
				REMOVE_TIMEOUT_MS,
			);
			if (removal.ok || /no such container/i.test(removal.stderr)) {
				// A killed client may still have a create in flight; keep the record for the exit hook.
				if (!interrupted) outstandingContainers.delete(record);
			} else if (!/removal of container .* is already in progress/i.test(removal.stderr)) {
				report(
					`\nDocker shell runner: could not confirm removal of container ${record.name} on ${endpoint}: ${removal.failure}\n`,
				);
			}
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	};

	const exec: BashOperations["exec"] = async (command, commandCwd, options) => {
		resolveTimeoutMs(options.timeout);
		if (options.signal?.aborted) throw new Error("aborted");
		// Listen from the start: the input stream can fail while mounts, the sweep and private files are prepared.
		const input = watchStdinErrors(options.stdin, "docker");
		try {
			return await runInContainer(command, commandCwd, options, input);
		} finally {
			input.release();
		}
	};

	return { notice: formatNotice(settings, mounts), operations: { exec } };
}
