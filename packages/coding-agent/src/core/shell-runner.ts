/**
 * Shell runner selection.
 *
 * The selection is resolved once per process from global settings and reused by every session
 * runtime, so a settings file edited mid-process cannot change where commands run. Every failure
 * resolves to a selection whose operations reject; nothing falls back to host execution.
 */

import { createDockerShellRunner } from "./docker-shell-runner.ts";
import type { ShellRunnerMountSettings, ShellRunnerSettings } from "./settings-manager.ts";
import type { BashOperations } from "./tools/bash.ts";

/**
 * - `host`: today's local shell. `notice` is set only when host was selected explicitly.
 * - `docker`: the Docker reference adapter.
 * - `custom`: an SDK-supplied adapter.
 * - `invalid`: the policy could not be applied; `operations` reject every command.
 *
 * Every non-host kind also disables the `powershell` tool and PI_* session variables.
 */
export type ShellRunnerSelection =
	| { kind: "host"; notice?: string }
	| { kind: "docker" | "custom" | "invalid"; notice: string; operations: BashOperations };

/** Policy input, as returned by `SettingsManager.getShellRunnerSettings()`. */
export interface ShellRunnerSettingsInput {
	settings?: ShellRunnerSettings | null;
	/** The settings source could not be used; the selection becomes invalid. */
	error?: string;
}

const HOST_SHELL_RUNNER_NOTICE = "Shell runner: host. Commands run directly on this machine.";
export const POWERSHELL_UNAVAILABLE_MESSAGE = "The powershell tool is not available when a shell runner is configured.";

export function createRejectingShellOperations(message: string): BashOperations {
	return {
		exec: async () => {
			throw new Error(message);
		},
	};
}

function createInvalidShellRunner(cause: string): ShellRunnerSelection {
	const notice = `Shell runner: blocked. ${cause}. Shell commands will not run, on the host or elsewhere; fix this and restart.`;
	return { kind: "invalid", notice, operations: createRejectingShellOperations(notice) };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER = /^\d+:\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
	return Object.keys(value).find((key) => !allowed.includes(key));
}

/** Validate the shape of a `shellRunner` value. Returns the cause of the first problem found. */
function validateShellRunnerSettings(value: unknown): { settings: ShellRunnerSettings } | { error: string } {
	if (!isRecord(value)) {
		return { error: 'shellRunner must be an object with a "type" field' };
	}
	if (value.type === "host") {
		const extra = unknownKey(value, ["type"]);
		return extra
			? { error: `shellRunner.${extra} is not supported for type "host"` }
			: { settings: { type: "host" } };
	}
	if (value.type !== "docker") {
		return { error: `shellRunner.type must be "host" or "docker", got ${JSON.stringify(value.type) ?? "nothing"}` };
	}
	const extra = unknownKey(value, ["type", "image", "mounts", "envAllowlist", "user"]);
	if (extra) {
		return { error: `shellRunner.${extra} is not a supported field` };
	}
	const { image, mounts, envAllowlist, user } = value;
	if (typeof image !== "string" || image.trim() === "" || image.startsWith("-") || /[\s\u0000-\u001f]/.test(image)) {
		return { error: "shellRunner.image must be a non-empty image reference without spaces and not starting with -" };
	}
	let validatedMounts: ShellRunnerMountSettings[] | undefined;
	if (mounts !== undefined) {
		if (!Array.isArray(mounts)) {
			return { error: "shellRunner.mounts must be an array" };
		}
		validatedMounts = [];
		for (const [index, mount] of mounts.entries()) {
			if (!isRecord(mount) || typeof mount.path !== "string" || mount.path === "") {
				return { error: `shellRunner.mounts[${index}] must be an object with a non-empty "path"` };
			}
			const mountExtra = unknownKey(mount, ["path", "readOnly"]);
			if (mountExtra) {
				return { error: `shellRunner.mounts[${index}].${mountExtra} is not a supported field` };
			}
			if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
				return { error: `shellRunner.mounts[${index}].readOnly must be true or false` };
			}
			validatedMounts.push({
				path: mount.path,
				...(mount.readOnly !== undefined ? { readOnly: mount.readOnly } : {}),
			});
		}
	}
	if (envAllowlist !== undefined) {
		if (!Array.isArray(envAllowlist)) {
			return { error: "shellRunner.envAllowlist must be an array of variable names" };
		}
		const invalid = envAllowlist.find((name) => typeof name !== "string" || !ENV_NAME.test(name));
		if (invalid !== undefined) {
			return { error: `shellRunner.envAllowlist entry ${JSON.stringify(invalid)} is not a valid variable name` };
		}
	}
	if (user !== undefined && (typeof user !== "string" || !USER.test(user))) {
		return { error: 'shellRunner.user must be "uid:gid" with numeric ids' };
	}
	return {
		settings: {
			type: "docker",
			image,
			...(validatedMounts ? { mounts: validatedMounts } : {}),
			...(envAllowlist ? { envAllowlist: envAllowlist as string[] } : {}),
			...(user !== undefined ? { user: user as string } : {}),
		},
	};
}

/**
 * Resolve the shell runner once. `cwd` is the initial session cwd; default and relative mounts
 * resolve against it.
 */
export async function resolveShellRunner(input: ShellRunnerSettingsInput, cwd: string): Promise<ShellRunnerSelection> {
	if (input.error) {
		return createInvalidShellRunner(input.error);
	}
	if (input.settings === undefined) {
		return { kind: "host" };
	}
	const validated = validateShellRunnerSettings(input.settings);
	if ("error" in validated) {
		return createInvalidShellRunner(`Invalid shellRunner setting: ${validated.error}`);
	}
	if (validated.settings.type === "host") {
		return { kind: "host", notice: HOST_SHELL_RUNNER_NOTICE };
	}
	if (process.platform === "win32") {
		return createInvalidShellRunner("The Docker shell runner is not supported on Windows hosts");
	}
	const docker = await createDockerShellRunner(validated.settings, cwd);
	if ("error" in docker) {
		return createInvalidShellRunner(docker.error);
	}
	return { kind: "docker", notice: docker.notice, operations: docker.operations };
}
