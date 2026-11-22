/**
 * Hunt workspace: where a PenHarness engagement lives on disk, and how october finds, scaffolds,
 * and reads it. One hunt is a directory `hunts/<slug>/` holding the authorization (`scope.md`), the
 * worker rules of engagement (`brief.md`), the merged ledger (`findings.md`), the machine-readable
 * index (`findings.d/index.jsonl`), dead ends, chains, evidence, and the report.
 *
 * The directory layout is deliberately identical to upstream PenHarness so a hunt is portable
 * between the two harnesses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { briefTemplate, scopeTemplate } from "./methodology.ts";

/** Subdirectory under the workspace root that holds per-engagement hunt directories. */
export const HUNTS_DIRNAME = "hunts";

/** Marker file: the hunt loop is engaged for this hunt. Created by `/hunt`, removed by stop. */
const ACTIVE_MARKER = ".hunt-active";
/** Marker file: the hunt loop is paused for this hunt. Created by `/hunt-pause`. */
const PAUSE_MARKER = ".hunt-loop-pause";

/** A parsed finding line from `findings.d/index.jsonl`. All fields optional — workers write freely. */
export interface LedgerEntry {
	id?: string;
	stream?: string;
	worker?: string;
	status?: string;
	sev?: string;
	class?: string;
	title?: string;
	where?: string;
	proof?: string;
	control?: string;
	chain?: string;
	detail?: string;
}

export interface LedgerSummary {
	entries: LedgerEntry[];
	byStatus: Record<string, number>;
	bySev: Record<string, number>;
	deadEnds: number;
}

function slugify(target: string): string {
	const slug = target
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "target";
}

function writeIfMissing(filePath: string, content: string): void {
	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, content, { encoding: "utf-8" });
	}
}

/**
 * Create (or top up) the hunt directory for `target` under `baseDir/hunts/<slug>/` and engage the
 * loop marker. Idempotent: never clobbers an existing `scope.md` (the user's authorization) or a
 * ledger. Returns the absolute hunt directory path.
 */
export function scaffoldHunt(baseDir: string, target: string): string {
	const huntDir = path.join(baseDir, HUNTS_DIRNAME, slugify(target));
	fs.mkdirSync(path.join(huntDir, "findings.d"), { recursive: true });
	fs.mkdirSync(path.join(huntDir, "chains"), { recursive: true });
	fs.mkdirSync(path.join(huntDir, "evidence"), { recursive: true });
	fs.mkdirSync(path.join(huntDir, "report"), { recursive: true });

	writeIfMissing(path.join(huntDir, "scope.md"), scopeTemplate(target));
	writeIfMissing(path.join(huntDir, "brief.md"), briefTemplate(target));
	writeIfMissing(path.join(huntDir, "findings.md"), `# Findings — ${target}\n\n(No confirmed findings yet.)\n`);
	writeIfMissing(path.join(huntDir, "findings.d", "index.jsonl"), "");
	writeIfMissing(path.join(huntDir, "dead-ends.md"), `# Dead ends — ${target}\n\n`);
	writeIfMissing(path.join(huntDir, "notes.md"), `# Notes — ${target}\n\n`);

	engageLoop(huntDir);
	return huntDir;
}

/** True when the directory is a hunt (has a `scope.md`). */
export function isHuntDir(dir: string): boolean {
	return fs.existsSync(path.join(dir, "scope.md"));
}

/** Whether the user has filled in `scope.md` past the unfilled template (heuristic: a real target). */
export function scopeLooksAuthorized(huntDir: string): boolean {
	try {
		const scope = fs.readFileSync(path.join(huntDir, "scope.md"), "utf-8");
		const authSection = scope.split("## Explicitly out of scope")[0] ?? "";
		// A real authorized target is a non-comment, non-heading bullet under "Authorized targets".
		return authSection
			.split("\n")
			.some(
				(line) => /^\s*-\s+/.test(line) && !line.includes("<!--") && line.replace(/^\s*-\s*/, "").trim().length > 0,
			);
	} catch {
		return false;
	}
}

export function engageLoop(huntDir: string): void {
	fs.writeFileSync(path.join(huntDir, ACTIVE_MARKER), "", { encoding: "utf-8" });
	try {
		fs.rmSync(path.join(huntDir, PAUSE_MARKER));
	} catch {
		/* not paused */
	}
}

export function pauseLoop(huntDir: string): void {
	fs.writeFileSync(path.join(huntDir, PAUSE_MARKER), "", { encoding: "utf-8" });
}

export function resumeLoop(huntDir: string): void {
	try {
		fs.rmSync(path.join(huntDir, PAUSE_MARKER));
	} catch {
		/* already running */
	}
	engageLoop(huntDir);
}

export function stopLoop(huntDir: string): void {
	try {
		fs.rmSync(path.join(huntDir, ACTIVE_MARKER));
	} catch {
		/* already stopped */
	}
}

export function isActive(huntDir: string): boolean {
	return fs.existsSync(path.join(huntDir, ACTIVE_MARKER));
}

export function isPaused(huntDir: string): boolean {
	return fs.existsSync(path.join(huntDir, PAUSE_MARKER));
}

function listHuntDirs(baseDir: string): string[] {
	const dirs: string[] = [];
	if (isHuntDir(baseDir)) dirs.push(baseDir);
	const huntsRoot = path.join(baseDir, HUNTS_DIRNAME);
	try {
		for (const entry of fs.readdirSync(huntsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "TEMPLATE") continue;
			const candidate = path.join(huntsRoot, entry.name);
			if (isHuntDir(candidate)) dirs.push(candidate);
		}
	} catch {
		/* no hunts/ dir */
	}
	return dirs;
}

/**
 * Find the hunt directory reachable from `cwd`: either `cwd` itself, or a `cwd/hunts/<slug>/`.
 * Returns the first one found, or null. Used for `/hunt-status` and friends (ignores loop markers).
 */
export function findHunt(cwd: string): string | null {
	const dirs = listHuntDirs(cwd);
	return dirs[0] ?? null;
}

/**
 * Find the hunt whose loop is currently engaged (active marker present, not paused) reachable from
 * `cwd`. This is what the idle loop keys off. Returns null when there is nothing to keep hunting.
 */
export function findActiveHunt(cwd: string): string | null {
	for (const dir of listHuntDirs(cwd)) {
		if (isActive(dir) && !isPaused(dir)) return dir;
	}
	return null;
}

/** Parse the machine-readable ledger. Tolerant: malformed lines are skipped, never thrown. */
export function readLedger(huntDir: string): LedgerSummary {
	const entries: LedgerEntry[] = [];
	try {
		const raw = fs.readFileSync(path.join(huntDir, "findings.d", "index.jsonl"), "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (parsed && typeof parsed === "object") entries.push(parsed as LedgerEntry);
			} catch {
				/* skip malformed line */
			}
		}
	} catch {
		/* no ledger yet */
	}

	const byStatus: Record<string, number> = {};
	const bySev: Record<string, number> = {};
	for (const entry of entries) {
		const status = entry.status ?? "unknown";
		const sev = entry.sev ?? "unknown";
		byStatus[status] = (byStatus[status] ?? 0) + 1;
		bySev[sev] = (bySev[sev] ?? 0) + 1;
	}

	let deadEnds = 0;
	try {
		const deadRaw = fs.readFileSync(path.join(huntDir, "dead-ends.md"), "utf-8");
		deadEnds = deadRaw.split("\n").filter((line) => /^\s*-\s+/.test(line)).length;
	} catch {
		/* no dead-ends file */
	}

	return { entries, byStatus, bySev, deadEnds };
}

/** Render a short human summary of the ledger for the status command and loop context. */
export function summarizeLedger(huntDir: string): string {
	const { entries, byStatus, bySev, deadEnds } = readLedger(huntDir);
	if (entries.length === 0 && deadEnds === 0) {
		return `Hunt at ${huntDir}\nNo findings or dead ends recorded yet.`;
	}
	const statusLine = Object.entries(byStatus)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ");
	const sevLine = Object.entries(bySev)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ");
	const confirmed = entries.filter((entry) => entry.status === "confirmed");
	const headlines = confirmed
		.slice(0, 15)
		.map(
			(entry) =>
				`  - [${entry.sev ?? "?"}] ${entry.id ?? "?"} ${entry.title ?? "(untitled)"} @ ${entry.where ?? "?"}`,
		)
		.join("\n");
	return [
		`Hunt at ${huntDir}`,
		`${entries.length} finding(s) — by status: ${statusLine || "none"} — by severity: ${sevLine || "none"}`,
		`${deadEnds} dead end(s) recorded`,
		confirmed.length > 0 ? `Confirmed:\n${headlines}` : "No confirmed findings yet.",
	].join("\n");
}
