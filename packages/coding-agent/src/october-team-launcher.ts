import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, getBinDir, isBunBinary } from "./config.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./utils/child-process.ts";

const BUS_RELEASE = "v0.1.0-rc.4";
const BUS_PROTOCOL = "0.1";
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const START_TIMEOUT_MS = 8_000;

interface BusReleaseAsset {
	name: string;
	sha256: string;
	directory: string;
	executable: string;
}

interface TeamLaunchOptions {
	requested: boolean;
	scope?: string;
	agentId?: string;
	displayName?: string;
	busBinary?: string;
	connectTo: string[];
	childArgs: string[];
}

interface TeamScopeCredential {
	scopeId: string;
	scopeToken: string;
}

interface TeamScopeStore {
	version: 1;
	scopes: Record<string, TeamScopeCredential>;
}

interface ListedAgent {
	id: string;
	reachable: boolean;
}

const BUS_ASSETS: Record<string, { name: string; sha256: string }> = {
	"darwin-arm64": {
		name: "october-bus_0.1.0-rc.4_darwin_arm64.tar.gz",
		sha256: "21dc184e2114e8a5cce4a437ca8b9a98db0a5f9a6213ddc815d7c3186f19eea3",
	},
	"darwin-x64": {
		name: "october-bus_0.1.0-rc.4_darwin_amd64.tar.gz",
		sha256: "7cedc16ff0c7df935da966b27ac2c35e6801b9bc66c20c601d066f248878ad45",
	},
	"linux-arm64": {
		name: "october-bus_0.1.0-rc.4_linux_arm64.tar.gz",
		sha256: "c083d731203657a72c8aad40b5db206324db8b339aedcf67779b283fdd2243c0",
	},
	"linux-x64": {
		name: "october-bus_0.1.0-rc.4_linux_amd64.tar.gz",
		sha256: "cd2aa2ecb5f5b6a9dfe7b39e1bf7dc3ec3e43f96edbaa4f93a0838ee883fb16c",
	},
	"win32-arm64": {
		name: "october-bus_0.1.0-rc.4_windows_arm64.zip",
		sha256: "4732720d129b3f0c1c589ca8a6d55cce1427f3232ec0ba79d00ea25fdbd15f67",
	},
	"win32-x64": {
		name: "october-bus_0.1.0-rc.4_windows_amd64.zip",
		sha256: "a5889f8d733677f15ccef6ab786ed049f148458c5259554ac794b6f78a243794",
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function flagValue(argv: string[], index: number, name: string): { value: string; consumed: number } {
	const argument = argv[index];
	const equals = `${name}=`;
	if (argument.startsWith(equals)) {
		const value = argument.slice(equals.length).trim();
		if (!value) throw new Error(`${name} requires a value`);
		return { value, consumed: 1 };
	}
	const value = argv[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
	return { value, consumed: 2 };
}

export function parseTeamLaunchArgs(argv: string[]): TeamLaunchOptions {
	const options: TeamLaunchOptions = { requested: false, connectTo: [], childArgs: [] };
	for (let index = 0; index < argv.length; ) {
		const argument = argv[index];
		if (argument === "--") {
			options.childArgs.push(...argv.slice(index));
			break;
		}
		if (argument === "--team") {
			options.requested = true;
			index++;
			continue;
		}
		const definitions: Array<
			[string, keyof Pick<TeamLaunchOptions, "scope" | "agentId" | "displayName" | "busBinary">]
		> = [
			["--team-scope", "scope"],
			["--team-id", "agentId"],
			["--team-name", "displayName"],
			["--team-bus", "busBinary"],
		];
		const definition = definitions.find(([name]) => argument === name || argument.startsWith(`${name}=`));
		if (definition) {
			options.requested = true;
			const parsed = flagValue(argv, index, definition[0]);
			options[definition[1]] = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === "--team-connect-to" || argument.startsWith("--team-connect-to=")) {
			options.requested = true;
			const parsed = flagValue(argv, index, "--team-connect-to");
			options.connectTo.push(parsed.value);
			index += parsed.consumed;
			continue;
		}
		options.childArgs.push(argument);
		index++;
	}
	return options;
}

export function resolveBusReleaseAsset(
	platform: NodeJS.Platform = process.platform,
	architecture: string = process.arch,
): BusReleaseAsset {
	const asset = BUS_ASSETS[`${platform}-${architecture}`];
	if (!asset) throw new Error(`October Bus does not publish a ${platform}/${architecture} binary`);
	const directory = asset.name.replace(/\.(?:tar\.gz|zip)$/, "");
	return {
		...asset,
		directory,
		executable: platform === "win32" ? "october-bus.exe" : "october-bus",
	};
}

function commandOutput(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function usableBus(command: string): boolean {
	const version = commandOutput(command, ["version"]);
	return version?.includes(`protocol ${BUS_PROTOCOL}`) === true;
}

async function downloadArchive(asset: BusReleaseAsset): Promise<Buffer> {
	const url = `https://github.com/october-dev/october-bus/releases/download/${BUS_RELEASE}/${asset.name}`;
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
	if (!response.ok || !response.body) throw new Error(`October Bus download failed: HTTP ${response.status}`);
	const declaredSize = Number(response.headers.get("content-length") ?? "0");
	if (declaredSize > MAX_ARCHIVE_BYTES) {
		await response.body.cancel();
		throw new Error(`October Bus archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
	}
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunk of response.body) {
		const buffer = Buffer.from(chunk);
		received += buffer.byteLength;
		if (received > MAX_ARCHIVE_BYTES) {
			await response.body.cancel();
			throw new Error(`October Bus archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
		}
		chunks.push(buffer);
	}
	const archive = Buffer.concat(chunks);
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== asset.sha256) throw new Error(`October Bus archive checksum mismatch for ${asset.name}`);
	return archive;
}

async function installManagedBus(): Promise<string> {
	const asset = resolveBusReleaseAsset();
	const binDirectory = getBinDir();
	const destination = join(binDirectory, `october-bus-${BUS_RELEASE}${process.platform === "win32" ? ".exe" : ""}`);
	mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(binDirectory, {
		lockfilePath: `${destination}.lock`,
		realpath: false,
		stale: 120_000,
		retries: { retries: 600, minTimeout: 50, maxTimeout: 200 },
	});
	try {
		if (existsSync(destination)) {
			if (!usableBus(destination)) throw new Error(`Managed October Bus is invalid: ${destination}`);
			return destination;
		}

		console.error(`Installing checksum-verified October Bus ${BUS_RELEASE}...`);
		const archive = await downloadArchive(asset);
		const extractionRoot = mkdtempSync(join(tmpdir(), "october-bus-install-"));
		let temporary: string | undefined;
		try {
			const archivePath = join(extractionRoot, asset.name);
			writeFileSync(archivePath, archive, { mode: 0o600 });
			const extracted = spawnProcessSync("tar", ["-xf", archivePath, "-C", extractionRoot], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (extracted.status !== 0) {
				throw new Error(
					extracted.error?.message || extracted.stderr.trim() || "could not extract October Bus archive",
				);
			}
			const source = join(extractionRoot, asset.directory, asset.executable);
			if (!lstatSync(source).isFile())
				throw new Error("October Bus archive did not contain the expected executable");
			temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
			copyFileSync(source, temporary, constants.COPYFILE_EXCL);
			chmodSync(temporary, 0o755);
			renameSync(temporary, destination);
		} finally {
			if (temporary && existsSync(temporary)) rmSync(temporary, { force: true });
			rmSync(extractionRoot, { recursive: true, force: true });
		}
		if (!usableBus(destination)) throw new Error("Installed October Bus failed its version check");
		return destination;
	} finally {
		await release();
	}
}

async function resolveBusBinary(explicit?: string): Promise<string> {
	if (explicit) {
		if (!usableBus(explicit)) throw new Error(`--team-bus does not provide October Bus protocol ${BUS_PROTOCOL}`);
		return explicit;
	}
	const configured = process.env.OCTOBER_BUS_BINARY;
	if (configured) {
		if (!usableBus(configured))
			throw new Error(`OCTOBER_BUS_BINARY does not provide October Bus protocol ${BUS_PROTOCOL}`);
		return configured;
	}
	if (usableBus("october-bus")) return "october-bus";
	return installManagedBus();
}

async function ensureLocalDaemon(bus: string): Promise<void> {
	if (process.env.OCTOBER_BUS_ADDRESS) return;
	const healthy = (): boolean => {
		const output = commandOutput(bus, ["doctor", "--json"]);
		if (!output) return false;
		try {
			const parsed: unknown = JSON.parse(output);
			return isRecord(parsed) && parsed.healthy === true && parsed.protocolVersion === BUS_PROTOCOL;
		} catch {
			return false;
		}
	};
	if (healthy()) return;
	const daemon = spawnProcess(bus, ["start"], { detached: true, stdio: "ignore", windowsHide: true });
	daemon.unref();
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (healthy()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error("October Bus did not become ready within 8 seconds");
}

function scopeStorePath(): string {
	return join(getAgentDir(), "team-scopes.json");
}

function readScopeStore(): TeamScopeStore {
	const path = scopeStorePath();
	if (!existsSync(path)) return { version: 1, scopes: {} };
	const stat = lstatSync(path);
	if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
		throw new Error(`${path} must be a regular file readable only by its owner (mode 0600)`);
	}
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
		throw new Error(`${path} is not a valid October team scope store`);
	}
	const scopes: Record<string, TeamScopeCredential> = {};
	for (const [key, value] of Object.entries(parsed.scopes)) {
		if (!isRecord(value) || typeof value.scopeId !== "string" || typeof value.scopeToken !== "string") continue;
		scopes[key] = { scopeId: value.scopeId, scopeToken: value.scopeToken };
	}
	return { version: 1, scopes };
}

function writeScopeStore(store: TeamScopeStore): void {
	const path = scopeStorePath();
	const directory = getAgentDir();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		if (process.platform !== "win32") chmodSync(path, 0o600);
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
}

function scopeKey(cwd: string, requested?: string): string {
	return requested ? `scope:${requested}` : `project:${resolve(cwd)}`;
}

export function defaultTeamScopeId(cwd: string): string {
	const name =
		basename(resolve(cwd))
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project";
	const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 10);
	return `${name}-${digest}`;
}

export function defaultTeamAgentId(cwd: string, parentPid = process.ppid): string {
	const name =
		basename(resolve(cwd))
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "october";
	const terminal =
		process.env.TERM_SESSION_ID ??
		process.env.WT_SESSION ??
		process.env.TMUX_PANE ??
		process.env.WINDOWID ??
		String(parentPid);
	const digest = createHash("sha256").update(`${hostname()}\0${terminal}`).digest("hex").slice(0, 8);
	return `${name}-${digest}`;
}

function scopeEnv(token: string): NodeJS.ProcessEnv {
	return { ...process.env, OCTOBER_BUS_SCOPE_TOKEN: token };
}

function validCredential(bus: string, credential: TeamScopeCredential): boolean {
	return commandOutput(bus, ["agent", "list", "--json"], scopeEnv(credential.scopeToken)) !== undefined;
}

function createScope(bus: string, id: string): TeamScopeCredential {
	const output = commandOutput(bus, ["scope", "create", id]);
	if (!output) throw new Error(`Could not create October Bus scope ${id}`);
	const parsed: unknown = JSON.parse(output);
	if (!isRecord(parsed) || typeof parsed.scopeId !== "string" || typeof parsed.scopeToken !== "string") {
		throw new Error("October Bus returned an invalid scope credential");
	}
	return { scopeId: parsed.scopeId, scopeToken: parsed.scopeToken };
}

async function resolveScopeCredential(bus: string, cwd: string, requested?: string): Promise<TeamScopeCredential> {
	const supplied = process.env.OCTOBER_BUS_SCOPE_TOKEN?.trim();
	if (supplied) {
		const credential = { scopeId: requested ?? "environment", scopeToken: supplied };
		if (!validCredential(bus, credential)) throw new Error("OCTOBER_BUS_SCOPE_TOKEN is not valid for this Bus");
		return credential;
	}
	if (process.env.OCTOBER_BUS_ADDRESS) {
		throw new Error("OCTOBER_BUS_SCOPE_TOKEN is required when OCTOBER_BUS_ADDRESS selects an existing Bus");
	}
	const directory = getAgentDir();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(directory, {
		lockfilePath: `${scopeStorePath()}.lock`,
		realpath: false,
		stale: 10_000,
		retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
	});
	try {
		const store = readScopeStore();
		const key = scopeKey(cwd, requested);
		const saved = store.scopes[key];
		if (saved && validCredential(bus, saved)) return saved;
		const credential = createScope(bus, requested ?? defaultTeamScopeId(cwd));
		store.scopes[key] = credential;
		writeScopeStore(store);
		return credential;
	} finally {
		await release();
	}
}

function listReachableAgents(bus: string, token: string): ListedAgent[] {
	const output = commandOutput(bus, ["agent", "list", "--json"], scopeEnv(token));
	if (!output) return [];
	const parsed: unknown = JSON.parse(output);
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.filter((entry) => typeof entry.id === "string")
		.map((entry) => ({ id: entry.id as string, reachable: entry.reachable === true }));
}

function currentCommand(args: string[]): string[] {
	if (isBunBinary) return [process.execPath, ...args];
	const entrypoint = process.argv[1];
	if (!entrypoint) throw new Error("Cannot determine the October CLI entrypoint");
	return [process.execPath, entrypoint, ...args];
}

/** Returns undefined when normal CLI startup should continue, otherwise the managed child exit code. */
export async function launchOctoberTeam(argv: string[], cwd = process.cwd()): Promise<number | undefined> {
	const options = parseTeamLaunchArgs(argv);
	if (!options.requested) return undefined;
	if (process.env.OCTOBER_BUS_AGENT_TOKEN) {
		throw new Error("Nested --team launch refused: this process already has an October Bus execution credential");
	}
	const bus = await resolveBusBinary(options.busBinary);
	await ensureLocalDaemon(bus);
	const credential = await resolveScopeCredential(bus, cwd, options.scope);
	const agentId = options.agentId ?? defaultTeamAgentId(cwd);
	const displayName = options.displayName ?? `${basename(resolve(cwd))} (${agentId.slice(-8)})`;
	const automaticPeers = listReachableAgents(bus, credential.scopeToken)
		.filter((agent) => agent.reachable && agent.id !== agentId)
		.map((agent) => agent.id);
	const connectTo = [...new Set([...options.connectTo, ...automaticPeers])];
	const command = currentCommand(options.childArgs);
	const busArgs = [
		"agent",
		"run",
		"--id",
		agentId,
		"--name",
		displayName,
		"--heartbeat",
		"4m",
		"--capability",
		"october-harness",
		"--capability",
		"active-delivery",
		"--capability",
		"structured-delegation",
		...connectTo.flatMap((peer) => ["--connect-to", peer]),
		"--",
		...command,
	];
	const child = spawnProcess(bus, busArgs, {
		cwd,
		env: scopeEnv(credential.scopeToken),
		stdio: "inherit",
		windowsHide: false,
	});
	const exitCode = await waitForChildProcess(child);
	return exitCode ?? 1;
}
