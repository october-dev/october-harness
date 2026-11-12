import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import type { PathMetadata } from "../package-manager.ts";
import { getResourcePathKey } from "../source-info.ts";
import { type CapabilityDisclosure, type CapabilityManifest, readCapabilityManifest } from "./capabilities.ts";
import type { ExtensionAPI } from "./types.ts";

/**
 * First-load disclosure for project-owned and installed extensions (#7).
 * A manifest describes expected host use. It is not a sandbox and does not prove behavior.
 */

export const CAPABILITY_PREFLIGHT_FILE = "capability-preflight.json";

export interface CapabilityPreflightItem {
	path: string;
	reason: "project" | "installed";
	disclosure: CapabilityDisclosure;
	fingerprint: string;
	summary: string;
	details: string;
}

export interface CapabilityInspectionEntry {
	path: string;
	pathKey: string;
	reason: "project" | "installed";
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
	const parts: string[] = [];
	if (manifest.filesystem?.read) parts.push(`read ${manifest.filesystem.read}`);
	if (manifest.filesystem?.write) parts.push(`write ${manifest.filesystem.write}`);
	if (manifest.shell === true) parts.push("shell");
	else if (manifest.shell === false) parts.push("no shell");
	if (manifest.network) parts.push(manifest.network.length ? `network ${manifest.network.join(", ")}` : "no network");
	if (manifest.environment) {
		parts.push(manifest.environment.length ? `env ${manifest.environment.join(", ")}` : "no env");
	}
	if (manifest.credentials) {
		parts.push(manifest.credentials.length ? `credentials ${manifest.credentials.join(", ")}` : "no credentials");
	}
	if (manifest.octoberBus === true) parts.push("October Bus");
	else if (manifest.octoberBus === false) parts.push("no October Bus");
	return parts.length > 0 ? parts.join("; ") : "no capabilities declared";
}

/** Concise disclosure. Unclassified extensions are named as unclassified, not as safe. */
export function formatCapabilitySummary(filePath: string, disclosure: CapabilityDisclosure): string {
	const name = basename(filePath);
	if (disclosure.status === "unclassified") {
		return `${name}: unclassified. No capability manifest. This is not treated as safe.`;
	}
	if (disclosure.status === "invalid") {
		return `${name}: invalid capability manifest. ${disclosure.errors.join("; ")}`;
	}
	return `${name}: ${describeManifest(disclosure.manifest)}. Disclosure only; this is not a sandbox.`;
}

/** Full manifest text for inspection after installation. */
export function formatCapabilityDetails(filePath: string, disclosure: CapabilityDisclosure): string {
	const lines = [formatCapabilitySummary(filePath, disclosure), ""];
	if (disclosure.status === "declared") {
		lines.push(`Source: ${disclosure.source}`, JSON.stringify(disclosure.manifest, null, 2));
	} else if (disclosure.status === "invalid") {
		lines.push(`Source: ${disclosure.source}`, ...disclosure.errors);
	} else {
		lines.push("No manifest file was found. Unclassified extensions are not treated as safe.");
	}
	lines.push(
		"",
		"A capability manifest is disclosure metadata. It is not an operating-system sandbox and does not prove what the extension does.",
	);
	return lines.join("\n");
}

function disclosureFor(entryPath: string): CapabilityDisclosure {
	const resolved = resolvePath(entryPath);
	return readCapabilityManifest(resolved);
}

function preflightItem(entryPath: string, reason: "project" | "installed"): CapabilityPreflightItem {
	const disclosure = disclosureFor(entryPath);
	return {
		path: entryPath,
		reason,
		disclosure,
		fingerprint: capabilityFingerprint(disclosure),
		summary: formatCapabilitySummary(entryPath, disclosure),
		details: formatCapabilityDetails(entryPath, disclosure),
	};
}

export function capabilityPreflightPath(agentDir: string): string {
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
	writeFileSync(capabilityPreflightPath(agentDir), `${JSON.stringify(store, null, 2)}\n`);
}

export interface CapabilityPreflightPlan {
	/** Paths that may load without a new disclosure. */
	ready: string[];
	/** Project-owned or installed extensions whose code has not been accepted for this manifest. */
	pending: CapabilityPreflightItem[];
}

/**
 * Choose which extensions need disclosure before their code is loaded.
 * Invalid manifests are left to the loader, which already refuses them before import.
 */
export function planCapabilityPreflight(
	paths: string[],
	metadataByPath: Map<string, PathMetadata>,
	acknowledgements: Record<string, string>,
): CapabilityPreflightPlan {
	const ready: string[] = [];
	const pending: CapabilityPreflightItem[] = [];
	for (const entryPath of paths) {
		const metadata = metadataByPath.get(entryPath) ?? metadataByPath.get(resolvePath(entryPath));
		const reason = capabilityPreflightReason(metadata);
		if (!reason || entryPath.startsWith("builtin:")) {
			ready.push(entryPath);
			continue;
		}
		const item = preflightItem(entryPath, reason);
		if (item.disclosure.status === "invalid") {
			ready.push(entryPath);
			continue;
		}
		const pathKey = getResourcePathKey(resolvePath(entryPath));
		if (acknowledgements[pathKey] === item.fingerprint) ready.push(entryPath);
		else pending.push(item);
	}
	return { ready, pending };
}

export function recordCapabilityInspection(
	agentDir: string,
	items: CapabilityPreflightItem[],
	acknowledgements: Record<string, string>,
): void {
	const store = readCapabilityPreflightStore(agentDir);
	const entries = new Map(store.entries.map((entry) => [entry.pathKey, entry]));
	for (const item of items) {
		const pathKey = getResourcePathKey(resolvePath(item.path));
		entries.set(pathKey, {
			path: item.path,
			pathKey,
			reason: item.reason,
			status: item.disclosure.status,
			fingerprint: item.fingerprint,
			summary: item.summary,
			details: item.details,
			acknowledged: acknowledgements[pathKey] === item.fingerprint,
		});
	}
	writeStore(agentDir, { version: 1, acknowledgements, entries: [...entries.values()] });
}

export function acknowledgeCapabilities(agentDir: string, items: CapabilityPreflightItem[]): void {
	const store = readCapabilityPreflightStore(agentDir);
	for (const item of items) {
		store.acknowledgements[getResourcePathKey(resolvePath(item.path))] = item.fingerprint;
	}
	const acknowledged = new Set(items.map((item) => getResourcePathKey(resolvePath(item.path))));
	store.entries = store.entries.map((entry) =>
		acknowledged.has(entry.pathKey)
			? { ...entry, acknowledged: true, fingerprint: store.acknowledgements[entry.pathKey] ?? entry.fingerprint }
			: entry,
	);
	writeStore(agentDir, store);
}

export function formatCapabilityInspection(agentDir: string, query?: string): string {
	const entries = readCapabilityPreflightStore(agentDir).entries;
	if (entries.length === 0) return "No project or installed extensions to inspect yet.";
	const needle = query?.trim().toLowerCase();
	const selected = needle
		? entries.filter(
				(entry) => entry.path.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle),
			)
		: entries;
	if (selected.length === 0) return `No capability record matches ${query}.`;
	if (needle && selected.length === 1) return selected[0]?.details ?? "";
	return selected
		.map((entry) => `${entry.acknowledged ? "remembered" : "not remembered"} ${entry.reason}: ${entry.summary}`)
		.join("\n");
}

/** `/capabilities` prints the manifest recorded for project and installed extensions. */
export function registerCapabilityInspection(pi: ExtensionAPI, agentDir: string): void {
	pi.registerCommand("capabilities", {
		description: "Show capability manifests for project and installed extensions",
		handler: async (args, ctx) => {
			ctx.ui.notify(formatCapabilityInspection(agentDir, args), "info");
		},
	});
}
