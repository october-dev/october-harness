import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { cleanDisplayLine, cleanDisplayText } from "../../utils/ansi.ts";
import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import type { PathMetadata } from "../package-manager.ts";
import { getResourcePathKey } from "../source-info.ts";
import { type CapabilityDisclosure, type CapabilityManifest, readCapabilityManifest } from "./capabilities.ts";
import type { ExtensionAPI } from "./types.ts";

/**
 * First-load disclosure for project-owned and installed extensions (#7).
 * A manifest describes expected host use. It is not a sandbox and does not prove behavior.
 */

const CAPABILITY_PREFLIGHT_FILE = "capability-preflight.json";

/**
 * Prefix of the load warning reported for an extension skipped at disclosure time.
 * The suffix tells the user how to reconsider: restart, or change the manifest.
 */
export const CAPABILITY_SKIP_WARNING_PREFIX = "Capability preflight skipped this extension before loading its code.";
/** Recovery hint appended to skip warnings. Esc counts as Skip. */
export const CAPABILITY_SKIP_RECOVERY_HINT = "Restart October (or change the manifest) to be asked again.";

export interface CapabilityPreflightItem {
	path: string;
	reason: "project" | "installed";
	/** Human-readable identity: package source plus entry, or a project-relative path. */
	identity: string;
	disclosure: CapabilityDisclosure;
	fingerprint: string;
	summary: string;
	details: string;
}

export interface CapabilityPreflightDecision {
	path: string;
	accept: boolean;
}

export type CapabilityPreflightHandler = (items: CapabilityPreflightItem[]) => Promise<CapabilityPreflightDecision[]>;

export interface CapabilityPreflightHost {
	disclose: CapabilityPreflightHandler;
	/**
	 * Back interactive prompts with the running UI. Startup selectors run only before the
	 * interactive UI starts; afterwards the active UI handles disclosure for reloads and session
	 * replacement, so no second terminal UI is created and keyboard input keeps working.
	 */
	setInteractiveHandler: (handler: CapabilityPreflightHandler | undefined) => void;
}

export const CAPABILITY_LOAD_CHOICE = "Load and remember";
export const CAPABILITY_SKIP_CHOICE = "Skip";

/**
 * Short disclosure title for one pending item (#7). The title names the current extension
 * and fits the terminal frame with both choices visible; the full pending set and
 * declaration go to {@link formatCapabilityDisclosureDetails}, printed to the scrollable
 * transcript (or terminal scrollback at startup) before the choice is shown.
 */
export function formatCapabilityDisclosureTitle(items: readonly CapabilityPreflightItem[], index: number): string {
	const current = items[index];
	const summary = current ? current.summary : "";
	const shortSummary = summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
	return [
		`Extension capabilities (${index + 1} of ${items.length})`,
		"",
		shortSummary,
		"",
		"Full declaration printed above; scroll to review before choosing.",
	].join("\n");
}

/**
 * Full disclosure for one pending item: the whole pending set with identities first, then
 * the current item's full declaration, so duplicate entry names stay distinguishable and
 * no choice is made blind. Printed where it can scroll; never inside the choice title.
 */
export function formatCapabilityDisclosureDetails(items: readonly CapabilityPreflightItem[], index: number): string {
	const lines = [`Extension capabilities (${index + 1} of ${items.length})`, "", "Pending extensions:"];
	items.forEach((item, position) => {
		lines.push(`${position === index ? ">" : " "} ${position + 1}. ${item.identity}`);
	});
	const current = items[index];
	if (current) {
		lines.push("", current.details);
	}
	return lines.join("\n");
}

export interface CapabilityInspectionEntry {
	path: string;
	pathKey: string;
	reason: "project" | "installed";
	identity: string;
	status: CapabilityDisclosure["status"];
	fingerprint: string;
	summary: string;
	details: string;
	acknowledged: boolean;
}

interface CapabilityPreflightStore {
	version: 1;
	acknowledgements: Record<string, string>;
	entries: CapabilityInspectionEntry[];
}

export function capabilityPreflightReason(metadata: PathMetadata | undefined): "project" | "installed" | undefined {
	if (!metadata || metadata.scope === "temporary" || metadata.source === "builtin") return undefined;
	if (metadata.scope === "project") return "project";
	if (metadata.origin === "package") return "installed";
	return undefined;
}

export function capabilityFingerprint(disclosure: CapabilityDisclosure): string {
	const payload =
		disclosure.status === "declared"
			? { status: disclosure.status, manifest: disclosure.manifest }
			: disclosure.status === "invalid"
				? { status: disclosure.status, errors: disclosure.errors }
				: { status: disclosure.status };
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function describeManifest(manifest: CapabilityManifest): string {
	// Manifest values are extension-supplied: clean each one before display. Loading,
	// matching, and fingerprinting use the raw manifest.
	const cleanList = (values: string[]): string => values.map((value) => cleanDisplayLine(value)).join(", ");
	const parts: string[] = [];
	if (manifest.filesystem?.read) parts.push(`read ${manifest.filesystem.read}`);
	if (manifest.filesystem?.write) parts.push(`write ${manifest.filesystem.write}`);
	if (manifest.shell === true) parts.push("shell");
	else if (manifest.shell === false) parts.push("no shell");
	if (manifest.network) parts.push(manifest.network.length ? `network ${cleanList(manifest.network)}` : "no network");
	if (manifest.environment) {
		parts.push(manifest.environment.length ? `env ${cleanList(manifest.environment)}` : "no env");
	}
	if (manifest.credentials) {
		parts.push(manifest.credentials.length ? `credentials ${cleanList(manifest.credentials)}` : "no credentials");
	}
	if (manifest.octoberBus === true) parts.push("October Bus");
	else if (manifest.octoberBus === false) parts.push("no October Bus");
	return parts.length > 0 ? parts.join("; ") : "no capabilities declared";
}

/**
 * Identify the extension behind a disclosure. Installed extensions show their package source
 * (with version) plus entry path, so duplicate `index.ts` names stay distinguishable; project
 * extensions show a project-relative path when the entry sits under the project cwd.
 */
export function formatCapabilityIdentity(
	entryPath: string,
	reason: "project" | "installed",
	metadata: PathMetadata | undefined,
	cwd?: string,
): string {
	if (reason === "installed" && metadata) {
		let entry = entryPath;
		if (metadata.packageRoot && isAbsolute(entryPath)) {
			const packageRelative = relative(metadata.packageRoot, entryPath);
			if (packageRelative && !packageRelative.startsWith("..") && !isAbsolute(packageRelative)) {
				entry = packageRelative;
			}
		}
		return cleanDisplayLine(`${metadata.source} (${entry})`);
	}
	if (cwd) {
		return cleanDisplayLine(getCwdRelativePath(entryPath, cwd) ?? entryPath);
	}
	return cleanDisplayLine(entryPath);
}

/** Concise disclosure. Unclassified extensions are named as unclassified, not as safe. */
export function formatCapabilitySummary(
	filePath: string,
	disclosure: CapabilityDisclosure,
	identity: string = basename(filePath),
): string {
	// The identity may come from a stored record or a caller; clean it at composition.
	const cleanIdentity = cleanDisplayLine(identity);
	if (disclosure.status === "unclassified") {
		return `${cleanIdentity}: unclassified. No capability manifest. This is not treated as safe.`;
	}
	if (disclosure.status === "invalid") {
		const errors = disclosure.errors.map((error) => cleanDisplayLine(error)).join("; ");
		return `${cleanIdentity}: invalid capability manifest. ${errors}`;
	}
	return `${cleanIdentity}: ${describeManifest(disclosure.manifest)}. Disclosure only; this is not a sandbox.`;
}

/** Full manifest text for inspection after installation. */
export function formatCapabilityDetails(
	filePath: string,
	disclosure: CapabilityDisclosure,
	identity: string = basename(filePath),
): string {
	const lines = [formatCapabilitySummary(filePath, disclosure, identity), ""];
	if (disclosure.status === "declared") {
		// JSON.stringify leaves bidi controls and DEL raw inside strings: clean the whole block.
		lines.push(
			`Source: ${cleanDisplayLine(disclosure.source)}`,
			cleanDisplayText(JSON.stringify(disclosure.manifest, null, 2)),
		);
	} else if (disclosure.status === "invalid") {
		lines.push(
			`Source: ${cleanDisplayLine(disclosure.source)}`,
			...disclosure.errors.map((error) => cleanDisplayLine(error)),
		);
	} else {
		lines.push("No manifest file was found. Unclassified extensions are not treated as safe.");
	}
	lines.push(
		"",
		"A capability manifest is disclosure metadata. It is not an operating-system sandbox and does not prove what the extension does.",
	);
	return lines.join("\n");
}

function preflightItem(
	entryPath: string,
	reason: "project" | "installed",
	metadata: PathMetadata | undefined,
	cwd?: string,
): CapabilityPreflightItem {
	const disclosure = readCapabilityManifest(resolvePath(entryPath));
	const identity = formatCapabilityIdentity(entryPath, reason, metadata, cwd);
	return {
		path: entryPath,
		reason,
		identity,
		disclosure,
		fingerprint: capabilityFingerprint(disclosure),
		summary: formatCapabilitySummary(entryPath, disclosure, identity),
		details: formatCapabilityDetails(entryPath, disclosure, identity),
	};
}

function capabilityPreflightPath(agentDir: string): string {
	return join(agentDir, CAPABILITY_PREFLIGHT_FILE);
}

export function readCapabilityPreflightStore(agentDir: string): CapabilityPreflightStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(capabilityPreflightPath(agentDir), "utf-8"));
		if (!parsed || typeof parsed !== "object") return emptyStore();
		const record = parsed as Partial<CapabilityPreflightStore>;
		const acknowledgements =
			record.acknowledgements && typeof record.acknowledgements === "object" ? record.acknowledgements : {};
		return {
			version: 1,
			acknowledgements: Object.fromEntries(
				Object.entries(acknowledgements).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			),
			entries: Array.isArray(record.entries) ? record.entries.filter(isInspectionEntry) : [],
		};
	} catch {
		return emptyStore();
	}
}

function emptyStore(): CapabilityPreflightStore {
	return { version: 1, acknowledgements: {}, entries: [] };
}

function isInspectionEntry(value: unknown): value is CapabilityInspectionEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<CapabilityInspectionEntry>;
	return typeof entry.path === "string" && typeof entry.summary === "string" && typeof entry.details === "string";
}

function writeStore(agentDir: string, store: CapabilityPreflightStore): void {
	mkdirSync(agentDir, { recursive: true });
	// Atomic replacement: an interrupted in-place write would leave invalid JSON,
	// which later reads treat as an empty store. The lock serializes writers.
	const target = capabilityPreflightPath(agentDir);
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
	renameSync(temporary, target);
}

/**
 * Locked read/merge/write for the shared preflight store, mirroring the trust store. The lock is
 * never held during a prompt: callers decide first, then persist. Unchanged stores are not rewritten.
 */
function withPreflightStoreLock<T>(agentDir: string, fn: () => T): T {
	const filePath = capabilityPreflightPath(agentDir);
	mkdirSync(agentDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const release = lockfile.lockSync(agentDir, { realpath: false, lockfilePath: `${filePath}.lock` });
			try {
				return fn();
			} finally {
				release();
			}
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to keep store callers sync.
			}
		}
	}
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire capability preflight store lock");
}

/**
 * Manifests declined earlier in this process, keyed by resource path key. A decline is not asked
 * about again by later loads in the same process (`/new`, `/fork`, `/resume`, `/reload`), but a
 * restart or a changed manifest asks again.
 */
const declinedFingerprints = new Map<string, string>();

export function rememberCapabilityDecline(pathKey: string, fingerprint: string): void {
	declinedFingerprints.set(pathKey, fingerprint);
}

export function isCapabilityDeclined(pathKey: string, fingerprint: string): boolean {
	return declinedFingerprints.get(pathKey) === fingerprint;
}

export function clearCapabilityDeclinesForTests(): void {
	declinedFingerprints.clear();
}

export interface CapabilityPreflightPlan {
	/** Paths that may load without a new disclosure. */
	ready: string[];
	/** Project-owned or installed extensions whose code has not been accepted for this manifest. */
	pending: CapabilityPreflightItem[];
	/** Declined earlier in this process for the same manifest; skipped without prompting again. */
	skipped: CapabilityPreflightItem[];
	/** Pending plus remembered and invalid items, for inspection history. */
	considered: CapabilityPreflightItem[];
}

/**
 * Choose which extensions need disclosure before their code is loaded.
 * Invalid manifests are left to the loader, which already refuses them before import.
 */
export function planCapabilityPreflight(
	paths: string[],
	metadataByPath: Map<string, PathMetadata>,
	acknowledgements: Record<string, string>,
	options?: { cwd?: string },
): CapabilityPreflightPlan {
	const ready: string[] = [];
	const pending: CapabilityPreflightItem[] = [];
	const skipped: CapabilityPreflightItem[] = [];
	const considered: CapabilityPreflightItem[] = [];
	for (const entryPath of paths) {
		const metadata = metadataByPath.get(entryPath) ?? metadataByPath.get(resolvePath(entryPath));
		const reason = capabilityPreflightReason(metadata);
		if (!reason) {
			ready.push(entryPath);
			continue;
		}
		const item = preflightItem(entryPath, reason, metadata, options?.cwd);
		const pathKey = getResourcePathKey(resolvePath(entryPath));
		if (item.disclosure.status === "invalid") {
			ready.push(entryPath);
			considered.push(item);
			continue;
		}
		// A matching process-local decline wins over a persisted acknowledgement:
		// another process accepting (or auto-acknowledging) the same manifest must
		// not undo this process's Skip. A changed manifest matches neither and asks again.
		if (isCapabilityDeclined(pathKey, item.fingerprint)) {
			skipped.push(item);
			considered.push(item);
			continue;
		}
		if (acknowledgements[pathKey] === item.fingerprint) {
			ready.push(entryPath);
			considered.push(item);
			continue;
		}
		pending.push(item);
		considered.push(item);
	}
	return { ready, pending, skipped, considered };
}

export function recordCapabilityInspection(agentDir: string, items: CapabilityPreflightItem[]): void {
	withPreflightStoreLock(agentDir, () => {
		const store = readCapabilityPreflightStore(agentDir);
		const entries = new Map(store.entries.map((entry) => [entry.pathKey, entry]));
		const refreshed = new Set<string>();
		for (const item of items) {
			const pathKey = getResourcePathKey(resolvePath(item.path));
			refreshed.add(pathKey);
			entries.set(pathKey, {
				path: item.path,
				pathKey,
				reason: item.reason,
				identity: item.identity,
				status: item.disclosure.status,
				fingerprint: item.fingerprint,
				summary: item.summary,
				details: item.details,
				acknowledged: store.acknowledgements[pathKey] === item.fingerprint,
			});
		}
		// Drop records for extensions that no longer exist on disk. Only absolute paths are pruned;
		// anything else is left alone rather than resolved against an unrelated cwd.
		for (const [pathKey, entry] of entries) {
			if (!refreshed.has(pathKey) && isAbsolute(entry.path) && !existsSync(entry.path)) {
				entries.delete(pathKey);
			}
		}
		const next: CapabilityPreflightStore = {
			version: 1,
			acknowledgements: store.acknowledgements,
			entries: [...entries.values()],
		};
		if (JSON.stringify(next) !== JSON.stringify(store)) {
			writeStore(agentDir, next);
		}
	});
}

export function acknowledgeCapabilities(agentDir: string, items: CapabilityPreflightItem[]): void {
	if (items.length === 0) return;
	withPreflightStoreLock(agentDir, () => {
		const store = readCapabilityPreflightStore(agentDir);
		let changed = false;
		for (const item of items) {
			const pathKey = getResourcePathKey(resolvePath(item.path));
			if (store.acknowledgements[pathKey] !== item.fingerprint) {
				store.acknowledgements[pathKey] = item.fingerprint;
				changed = true;
			}
		}
		const acknowledged = new Set(items.map((item) => getResourcePathKey(resolvePath(item.path))));
		store.entries = store.entries.map((entry) => {
			if (!acknowledged.has(entry.pathKey)) return entry;
			const fingerprint = store.acknowledgements[entry.pathKey] ?? entry.fingerprint;
			if (entry.acknowledged && entry.fingerprint === fingerprint) return entry;
			changed = true;
			return { ...entry, acknowledged: true, fingerprint };
		});
		if (changed) {
			writeStore(agentDir, store);
		}
	});
}

export function formatCapabilityInspection(agentDir: string, query?: string): string {
	const entries = readCapabilityPreflightStore(agentDir).entries;
	if (entries.length === 0) return "No project or installed extensions to inspect yet.";
	const needle = query?.trim().toLowerCase();
	const selected = needle
		? entries.filter(
				(entry) =>
					entry.path.toLowerCase().includes(needle) ||
					entry.summary.toLowerCase().includes(needle) ||
					(entry.identity ?? "").toLowerCase().includes(needle),
			)
		: entries;
	if (selected.length === 0) return `No capability record matches ${cleanDisplayLine(query ?? "")}.`;
	// Stored summaries and details predate display cleaning: clean them at read time.
	if (needle && selected.length === 1) return cleanDisplayText(selected[0]?.details ?? "");
	return selected
		.map(
			(entry) =>
				`${entry.acknowledged ? "remembered" : "not remembered"} ${entry.reason}: ${cleanDisplayLine(entry.summary)} [${cleanDisplayLine(entry.path)}]`,
		)
		.join("\n");
}

/**
 * `/capabilities` prints the manifest recorded for project and installed extensions. Output goes
 * through a terminal notification, so the command only shows anything in interactive mode; print,
 * JSON, and RPC runs bind no UI for it.
 */
export function registerCapabilityInspection(pi: ExtensionAPI, agentDir: string): void {
	pi.registerCommand("capabilities", {
		description: "Show capability manifests for project and installed extensions (interactive terminal)",
		handler: async (args, ctx) => {
			ctx.ui.notify(formatCapabilityInspection(agentDir, args), "info");
		},
	});
}
