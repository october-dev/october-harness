/**
 * `october local-models`: opt-in discovery of models served by local inference servers.
 *
 * Runs only when invoked. Probes a fixed list of loopback endpoints (or one user-entered
 * loopback URL), previews the provider entries it would add to models.json, and writes
 * only after confirmation. It never touches auth.json and never contacts a non-loopback host.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import { Compile } from "typebox/compile";
import { APP_NAME } from "../config.ts";
import { ModelsConfigSchema } from "../core/model-config.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export type ModelListFormat = "ollama" | "openai";

export interface LocalEndpoint {
	providerId: string;
	label: string;
	/** OpenAI-compatible base URL written to models.json. */
	baseUrl: string;
	/** URL probed for the model list. */
	listUrl: string;
	format: ModelListFormat;
}

/** Default ports of common local servers. Ollama is read through its native list, which includes every pulled model. */
export const KNOWN_LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
	{
		providerId: "ollama",
		label: "Ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		listUrl: "http://127.0.0.1:11434/api/tags",
		format: "ollama",
	},
	{
		providerId: "lmstudio",
		label: "LM Studio",
		baseUrl: "http://127.0.0.1:1234/v1",
		listUrl: "http://127.0.0.1:1234/v1/models",
		format: "openai",
	},
	{
		providerId: "vllm",
		label: "vLLM",
		baseUrl: "http://127.0.0.1:8000/v1",
		listUrl: "http://127.0.0.1:8000/v1/models",
		format: "openai",
	},
];

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const MAX_PROBE_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS_PER_ENDPOINT = 500;
const MAX_MODEL_ID_LENGTH = 256;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const HELP = `Usage:
  ${APP_NAME} local-models [--url <url>] [--provider <id>] [--timeout <ms>] [--yes]

Find models served by local inference servers and add them to models.json.

Without --url, probes only these loopback endpoints:
${KNOWN_LOCAL_ENDPOINTS.map((endpoint) => `  ${endpoint.label.padEnd(10)} ${endpoint.listUrl}`).join("\n")}

Options:
  --url <url>        Probe one OpenAI-compatible server instead, for example http://localhost:8080/v1.
                     Only localhost, 127.0.0.0/8, and [::1] are accepted.
  --provider <id>    Provider ID for --url (default: local-<port>)
  --timeout <ms>     Time limit per endpoint (default: ${DEFAULT_PROBE_TIMEOUT_MS}, at most ${MAX_PROBE_TIMEOUT_MS})
  --yes, -y          Write without asking. Required when stdin is not a terminal.

Nothing is written until you confirm. Existing providers keep their settings; only missing models are added.
Servers that need an API key are not supported here; configure them by hand (see docs/models.md).`;

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (host.toLowerCase() === "localhost") return true;
	return isLoopbackAddress(host);
}

function isLoopbackAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return address.split(".")[0] === "127";
	if (family === 6) return address === "::1" || address.toLowerCase().startsWith("::ffff:127.");
	return false;
}

export type ResolveAll = (
	hostname: string,
	options: LookupAllOptions,
	callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * Returns a `lookup` for http.get that resolves like dns.lookup but fails unless every resolved
 * address is loopback, so a `localhost` remapped in /etc/hosts cannot send the probe elsewhere.
 * IP literals skip `lookup` entirely; endpointFromUrl has already checked those.
 */
export function createLoopbackOnlyLookup(resolveAll: ResolveAll = dnsLookup as ResolveAll): LookupFunction {
	return (hostname, options, callback) => {
		resolveAll(hostname, { ...options, all: true }, (error, addresses) => {
			if (error) return callback(error, "", 0);
			if (addresses.length === 0 || addresses.some((entry) => !isLoopbackAddress(entry.address))) {
				return callback(new Error(`${hostname} does not resolve to a loopback address`), "", 0);
			}
			// With `all`, Node expects the address list in place of a single address.
			if (options.all) return callback(null, addresses as unknown as string);
			return callback(null, addresses[0].address, addresses[0].family);
		});
	};
}

const loopbackOnlyLookup = createLoopbackOnlyLookup();

/** Builds an endpoint from a user-entered URL. Throws unless the URL is http(s) on a loopback host. */
export function endpointFromUrl(raw: string, providerId?: string): LocalEndpoint {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Not a valid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must use http or https.");
	if (!isLoopbackHostname(url.hostname)) {
		throw new Error(`--url must point at this machine (localhost, 127.0.0.0/8, or [::1]), not ${url.hostname}.`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("--url must not contain credentials, a query, or a fragment.");
	}
	const path = url.pathname.replace(/\/+$/, "");
	const baseUrl = `${url.origin}${path === "" ? "/v1" : path}`;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const id = providerId ?? `local-${port}`;
	if (!PROVIDER_ID_PATTERN.test(id)) {
		throw new Error("--provider must start with a letter or digit and use only letters, digits, '.', '_' or '-'.");
	}
	return { providerId: id, label: id, baseUrl, listUrl: `${baseUrl}/models`, format: "openai" };
}

/** Extracts model IDs from an Ollama `/api/tags` or OpenAI-compatible `/v1/models` response. */
export function parseModelList(format: ModelListFormat, body: unknown): string[] {
	const entries = format === "ollama" ? (body as { models?: unknown })?.models : (body as { data?: unknown })?.data;
	if (!Array.isArray(entries)) {
		throw new Error(format === "ollama" ? "response has no models array" : "response has no data array");
	}
	const ids: string[] = [];
	for (const entry of entries) {
		const id = format === "ollama" ? (entry as { name?: unknown })?.name : (entry as { id?: unknown })?.id;
		if (typeof id !== "string" || id.length === 0 || id.length > MAX_MODEL_ID_LENGTH || CONTROL_CHARACTERS.test(id)) {
			continue;
		}
		if (!ids.includes(id)) ids.push(id);
		if (ids.length >= MAX_MODELS_PER_ENDPOINT) break;
	}
	return ids;
}

export type ProbeResult = { endpoint: LocalEndpoint; models: string[] } | { endpoint: LocalEndpoint; error: string };

/**
 * Fetches an endpoint's model list. Uses node:http directly so a configured HTTP proxy never sees the
 * request, follows no redirects, and refuses hosts that resolve outside loopback.
 */
export function probeEndpoint(
	endpoint: LocalEndpoint,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: ProbeResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.destroy();
			resolve(result);
		};
		const fail = (error: string) => finish({ endpoint, error });
		const get = endpoint.listUrl.startsWith("https:") ? httpsGet : httpGet;
		const request = get(
			endpoint.listUrl,
			{ headers: { accept: "application/json" }, lookup: loopbackOnlyLookup, agent: false },
			(response: IncomingMessage) => {
				if (response.statusCode !== 200) return fail(`HTTP ${response.statusCode ?? "error"}`);
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_RESPONSE_BYTES) return fail("response is larger than 1 MiB");
					chunks.push(chunk);
				});
				response.on("error", (error) => fail(error.message));
				response.on("end", () => {
					try {
						const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						finish({ endpoint, models: parseModelList(endpoint.format, body) });
					} catch (error) {
						fail(error instanceof SyntaxError ? "response is not JSON" : (error as Error).message);
					}
				});
			},
		);
		const timer = setTimeout(() => fail(`no answer within ${timeoutMs} ms`), timeoutMs);
		request.on("error", (error: NodeJS.ErrnoException) =>
			fail(error.code === "ECONNREFUSED" ? "not running" : error.message),
		);
	});
}

type ModelsJson = { providers: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export interface PlannedChange {
	providerId: string;
	newProvider: boolean;
	addedModels: string[];
}

export interface ModelsPlan {
	config: ModelsJson;
	changes: PlannedChange[];
	/** Providers left untouched because the existing entry points somewhere else. */
	conflicts: string[];
}

/** Returns a new config with discovered models merged in. Existing provider settings and models are never changed. */
export function planModelsConfig(
	existing: ModelsJson,
	found: readonly { endpoint: LocalEndpoint; models: string[] }[],
): ModelsPlan {
	const providers: ModelsJson["providers"] = { ...existing.providers };
	const changes: PlannedChange[] = [];
	const conflicts: string[] = [];
	for (const { endpoint, models } of found) {
		if (models.length === 0) continue;
		const current = providers[endpoint.providerId];
		if (!current) {
			providers[endpoint.providerId] = {
				name: endpoint.label,
				baseUrl: endpoint.baseUrl,
				api: "openai-completions",
				// Local servers ignore the key, but a provider needs one to be selectable. Not a secret.
				apiKey: endpoint.providerId,
				models: models.map((id) => ({ id })),
			};
			changes.push({ providerId: endpoint.providerId, newProvider: true, addedModels: models });
			continue;
		}
		if (!sameBaseUrl(current.baseUrl, endpoint.baseUrl)) {
			conflicts.push(
				`"${endpoint.providerId}" already uses ${String(current.baseUrl ?? "a built-in endpoint")}; left unchanged.`,
			);
			continue;
		}
		const currentModels = Array.isArray(current.models) ? (current.models as { id?: unknown }[]) : [];
		const known = new Set(currentModels.map((model) => model.id));
		const added = models.filter((id) => !known.has(id));
		if (added.length === 0) continue;
		providers[endpoint.providerId] = { ...current, models: [...currentModels, ...added.map((id) => ({ id }))] };
		changes.push({ providerId: endpoint.providerId, newProvider: false, addedModels: added });
	}
	return { config: { ...existing, providers }, changes, conflicts };
}

/** Compares base URLs ignoring a trailing slash and treating localhost as 127.0.0.1. */
function sameBaseUrl(configured: unknown, discovered: string): boolean {
	if (typeof configured !== "string") return false;
	const normalize = (value: string) => {
		const url = new URL(value);
		if (url.hostname === "localhost") url.hostname = "127.0.0.1";
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
	};
	try {
		return normalize(configured) === normalize(discovered);
	} catch {
		return false;
	}
}

interface LoadedModelsFile {
	config: ModelsJson;
	/** Rewriting would drop comments or trailing commas, so the command prints a snippet instead. */
	hasComments: boolean;
}

function loadModelsFile(path: string): LoadedModelsFile {
	if (!existsSync(path)) return { config: { providers: {} }, hasComments: false };
	const text = stripBom(readFileSync(path, "utf8"));
	if (text.trim() === "") return { config: { providers: {} }, hasComments: false };
	const stripped = stripJsonComments(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${(error as Error).message}). Fix it before adding models.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${path} must hold a JSON object.`);
	const object = parsed as Record<string, unknown>;
	const providers = object.providers ?? {};
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error(`${path}: "providers" must be an object.`);
	}
	return { config: { ...object, providers } as ModelsJson, hasComments: stripped !== text };
}

/** Replaces the file atomically. A symlinked models.json stays a symlink: the link target is rewritten. */
function writeModelsFile(path: string, config: ModelsJson): void {
	const target = existsSync(path) ? realpathSync(path) : path;
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode });
		chmodSync(temporary, mode);
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * Writes the previewed config under a lock, after checking that models.json still yields the same
 * result. An edit made while the prompt was open is never overwritten.
 */
function writeIfUnchanged(
	path: string,
	previewed: ModelsJson,
	found: readonly { endpoint: LocalEndpoint; models: string[] }[],
): string | undefined {
	mkdirSync(dirname(path), { recursive: true });
	let release: () => void;
	try {
		release = lockfile.lockSync(path, { realpath: false, lockfilePath: `${path}.lock` });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ELOCKED") return "another process is updating it; try again.";
		throw cause;
	}
	try {
		const current = loadModelsFile(path);
		const replanned = planModelsConfig(current.config, found).config;
		if (current.hasComments || JSON.stringify(replanned) !== JSON.stringify(previewed)) {
			return "it changed while waiting for confirmation. Run the command again.";
		}
		writeModelsFile(path, previewed);
		return undefined;
	} finally {
		release();
	}
}

const validateModelsConfig = Compile(ModelsConfigSchema);

async function askOnTerminal(question: string): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^y(es)?$/i.test((await readline.question(question)).trim());
	} finally {
		readline.close();
	}
}

export interface LocalModelsCommandOptions {
	agentDir: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** Defaults to a y/N prompt on the terminal. */
	confirm?: (question: string) => Promise<boolean>;
	/** Defaults to whether stdin is a terminal. */
	interactive?: boolean;
	/** Endpoints probed without --url. Tests replace the defaults with fake loopback servers. */
	endpoints?: readonly LocalEndpoint[];
}

interface ParsedArgs {
	url?: string;
	provider?: string;
	timeoutMs: number;
	yes: boolean;
}

function parseLocalModelsArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, yes: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const value = () => {
			const next = args[++index];
			if (next === undefined || next.startsWith("-")) throw new Error(`${arg} requires a value.`);
			return next;
		};
		if (arg === "-y" || arg === "--yes") parsed.yes = true;
		else if (arg === "--url") parsed.url = value();
		else if (arg === "--provider") parsed.provider = value();
		else if (arg === "--timeout") {
			parsed.timeoutMs = Number(value());
			if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0 || parsed.timeoutMs > MAX_PROBE_TIMEOUT_MS) {
				throw new Error(`--timeout must be a whole number of milliseconds from 1 to ${MAX_PROBE_TIMEOUT_MS}.`);
			}
		} else throw new Error(`Unknown option for local-models: ${arg}`);
	}
	if (parsed.provider && !parsed.url) throw new Error("--provider applies only with --url.");
	return parsed;
}

export async function runLocalModelsCommand(args: string[], options: LocalModelsCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	if (args.includes("-h") || args.includes("--help")) {
		log(HELP);
		return 0;
	}
	let parsed: ParsedArgs;
	let endpoints: readonly LocalEndpoint[];
	try {
		parsed = parseLocalModelsArgs(args);
		endpoints = parsed.url
			? [endpointFromUrl(parsed.url, parsed.provider)]
			: (options.endpoints ?? KNOWN_LOCAL_ENDPOINTS);
	} catch (cause) {
		error(`${(cause as Error).message}\nUse "${APP_NAME} local-models --help" for usage.`);
		return 1;
	}

	const modelsPath = join(options.agentDir, "models.json");
	let loaded: LoadedModelsFile;
	try {
		loaded = loadModelsFile(modelsPath);
	} catch (cause) {
		error((cause as Error).message);
		return 1;
	}

	log("Checking local servers (nothing leaves this machine):");
	const results = await Promise.all(endpoints.map((endpoint) => probeEndpoint(endpoint, parsed.timeoutMs)));
	const found: { endpoint: LocalEndpoint; models: string[] }[] = [];
	for (const result of results) {
		const label = `  ${result.endpoint.label.padEnd(10)} ${result.endpoint.listUrl}`;
		if ("error" in result) {
			log(`${label}  ${result.error}`);
		} else {
			log(`${label}  ${result.models.length === 1 ? "1 model" : `${result.models.length} models`}`);
			found.push(result);
		}
	}
	if (!found.some((result) => result.models.length > 0)) {
		error(
			"No local models found. Start a server and load a model, or pass --url. See docs/models.md for manual setup.",
		);
		return 1;
	}

	const plan = planModelsConfig(loaded.config, found);
	for (const conflict of plan.conflicts) error(`Skipped: ${conflict}`);
	if (plan.changes.length === 0) {
		log(`Nothing to add: ${modelsPath} already lists every model found.`);
		return 0;
	}

	if (!validateModelsConfig.Check(plan.config)) {
		const [first] = validateModelsConfig.Errors(plan.config);
		const where = first?.instancePath ? ` at ${first.instancePath}` : "";
		error(
			`${modelsPath} does not match the models.json schema${where}: ${first?.message ?? "invalid"}. Nothing was written.`,
		);
		return 1;
	}

	const preview = Object.fromEntries(
		plan.changes.map((change) => [change.providerId, plan.config.providers[change.providerId]]),
	);
	log("");
	for (const change of plan.changes) {
		log(
			`${change.newProvider ? "New provider" : "Update provider"} "${change.providerId}": ${change.addedModels.join(", ")}`,
		);
	}
	log(`\n${JSON.stringify({ providers: preview }, null, 2)}\n`);

	if (loaded.hasComments) {
		error(`${modelsPath} has comments or trailing commas that a rewrite would drop. Add the entries above by hand.`);
		return 1;
	}
	if (!parsed.yes) {
		const interactive = options.interactive ?? process.stdin.isTTY === true;
		if (!interactive) {
			error(`Not written. Rerun with --yes to write these entries to ${modelsPath}.`);
			return 1;
		}
		const confirm = options.confirm ?? askOnTerminal;
		if (!(await confirm(`Write these entries to ${modelsPath}? [y/N] `))) {
			log("Not written.");
			return 0;
		}
	}
	try {
		const refused = writeIfUnchanged(modelsPath, plan.config, found);
		if (refused) {
			error(`Not written: ${modelsPath} ${refused}`);
			return 1;
		}
	} catch (cause) {
		error(`Could not write ${modelsPath}: ${(cause as Error).message}`);
		return 1;
	}
	log(`Updated ${modelsPath}. Open /model in ${APP_NAME} to pick a local model.`);
	return 0;
}
