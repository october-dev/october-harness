/**
 * `october doctor`: local setup diagnostics.
 *
 * Default checks read files and the environment only. `--probe` adds bounded network and October Bus
 * daemon checks. The command never starts services, installs packages, loads extensions, or writes
 * configuration.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import type { Api, AuthCheck, Model, ModelsStoreEntry } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { isSupportedNodeVersion, MIN_NODE_VERSION } from "../cli-node-version.ts";
import {
	APP_NAME,
	detectInstallMethod,
	getExportTemplateDir,
	getInteractiveAssetsDir,
	getPackageDir,
	getPackageJsonPath,
	getThemesDir,
	isBunBinary,
	VERSION,
} from "../config.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { ModelConfig } from "../core/model-config.ts";
import { resolveModelScopeWithDiagnostics } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { createLlamaProvider } from "../extensions/llama/provider.ts";
import { OCTOBER_PROVIDER_ID } from "../extensions/october/auth.ts";
import { parseOctoberBusEnv } from "../extensions/october/bus/env.ts";
import { createOctoberProviderConfig } from "../extensions/october/provider.ts";
import { BUS_PROTOCOL, BUS_RELEASE, readScopeStore, resolveBusReleaseAsset } from "../october-team-launcher.ts";
import { spawnProcessSync } from "../utils/child-process.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

/** Version of the `--json` report. Increase it when a field or check ID changes meaning. */
export const DOCTOR_SCHEMA_VERSION = 1;
export const DEFAULT_DOCTOR_TIMEOUT_MS = 3_000;
const MAX_DOCTOR_TIMEOUT_MS = 60_000;

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
	/** Stable identifier, e.g. `config.models`. */
	id: string;
	status: DoctorStatus;
	summary: string;
	/** What to do next. Present for `warn` and `fail`. */
	remediation?: string;
	details?: Record<string, string | number | boolean>;
}

export interface DoctorReport {
	schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
	version: string;
	/** False when any check failed. */
	ok: boolean;
	probe: boolean;
	checks: DoctorCheck[];
}

export interface DoctorOptions {
	agentDir: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Run provider and October Bus connectivity checks. */
	probe?: boolean;
	timeoutMs?: number;
}

const BUS_SESSION_KEYS = [
	"OCTOBER_BUS_MCP_URL",
	"OCTOBER_BUS_AGENT_ID",
	"OCTOBER_BUS_EXECUTION_ID",
	"OCTOBER_BUS_AGENT_TOKEN",
];
const BUS_PUBLIC_KEYS = ["OCTOBER_BUS_ADDRESS", ...BUS_SESSION_KEYS];
const BUS_DESKTOP_KEYS = ["OCTOBER_BUS_PORT", "OCTOBER_BUS_CANVAS", "OCTOBER_BUS_NODE"];
const SECRET_NAME = /key|token|secret|passw|credential|auth|access|refresh|cookie/i;

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} doctor [--json] [--probe] [--timeout <ms>]

Check the October installation, configuration, model credentials, and October Bus setup.
By default only local files and environment variables are read. Nothing is started, installed, or written.

Options:
  --json             Print the versioned JSON report
  --probe            Also contact the default model's provider and ask October Bus for its own doctor report
  --timeout <ms>     Time limit for each probe, from 1 to ${MAX_DOCTOR_TIMEOUT_MS} (default ${DEFAULT_DOCTOR_TIMEOUT_MS})

Exits with 1 when a check fails.`;

class DoctorContext {
	readonly agentDir: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	private readonly home: string | undefined;

	constructor(options: DoctorOptions) {
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		this.env = options.env ?? process.env;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
		this.home = this.env.HOME || this.env.USERPROFILE || homedir();
	}

	/** Shorten paths under the home directory so reports can be shared. */
	path(path: string): string {
		if (!this.home) return path;
		if (path === this.home) return "~";
		return path.startsWith(`${this.home}${sep}`) ? `~${path.slice(this.home.length)}` : path;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** First executable named `name` on PATH, without running it. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension}`);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function checkExecutable(context: DoctorContext): DoctorCheck {
	const running = isBunBinary ? process.execPath : process.argv[1];
	const installMethod = detectInstallMethod();
	const details: Record<string, string> = {
		version: VERSION,
		executable: running ? context.path(running) : "unknown",
		installMethod,
		packageDir: context.path(getPackageDir()),
	};
	const onPath = findOnPath(APP_NAME, context.env);
	if (onPath) details.pathExecutable = context.path(onPath);
	// Windows PATH entries are package-manager shims, so only compare real paths elsewhere.
	if (process.platform !== "win32" && onPath && running && realPath(onPath) !== realPath(running)) {
		return {
			id: "executable",
			status: "warn",
			summary: `${APP_NAME} ${VERSION} is running from ${context.path(running)}, but PATH resolves "${APP_NAME}" to ${context.path(onPath)}`,
			remediation: `Remove the other installation or reorder PATH so "${APP_NAME}" is the installation you expect.`,
			details,
		};
	}
	return {
		id: "executable",
		status: "pass",
		summary: `${APP_NAME} ${VERSION} at ${details.executable} (${installMethod})`,
		details,
	};
}

function checkRuntime(): DoctorCheck {
	const platform = `${process.platform}/${process.arch}`;
	if (process.versions.bun) {
		return { id: "runtime", status: "pass", summary: `Bun ${process.versions.bun} on ${platform}` };
	}
	const node = process.versions.node;
	if (isSupportedNodeVersion(node)) {
		return { id: "runtime", status: "pass", summary: `Node.js ${node} on ${platform}` };
	}
	return {
		id: "runtime",
		status: "fail",
		summary: `Node.js ${node} is older than the required ${MIN_NODE_VERSION}`,
		remediation: `Install Node.js ${MIN_NODE_VERSION} or newer from https://nodejs.org, or use the October installer.`,
	};
}

function checkAssets(context: DoctorContext): DoctorCheck {
	const assets: Array<[string, string]> = [
		["package.json", getPackageJsonPath()],
		["dark theme", join(getThemesDir(), "dark.json")],
		["light theme", join(getThemesDir(), "light.json")],
		["HTML export template", join(getExportTemplateDir(), "template.html")],
		["HTML export styles", join(getExportTemplateDir(), "template.css")],
		["HTML export script", join(getExportTemplateDir(), "template.js")],
		["interactive assets", getInteractiveAssetsDir()],
	];
	const missing = assets.filter(([, path]) => !existsSync(path));
	if (missing.length === 0) {
		return {
			id: "assets",
			status: "pass",
			summary: `${assets.length} packaged assets found in ${context.path(getPackageDir())}`,
		};
	}
	return {
		id: "assets",
		status: "fail",
		summary: `Missing packaged assets: ${missing.map(([name]) => name).join(", ")}`,
		remediation: process.env.PI_PACKAGE_DIR
			? "PI_PACKAGE_DIR is set. Point it at the October package root or unset it."
			: `Reinstall ${APP_NAME}; the installation is incomplete.`,
		details: Object.fromEntries(missing.map(([name, path]) => [name, context.path(path)])),
	};
}

function checkSettings(context: DoctorContext): DoctorCheck {
	// Parse project settings even in untrusted projects: they are data, and parsing runs no project code.
	const errors = SettingsManager.create(context.cwd, context.agentDir, { projectTrusted: true }).drainErrors();
	if (errors.length === 0) return { id: "config.settings", status: "pass", summary: "settings.json files parse" };
	return {
		id: "config.settings",
		status: "fail",
		summary: errors
			.map(({ scope, path, error }) => `${path ? context.path(path) : `${scope} settings`}: ${error.message}`)
			.join("; "),
		remediation: `Fix the JSON in the listed file, or move it aside to use defaults, then restart ${APP_NAME}.`,
	};
}

async function checkModelsJson(context: DoctorContext): Promise<DoctorCheck> {
	const path = join(context.agentDir, "models.json");
	const error = (await ModelConfig.load(path)).getError();
	if (!error) {
		return {
			id: "config.models",
			status: existsSync(path) ? "pass" : "skip",
			summary: existsSync(path) ? `${context.path(path)} is valid` : "No models.json",
		};
	}
	return {
		id: "config.models",
		status: "fail",
		summary: error.replace(/\n+File: .*$/s, "").replace(/\n\s*/g, " "),
		remediation: `Fix ${context.path(path)}. Until then, its custom providers and model overrides are ignored.`,
	};
}

async function checkAuthFile(context: DoctorContext): Promise<{ check: DoctorCheck; valid: boolean }> {
	const path = join(context.agentDir, "auth.json");
	if (!existsSync(path)) {
		return { check: { id: "config.auth", status: "skip", summary: "No stored credentials" }, valid: true };
	}
	try {
		const credentials = await new ReadOnlyAuthStorage(path).list();
		return {
			check: {
				id: "config.auth",
				status: "pass",
				summary: `${credentials.length} stored credential${credentials.length === 1 ? "" : "s"} (${credentials.map((entry) => entry.providerId).join(", ") || "none"})`,
			},
			valid: true,
		};
	} catch (error) {
		return {
			check: {
				id: "config.auth",
				status: "fail",
				summary: errorMessage(error),
				remediation: `Fix or move ${context.path(path)}, then sign in again with "${APP_NAME} login".`,
			},
			valid: false,
		};
	}
}

/** Cached dynamic catalogs, copied into memory so availability checks never write the cache. */
async function readCachedCatalogs(agentDir: string): Promise<InMemoryCodingAgentModelsStore> {
	const store = new InMemoryCodingAgentModelsStore();
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(join(agentDir, "models-store.json"), "utf-8")));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [providerId, entry] of Object.entries(parsed)) {
				await store.write(providerId, entry as ModelsStoreEntry);
			}
		}
	} catch {
		// A missing or unreadable cache only means dynamic catalogs fall back to built-in models.
	}
	return store;
}

async function createDoctorModelRuntime(context: DoctorContext, authValid: boolean): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: authValid ? new ReadOnlyAuthStorage(join(context.agentDir, "auth.json")) : AuthStorage.inMemory(),
		modelsPath: join(context.agentDir, "models.json"),
		modelsStore: await readCachedCatalogs(context.agentDir),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	// Providers that built-in extensions register at startup. Registering them directly avoids
	// loading any extension, so the same model IDs resolve here as in a session.
	runtime.registerProvider(OCTOBER_PROVIDER_ID, createOctoberProviderConfig());
	runtime.registerNativeProvider(createLlamaProvider().provider);
	await runtime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(Math.max(context.timeoutMs, 5_000)) });
	return runtime;
}

async function checkDefaultModel(
	runtime: ModelRuntime,
	settings: SettingsManager,
): Promise<{ check: DoctorCheck; model?: Model<Api> }> {
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	if (!provider || !modelId) {
		const available = runtime.getAvailableSnapshot().length;
		return available > 0
			? {
					check: {
						id: "models.default",
						status: "pass",
						summary: `No default model set; ${available} models have credentials and the first one is used`,
					},
				}
			: {
					check: {
						id: "models.default",
						status: "warn",
						summary: "No model has credentials",
						remediation: `Run "${APP_NAME} login", or set a provider API key environment variable (see "${APP_NAME} --help").`,
					},
				};
	}
	const model = runtime.getModel(provider, modelId);
	if (!model) {
		return {
			check: {
				id: "models.default",
				status: "fail",
				summary: `Default model ${provider}/${modelId} is not in the model catalog`,
				remediation: `Run "${APP_NAME} --list-models" and update defaultProvider and defaultModel in settings.json, or pick a model with /model.`,
			},
		};
	}
	let auth: AuthCheck | undefined;
	try {
		auth = await runtime.checkAuth(provider);
	} catch {
		auth = undefined;
	}
	if (!auth) {
		return {
			check: {
				id: "models.default",
				status: "fail",
				summary: `Default model ${provider}/${modelId} has no credentials`,
				remediation: `Run "${APP_NAME} login ${provider}", or set the provider's API key environment variable.`,
			},
			model,
		};
	}
	return {
		check: {
			id: "models.default",
			status: "pass",
			summary: `${provider}/${modelId} (${auth.type}${auth.source ? ` from ${auth.source}` : ""})`,
		},
		model,
	};
}

async function checkEnabledModels(
	context: DoctorContext,
	runtime: ModelRuntime,
	settings: SettingsManager,
): Promise<DoctorCheck> {
	const patterns = settings.getEnabledModels();
	if (!patterns || patterns.length === 0) {
		return { id: "models.enabled", status: "skip", summary: "No enabledModels setting" };
	}
	const scope = await resolveModelScopeWithDiagnostics(patterns, runtime, {
		signal: AbortSignal.timeout(Math.max(context.timeoutMs, 5_000)),
	});
	if (scope.diagnostics.length === 0) {
		return {
			id: "models.enabled",
			status: "pass",
			summary: `${scope.scopedModels.length} models with credentials match enabledModels`,
		};
	}
	return {
		id: "models.enabled",
		status: "warn",
		summary: scope.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
		remediation: "Update enabledModels in settings.json, or add credentials for the provider of each pattern.",
	};
}

function busOrigin(value: string | undefined): string {
	try {
		return value ? new URL(value).origin : "unset";
	} catch {
		return "an invalid URL";
	}
}

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
	return (env[key]?.trim() ?? "") !== "";
}

function checkBusEnvironment(context: DoctorContext): DoctorCheck {
	const env = context.env;
	const parsed = parseOctoberBusEnv(env);
	if (BUS_SESSION_KEYS.some((key) => env[key] !== undefined)) {
		if (parsed?.transport === "public") {
			return {
				id: "bus.env",
				status: "pass",
				summary: `October Bus session for agent ${parsed.agentId} at ${parsed.address}`,
			};
		}
		const missing = BUS_PUBLIC_KEYS.filter((key) => !isSet(env, key));
		return {
			id: "bus.env",
			status: "fail",
			summary:
				missing.length > 0
					? `Incomplete October Bus session variables; missing ${missing.join(", ")}`
					: "Invalid October Bus session variables: OCTOBER_BUS_ADDRESS must be an https origin (http only on loopback) without credentials, path, or query, and OCTOBER_BUS_MCP_URL must use the same origin",
			remediation: `Start ${APP_NAME} through "${APP_NAME} --team" or "october-bus agent run" so all of ${BUS_PUBLIC_KEYS.join(", ")} are set together, or unset them.`,
		};
	}
	if (env.OCTOBER_BUS_ADDRESS !== undefined) {
		if (isSet(env, "OCTOBER_BUS_SCOPE_TOKEN")) {
			return {
				id: "bus.env",
				status: "pass",
				summary: `"${APP_NAME} --team" joins the October Bus at ${busOrigin(env.OCTOBER_BUS_ADDRESS)}`,
			};
		}
		return {
			id: "bus.env",
			status: "fail",
			summary: "OCTOBER_BUS_ADDRESS selects an existing October Bus, but OCTOBER_BUS_SCOPE_TOKEN is not set",
			remediation:
				"Set OCTOBER_BUS_SCOPE_TOKEN to a scope token for that Bus, or unset OCTOBER_BUS_ADDRESS to use a local Bus.",
		};
	}
	if (BUS_DESKTOP_KEYS.some((key) => env[key] !== undefined)) {
		if (parsed?.transport === "desktop") {
			return { id: "bus.env", status: "pass", summary: `October Desktop Bus on port ${parsed.port}` };
		}
		const missing = BUS_DESKTOP_KEYS.filter((key) => !isSet(env, key));
		return {
			id: "bus.env",
			status: "fail",
			summary:
				missing.length > 0
					? `Incomplete October Desktop Bus variables; missing ${missing.join(", ")}`
					: "OCTOBER_BUS_PORT must be a port number from 1 to 65535",
			remediation: `Launch ${APP_NAME} from October Desktop, or unset ${BUS_DESKTOP_KEYS.join(", ")}.`,
		};
	}
	return {
		id: "bus.env",
		status: "skip",
		summary: `No October Bus variables; "${APP_NAME} --team" starts or joins a local Bus`,
	};
}

function resolveBusExecutable(context: DoctorContext): { path?: string; source: string; error?: string } {
	const configured = context.env.OCTOBER_BUS_BINARY?.trim();
	if (configured) {
		const path =
			configured.includes("/") || configured.includes("\\") ? configured : findOnPath(configured, context.env);
		return path && isExecutableFile(path)
			? { path, source: "OCTOBER_BUS_BINARY" }
			: { source: "OCTOBER_BUS_BINARY", error: `OCTOBER_BUS_BINARY (${configured}) is not an executable file` };
	}
	const onPath = findOnPath("october-bus", context.env);
	if (onPath) return { path: onPath, source: "PATH" };
	const managed = join(
		context.agentDir,
		"bin",
		`october-bus-${BUS_RELEASE}${process.platform === "win32" ? ".exe" : ""}`,
	);
	if (isExecutableFile(managed)) return { path: managed, source: `managed ${BUS_RELEASE}` };
	return { source: "none" };
}

function checkBusExecutable(context: DoctorContext, bus: ReturnType<typeof resolveBusExecutable>): DoctorCheck {
	if (bus.error) {
		return {
			id: "bus.binary",
			status: "fail",
			summary: bus.error,
			remediation: `Point OCTOBER_BUS_BINARY at an october-bus ${BUS_RELEASE} executable, or unset it.`,
		};
	}
	if (bus.path) {
		return {
			id: "bus.binary",
			status: "pass",
			summary: `${context.path(bus.path)} (${bus.source}; protocol not checked without --probe)`,
		};
	}
	try {
		resolveBusReleaseAsset();
	} catch (error) {
		return {
			id: "bus.binary",
			status: "warn",
			summary: errorMessage(error),
			remediation: "Build october-bus locally and set OCTOBER_BUS_BINARY to it.",
		};
	}
	return {
		id: "bus.binary",
		status: "skip",
		summary: `October Bus is not installed; "${APP_NAME} --team" downloads ${BUS_RELEASE} on first use`,
	};
}

function checkBusScopes(context: DoctorContext): DoctorCheck {
	const path = join(context.agentDir, "team-scopes.json");
	if (!existsSync(path)) return { id: "bus.scopes", status: "skip", summary: "No saved team scopes" };
	try {
		const count = Object.keys(readScopeStore(path).scopes).length;
		return { id: "bus.scopes", status: "pass", summary: `${count} saved team scope${count === 1 ? "" : "s"}` };
	} catch (error) {
		return {
			id: "bus.scopes",
			status: "fail",
			summary: errorMessage(error).replace(path, context.path(path)),
			remediation: `Run "chmod 600 ${context.path(path)}" if only its mode is wrong; otherwise move it aside and "${APP_NAME} --team" creates a new scope.`,
		};
	}
}

function failureReason(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `no response within ${timeoutMs} ms`;
	}
	const cause =
		error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
	if (typeof cause?.code === "string") return cause.code;
	if (typeof cause?.message === "string") return cause.message;
	return errorMessage(error);
}

async function probeProvider(context: DoctorContext, model: Model<Api> | undefined): Promise<DoctorCheck> {
	if (!model?.baseUrl) {
		return { id: "probe.provider", status: "skip", summary: "No default model with a base URL to contact" };
	}
	let url: URL;
	try {
		url = new URL(model.baseUrl);
	} catch {
		return {
			id: "probe.provider",
			status: "fail",
			summary: `${model.provider} has an invalid base URL`,
			remediation: "Fix baseUrl for this provider in models.json.",
		};
	}
	// Credentials are never sent; any HTTP response proves the endpoint is reachable.
	const target = `${url.origin}${url.pathname}`;
	const started = Date.now();
	try {
		const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(context.timeoutMs) });
		await response.body?.cancel();
		return {
			id: "probe.provider",
			status: "pass",
			summary: `${url.origin} answered HTTP ${response.status} in ${Date.now() - started} ms`,
		};
	} catch (error) {
		return {
			id: "probe.provider",
			status: "fail",
			summary: `Could not reach ${url.origin} for ${model.provider}: ${failureReason(error, context.timeoutMs)}`,
			remediation: "Check network access, the httpProxy setting or HTTPS_PROXY, and the provider's baseUrl.",
		};
	}
}

/** Summarize `october-bus doctor --json`; the Bus owns the daemon diagnostics themselves. */
function probeBus(context: DoctorContext, bus: ReturnType<typeof resolveBusExecutable>): DoctorCheck {
	if (!bus.path) {
		return { id: "bus.doctor", status: "skip", summary: "No October Bus executable to ask" };
	}
	const result = spawnProcessSync(bus.path, ["doctor", "--json"], {
		encoding: "utf8",
		env: context.env,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: context.timeoutMs,
		windowsHide: true,
	});
	const remediation = `Run "${context.path(bus.path)} doctor" for details. "${APP_NAME} --team" starts the local daemon.`;
	if (result.error) {
		const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		return {
			id: "bus.doctor",
			status: "fail",
			summary: timedOut
				? `october-bus doctor did not finish within ${context.timeoutMs} ms`
				: `Could not run october-bus doctor: ${result.error.message}`,
			remediation,
		};
	}
	let report: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
	} catch {
		report = undefined;
	}
	if (!report) {
		return {
			id: "bus.doctor",
			status: "fail",
			summary: `october-bus doctor printed no JSON report (exit ${result.status ?? "unknown"})`,
			remediation,
		};
	}
	const details: Record<string, string | boolean> = {};
	for (const key of ["healthy", "protocolVersion", "runtimeVersion", "address"]) {
		const value = report[key];
		if (typeof value === "string" || typeof value === "boolean") details[key] = value;
	}
	if (report.healthy !== true) {
		return { id: "bus.doctor", status: "fail", summary: "October Bus reports unhealthy", remediation, details };
	}
	if (report.protocolVersion !== BUS_PROTOCOL) {
		return {
			id: "bus.doctor",
			status: "fail",
			summary: `October Bus speaks protocol ${String(report.protocolVersion)}; ${APP_NAME} needs ${BUS_PROTOCOL}`,
			remediation: `Install october-bus ${BUS_RELEASE}, or unset OCTOBER_BUS_BINARY so "${APP_NAME} --team" uses its managed copy.`,
			details,
		};
	}
	return {
		id: "bus.doctor",
		status: "pass",
		summary: `Healthy, protocol ${BUS_PROTOCOL}${typeof report.runtimeVersion === "string" ? `, runtime ${report.runtimeVersion}` : ""}`,
		details,
	};
}

function collectSecretValues(value: unknown, secrets: Set<string>, sensitive = false): void {
	if (typeof value === "string") {
		if (sensitive && value.length >= 8 && !value.startsWith("$")) secrets.add(value);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		collectSecretValues(child, secrets, sensitive || SECRET_NAME.test(key) || key === "headers");
	}
}

/** Values that must never appear in a report: credential-like variables and secrets in config files. */
function collectSecrets(context: DoctorContext): string[] {
	const secrets = new Set<string>();
	for (const [name, value] of Object.entries(context.env)) {
		if (value && value.length >= 8 && SECRET_NAME.test(name)) secrets.add(value);
	}
	for (const file of ["auth.json", "models.json", "settings.json"]) {
		try {
			const content = stripJsonComments(stripBom(readFileSync(join(context.agentDir, file), "utf-8")));
			collectSecretValues(JSON.parse(content), secrets);
		} catch {
			// Unparseable files are reported by their own check; their parse snippets are redacted below.
		}
	}
	return [...secrets].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
	// JSON.parse errors quote the input ("Unexpected token 's', "{"key": sk-..." is not valid JSON").
	let redacted = text.replace(
		/, (?:\.\.\.)?"[\s\S]*"(?:\.\.\.)? is not valid JSON/g,
		", <content redacted> is not valid JSON",
	);
	for (const secret of secrets) redacted = redacted.split(secret).join("<redacted>");
	return redacted
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1<redacted>@")
		.replace(/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1<redacted>")
		.replace(/\bsk-[\w-]{8,}/g, "<redacted>");
}

function redactCheck(check: DoctorCheck, secrets: readonly string[]): DoctorCheck {
	const redacted: DoctorCheck = { ...check, summary: redactSecrets(check.summary, secrets) };
	if (check.remediation) redacted.remediation = redactSecrets(check.remediation, secrets);
	if (check.details) {
		redacted.details = Object.fromEntries(
			Object.entries(check.details).map(([key, value]) => [
				key,
				typeof value === "string" ? redactSecrets(value, secrets) : value,
			]),
		);
	}
	return redacted;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
	const context = new DoctorContext(options);
	const checks: DoctorCheck[] = [checkExecutable(context), checkRuntime(), checkAssets(context)];

	checks.push(checkSettings(context), await checkModelsJson(context));
	const auth = await checkAuthFile(context);
	checks.push(auth.check);

	// Project settings stay untrusted here: model checks use the configuration every project sees.
	const settings = SettingsManager.create(context.cwd, context.agentDir, { projectTrusted: false });
	let defaultModel: Model<Api> | undefined;
	try {
		const runtime = await createDoctorModelRuntime(context, auth.valid);
		const result = await checkDefaultModel(runtime, settings);
		defaultModel = result.model;
		checks.push(result.check, await checkEnabledModels(context, runtime, settings));
	} catch (error) {
		checks.push({
			id: "models.default",
			status: "fail",
			summary: `Could not load the model catalog: ${errorMessage(error)}`,
			remediation: `Run "${APP_NAME} --list-models" to see the full error.`,
		});
	}

	const bus = resolveBusExecutable(context);
	checks.push(checkBusEnvironment(context), checkBusExecutable(context, bus), checkBusScopes(context));

	if (options.probe) {
		applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
		configureHttpDispatcher();
		checks.push(await probeProvider(context, defaultModel), probeBus(context, bus));
	}

	const secrets = collectSecrets(context);
	const redacted = checks.map((check) => redactCheck(check, secrets));
	return {
		schemaVersion: DOCTOR_SCHEMA_VERSION,
		version: VERSION,
		ok: redacted.every((check) => check.status !== "fail"),
		probe: options.probe === true,
		checks: redacted,
	};
}

const STATUS_LABELS: Record<DoctorStatus, string> = {
	pass: chalk.green("ok  "),
	warn: chalk.yellow("warn"),
	fail: chalk.red("fail"),
	skip: chalk.dim("skip"),
};

export function formatDoctorReport(report: DoctorReport): string {
	const width = Math.max(...report.checks.map((check) => check.id.length));
	const lines = [chalk.bold(`${APP_NAME} doctor ${report.version}`)];
	for (const check of report.checks) {
		lines.push(`  ${STATUS_LABELS[check.status]}  ${check.id.padEnd(width)}  ${check.summary}`);
		if (check.remediation && check.status !== "pass") {
			lines.push(`  ${" ".repeat(6 + width)}  ${chalk.dim(`-> ${check.remediation}`)}`);
		}
	}
	const failed = report.checks.filter((check) => check.status === "fail").length;
	const warned = report.checks.filter((check) => check.status === "warn").length;
	lines.push(
		failed + warned === 0
			? "No problems found."
			: `${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}.${report.probe ? "" : " Add --probe to test provider and Bus connectivity."}`,
	);
	return lines.join("\n");
}

export interface DoctorCommandOptions {
	agentDir: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	error?: (line: string) => void;
}

/** Runs `october doctor`; returns the process exit code. */
export async function runDoctorCommand(args: string[], options: DoctorCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	let json = false;
	let probe = false;
	let timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			log(HELP);
			return 0;
		}
		if (arg === "--json") json = true;
		else if (arg === "--probe") probe = true;
		else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
			const value = arg === "--timeout" ? args[++index] : arg.slice("--timeout=".length);
			const parsed = Number(value);
			if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DOCTOR_TIMEOUT_MS) {
				error(`--timeout must be a whole number of milliseconds from 1 to ${MAX_DOCTOR_TIMEOUT_MS}`);
				return 1;
			}
			timeoutMs = parsed;
		} else {
			error(`Unknown option for "${APP_NAME} doctor": ${arg}\nUse "${APP_NAME} doctor --help".`);
			return 1;
		}
	}

	let cwd = options.cwd;
	if (!cwd) {
		try {
			cwd = process.cwd();
		} catch {
			cwd = options.agentDir;
		}
	}
	const report = await runDoctor({ agentDir: options.agentDir, cwd, env: options.env, probe, timeoutMs });
	log(json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
	return report.ok ? 0 : 1;
}
