import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { BashResult } from "../../core/bash-executor.ts";
import { execCommand } from "../../core/exec.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/** Session record of one explicitly run verification command. Output stays in this record. */
export const VERIFICATION_ENTRY = "october-verification-evidence";
/** Session record of the latest explicit share (or unshare) decision. */
export const VERIFICATION_SHARE_ENTRY = "october-verification-share";
/**
 * Session record of one keyed send's effective attachment decision. Persisted (not
 * closure-local) so a retry after reload, resume, or cache pressure replays the exact
 * bytes the first send carried. Only `message_peer` sends are recorded: the pinned
 * `complete_task` input has no idempotency key, so its calls are always fresh.
 */
export const VERIFICATION_ATTACHMENT_ENTRY = "october-verification-attachment";
export const VERIFICATION_CONTEXT_TITLE = "Verification evidence";
/** Public Bus tools whose task results can carry a verification reference. */
export const BUS_MESSAGE_PEER_TOOL = "mcp__october-bus__message_peer";
export const BUS_COMPLETE_TASK_TOOL = "mcp__october-bus__complete_task";
/**
 * Outgoing Bus payload budgets (pinned Bus v0.1.0-rc.4: validation.go caps message context at
 * 32 items, 512 title bytes, 65536 text bytes and 4096 URI bytes per item, and 256 KiB total
 * across title/text/URI/media-type bytes; runtime.go caps task notes at 16384 bytes).
 * Attachment stays within them; when adding the reference would break a budget the model's
 * own content satisfies, the reference is skipped and the user is told.
 */
export const BUS_MAX_CONTEXT_ITEMS = 32;
export const BUS_MAX_CONTEXT_TITLE_BYTES = 512;
export const BUS_MAX_CONTEXT_TEXT_BYTES = 65536;
export const BUS_MAX_CONTEXT_URI_BYTES = 4096;
export const BUS_MAX_CONTEXT_TOTAL_BYTES = 262144;
export const BUS_MAX_NOTE_BYTES = 16384;

const SHARE_PREVIEW_CHARS = 240;
const STATUS_OUTPUT_CHARS = 2000;
const MAX_DIRTY_FILES = 100;
/** Total bytes hashed for one identity capture; past it the identity is marked incomplete. */
const MAX_IDENTITY_BYTES = 4 * 1024 * 1024;
/**
 * Reference fields are capped so our own context item always fits the per-field budgets.
 * The local record keeps the full command and error; only the Bus-bound reference is cut.
 */
const REFERENCE_MAX_COMMAND_CHARS = 1024;
const REFERENCE_MAX_ERROR_CHARS = 1024;

export type VerificationOutcome = "success" | "failed" | "cancelled" | "unknown";

export interface DirtyFileIdentity {
	path: string;
	/**
	 * Null when the path is a known deletion. For symlinks the digest covers the link
	 * target, not the pointed-to bytes. Unreadable files fail the whole capture.
	 */
	sha256: string | null;
	/** What the path was at capture time. */
	kind: "file" | "symlink" | "deleted";
	/** True when any execute bit was set. */
	executable: boolean;
}

/** Git identity of the tree that was checked. Unavailable outside a repository with a HEAD. */
export interface CodeIdentity {
	available: boolean;
	revision: string | null;
	dirty: boolean;
	files: DirtyFileIdentity[];
	/** True when more dirty paths existed than were hashed. Freshness cannot be proved. */
	filesTruncated: boolean;
}

export interface VerificationEvidence {
	version: 1;
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	endedAt: string;
	outcome: VerificationOutcome;
	/** Null when the process was cancelled or never produced an exit status. */
	exitStatus: number | null;
	/** Identity captured after the run. `changedDuringRun` says whether the tree moved mid-run. */
	code: CodeIdentity;
	/**
	 * True when the tree provably differed before and after the run, false when it provably
	 * did not, null when the comparison was incomplete. Null never reads "current": the
	 * command may have run against a tree this record does not describe.
	 */
	changedDuringRun: boolean | null;
	/** Runner or launch failure detail, such as a rejecting shell runner. */
	error?: string;
	output: { text: string; truncated: boolean };
	/** Complete output location when the session bounded the retained text. */
	fullOutputPath?: string;
}

/** What may be attached to a task or peer message. Full output is omitted unless a preview is requested. */
export interface VerificationReference {
	version: 1;
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	endedAt: string;
	outcome: VerificationOutcome;
	exitStatus: number | null;
	revision: string | null;
	dirty: boolean;
	/** True for a proven before/after difference, null when that comparison was incomplete. */
	changedDuringRun: boolean | null;
	/** Null when this workspace cannot be compared to the recorded identity. */
	stale: boolean | null;
	error?: string;
	outputPreview?: string;
}

/** Bus context item carrying the reference, not the local output, unless a preview was requested. */
export interface VerificationContextItem {
	kind: "text";
	title: string;
	text: string;
	mediaType: string;
}

/**
 * Runs the user's command. Production passes the session runner (`pi.execBash`); tests pass
 * local or faux runners. Cancellation and process-tree cleanup belong to the runner's lifecycle.
 */
export type VerificationBashRunner = (command: string) => Promise<BashResult>;

export interface RunVerificationOptions {
	command: string;
	cwd: string;
	/** Session-selected shell execution. Required: a missing runner must never fall back to the host. */
	runner: VerificationBashRunner;
	/** Checked before spawning only; once started, cancellation belongs to the runner. */
	signal?: AbortSignal;
	now?: () => Date;
}

const EMPTY_IDENTITY: CodeIdentity = {
	available: false,
	revision: null,
	dirty: false,
	files: [],
	filesTruncated: false,
};

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** One porcelain v1 `-z` path. `deleted` marks paths git reports as deleted (known-absent). */
export interface GitStatusEntry {
	path: string;
	deleted: boolean;
}

/**
 * Porcelain v1 `-z` paths. Rename and copy entries carry the destination first
 * (`R  new.ts\0old.ts\0`); the original name is skipped. See git-status porcelain format v1.
 */
export function parseGitStatusEntries(raw: string): GitStatusEntry[] {
	const parts = raw.split("\0").filter((part) => part.length > 0);
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const filePath = entry.slice(3);
		if (status.includes("R") || status.includes("C")) {
			index++; // Skip the original name; the destination identifies the file.
			if (filePath) entries.push({ path: filePath, deleted: status.includes("D") });
		} else if (filePath) {
			entries.push({ path: filePath, deleted: status.includes("D") });
		}
	}
	return entries;
}

/**
 * A Git probe counts only when it ran to completion: an empty `git status` from a probe
 * that was killed or cut short would otherwise read as a clean tree. Killed, truncated,
 * and nonzero probes are all unusable; the identity they were building reads unavailable.
 */
export function isUsableGitResult(result: { code: number; killed: boolean; truncated: boolean }): boolean {
	return result.code === 0 && !result.killed && !result.truncated;
}

/** Fast probes that never walk the tree. */
const GIT_PROBE_TIMEOUT_MS = 5_000;
/**
 * `git status` walks the tree; five seconds kills it in very large repositories and on
 * slow filesystems, which would then read "freshness unknown" on every capture.
 */
const GIT_STATUS_TIMEOUT_MS = 30_000;

async function runGit(cwd: string, args: string[], timeout: number): Promise<{ stdout: string } | undefined> {
	try {
		const result = await execCommand("git", args, cwd, { timeout });
		return isUsableGitResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

interface PathIdentity {
	kind: "file" | "symlink";
	digest: string;
	bytes: number;
	executable: boolean;
}

/**
 * Identify one dirty path without following symlinks. Returns "over-budget" when a
 * regular file alone exceeds the remaining byte budget, undefined when the path
 * cannot be identified (unreadable, or neither a file nor a symlink), else the
 * kind, digest, and bytes charged. A symlink's digest covers its target: replacing
 * a file with a link to identical bytes is a change, as is retargeting the link.
 */
function identifyPathWithinBudget(absolute: string, budget: number): PathIdentity | "over-budget" | undefined {
	let stat: { isFile(): boolean; isSymbolicLink(): boolean; size: number; mode: number };
	try {
		stat = lstatSync(absolute);
	} catch {
		return undefined;
	}
	if (stat.isSymbolicLink()) {
		let target: string;
		try {
			target = readlinkSync(absolute);
		} catch {
			return undefined;
		}
		const bytes = Buffer.byteLength(target, "utf-8");
		if (bytes > budget) return "over-budget";
		return {
			kind: "symlink",
			digest: createHash("sha256").update("symlink\0").update(target, "utf-8").digest("hex"),
			bytes,
			executable: false,
		};
	}
	if (!stat.isFile()) return undefined;
	if (stat.size > budget) return "over-budget";
	try {
		const content = readFileSync(absolute);
		return {
			kind: "file",
			digest: createHash("sha256").update(content).digest("hex"),
			bytes: content.length,
			executable: (stat.mode & 0o111) !== 0,
		};
	} catch {
		return undefined;
	}
}

async function captureCodeIdentity(cwd: string): Promise<CodeIdentity> {
	const toplevel = await runGit(cwd, ["rev-parse", "--show-toplevel"], GIT_PROBE_TIMEOUT_MS);
	const head = await runGit(cwd, ["rev-parse", "HEAD"], GIT_PROBE_TIMEOUT_MS);
	if (!toplevel || !head) return EMPTY_IDENTITY;
	const root = toplevel.stdout.trim();
	const revision = head.stdout.trim();
	if (!root || !revision) return EMPTY_IDENTITY;
	// --untracked-files=all expands untracked directories to files and overrides user config
	// that would hide untracked files. Status paths are repository-root-relative.
	const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], GIT_STATUS_TIMEOUT_MS);
	if (!status) return { ...EMPTY_IDENTITY, revision };
	const seen = new Set<string>();
	const dirtyEntries: GitStatusEntry[] = [];
	for (const entry of parseGitStatusEntries(status.stdout)) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		dirtyEntries.push(entry);
	}
	dirtyEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	let filesTruncated = dirtyEntries.length > MAX_DIRTY_FILES;
	const files: DirtyFileIdentity[] = [];
	let remaining = MAX_IDENTITY_BYTES;
	for (const entry of dirtyEntries.slice(0, MAX_DIRTY_FILES)) {
		const absolute = path.resolve(root, entry.path);
		if (!isInside(root, absolute)) {
			filesTruncated = true;
			continue;
		}
		const identified = identifyPathWithinBudget(absolute, remaining);
		if (identified === "over-budget") {
			filesTruncated = true;
			break;
		}
		if (identified === undefined) {
			// Only a known deletion has a useful "missing" identity.
			if (!entry.deleted) return { ...EMPTY_IDENTITY, revision };
			files.push({ path: entry.path.split(path.sep).join("/"), sha256: null, kind: "deleted", executable: false });
			continue;
		}
		remaining -= identified.bytes;
		files.push({
			path: entry.path.split(path.sep).join("/"),
			sha256: identified.digest,
			// A staged deletion whose worktree file still exists keeps git's verdict
			// but tracks the on-disk bytes, so edits to it stay visible.
			kind: entry.deleted ? "deleted" : identified.kind,
			executable: identified.executable,
		});
	}
	return {
		available: true,
		revision,
		dirty: dirtyEntries.length > 0,
		files,
		filesTruncated,
	};
}

type IdentityComparison = "same" | "changed" | "unknown";

function compareCodeIdentities(first: CodeIdentity, second: CodeIdentity): IdentityComparison {
	if (!first.available || !second.available) return "unknown";
	if (first.revision !== second.revision || first.dirty !== second.dirty) return "changed";
	if (first.filesTruncated || second.filesTruncated) return "unknown";
	if (first.files.length !== second.files.length) return "changed";
	for (let index = 0; index < first.files.length; index++) {
		const previous = first.files[index];
		const next = second.files[index];
		if (
			previous.path !== next.path ||
			previous.sha256 !== next.sha256 ||
			previous.kind !== next.kind ||
			previous.executable !== next.executable
		) {
			return "changed";
		}
	}
	return "same";
}

export function isCodeIdentityStale(recorded: CodeIdentity, current: CodeIdentity): boolean | null {
	const comparison = compareCodeIdentities(recorded, current);
	return comparison === "unknown" ? null : comparison === "changed";
}

/**
 * Run one explicitly selected command and record the observed process result. The code identity
 * is captured before execution and compared afterward: when the tree moved mid-run (an edit, or
 * a command that writes files itself such as a formatter), the outcome is still the observed
 * process result, but the record says the final tree was not verified.
 */
export async function runVerification(options: RunVerificationOptions): Promise<VerificationEvidence> {
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const { command, cwd } = options;
	const finish = (
		outcome: VerificationOutcome,
		exitStatus: number | null,
		code: CodeIdentity,
		output: { text: string; truncated: boolean },
		extra: { changedDuringRun: boolean | null; endedAt: string; error?: string; fullOutputPath?: string },
	): VerificationEvidence => ({
		version: 1,
		id: randomUUID(),
		command,
		cwd,
		startedAt,
		endedAt: extra.endedAt,
		outcome,
		exitStatus,
		code,
		changedDuringRun: extra.changedDuringRun,
		...(extra.error === undefined ? {} : { error: extra.error }),
		output,
		...(extra.fullOutputPath === undefined ? {} : { fullOutputPath: extra.fullOutputPath }),
	});

	if (options.signal?.aborted) {
		return finish(
			"cancelled",
			null,
			EMPTY_IDENTITY,
			{ text: "", truncated: false },
			{
				changedDuringRun: false,
				endedAt: startedAt,
			},
		);
	}
	if (!command.trim()) {
		return finish(
			"unknown",
			null,
			EMPTY_IDENTITY,
			{ text: "", truncated: false },
			{
				changedDuringRun: false,
				endedAt: startedAt,
			},
		);
	}

	const before = await captureCodeIdentity(cwd);
	let result: BashResult;
	try {
		result = await options.runner(command);
	} catch (error) {
		// The command never produced an observation: a rejecting runner, a spawn failure.
		const code = await captureCodeIdentity(cwd);
		return finish(
			"unknown",
			null,
			code,
			{ text: "", truncated: false },
			{
				changedDuringRun: isCodeIdentityStale(before, code),
				endedAt: now().toISOString(),
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
	// Process completion time, captured before git inspection.
	const endedAt = now().toISOString();
	const after = await captureCodeIdentity(cwd);
	const changedDuringRun = isCodeIdentityStale(before, after);
	const output = { text: result.output, truncated: result.truncated };
	const rest = {
		changedDuringRun,
		endedAt,
		...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
	};
	if (result.cancelled) {
		return finish("cancelled", null, after, output, rest);
	}
	// A missing exit status is never success: a signal-killed command reports no status, and
	// the local backend already maps signal deaths to 128 + signal number.
	if (result.exitCode === undefined) {
		return finish("failed", null, after, output, rest);
	}
	if (result.exitCode !== 0) {
		return finish("failed", result.exitCode, after, output, rest);
	}
	return finish("success", 0, after, output, rest);
}

export async function verificationStale(evidence: VerificationEvidence): Promise<boolean | null> {
	const stale = isCodeIdentityStale(evidence.code, await captureCodeIdentity(evidence.cwd));
	// An incomplete start/end comparison can prove the tree stale, never current.
	return evidence.changedDuringRun === null && stale === false ? null : stale;
}

function capReferenceField(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

export async function toVerificationReference(
	evidence: VerificationEvidence,
	options?: { shareOutput?: boolean },
): Promise<VerificationReference> {
	const reference: VerificationReference = {
		version: 1,
		id: evidence.id,
		command: capReferenceField(evidence.command, REFERENCE_MAX_COMMAND_CHARS),
		cwd: evidence.cwd,
		startedAt: evidence.startedAt,
		endedAt: evidence.endedAt,
		outcome: evidence.outcome,
		exitStatus: evidence.exitStatus,
		revision: evidence.code.revision,
		dirty: evidence.code.dirty,
		changedDuringRun: evidence.changedDuringRun,
		stale: evidence.changedDuringRun ? null : await verificationStale(evidence),
		...(evidence.error === undefined ? {} : { error: capReferenceField(evidence.error, REFERENCE_MAX_ERROR_CHARS) }),
	};
	if (options?.shareOutput && evidence.output.text) {
		reference.outputPreview = evidence.output.text.slice(0, SHARE_PREVIEW_CHARS);
	}
	return reference;
}

interface VerificationShareRecord {
	version: 1;
	/** Null clears a previous share. */
	evidenceId: string | null;
}

/**
 * One line for a task note. It names the check and omits command output. The command
 * is flattened to one line: a multi-line command must neither split our own note
 * line (orphan fragments would survive later cleaning) nor inject a fake evidence
 * line into the note.
 */
export function verificationResultLine(reference: VerificationReference): string {
	const exit = reference.exitStatus === null ? "no exit status" : `exit ${reference.exitStatus}`;
	const freshness = reference.changedDuringRun
		? "changed during the run"
		: reference.stale === null
			? "freshness unknown"
			: reference.stale
				? "stale"
				: "current";
	const revision = reference.revision ? `, revision ${reference.revision}` : "";
	const flatCommand = reference.command.replace(/[\r\n]+/g, " ");
	const command = flatCommand.length > 160 ? `${flatCommand.slice(0, 157)}...` : flatCommand;
	return `Verification evidence ${reference.id}: ${reference.outcome} (${freshness}, ${exit}${revision}) \`${command}\``;
}

/**
 * The harness reserves its context title and note-line format on task results. Any id,
 * any number of copies: a model-written copy is never evidence, only the stored
 * observation is. Cleaning runs before share-state and budget decisions, so the
 * reserved format cannot impersonate harness evidence even when sharing is off.
 */
export function isReservedContextItem(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	return (entry as { title?: unknown }).title === VERIFICATION_CONTEXT_TITLE;
}

/** Remove every reserved context item. Anything else is the model's content: keep it. */
export function stripReservedContextItems(context: unknown[]): unknown[] {
	return context.filter((entry) => !isReservedContextItem(entry));
}

/**
 * A reserved note line: the bare prefix at the start of a line, optionally bulleted, or the
 * harness line with its UUID anywhere on a line (numbered, quoted, or inline copies).
 */
const RESERVED_NOTE_LINE =
	/^\s*(?:[-*+]\s+)?Verification evidence(?:\s|:|$)|\bVerification evidence [0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}: /;

/** Remove every reserved note line. Anything else is the model's content: keep it. */
export function stripReservedNoteLines(note: string): string {
	return note
		.split("\n")
		.filter((line) => !RESERVED_NOTE_LINE.test(line))
		.join("\n");
}

function contextFieldBytes(value: unknown): number {
	return typeof value === "string" ? Buffer.byteLength(value, "utf-8") : 0;
}

type ContextBudget = "items" | "field" | "total";

/**
 * Pinned-Bus context budgets violated by a candidate payload: item count, per-field
 * bytes (title/text/URI), and aggregate bytes across title/text/URI/media-type.
 * Mirrors validation.go; kinds and required titles are the model's own problem.
 */
export function violatedContextBudgets(context: unknown[]): Set<ContextBudget> {
	const violated = new Set<ContextBudget>();
	if (context.length > BUS_MAX_CONTEXT_ITEMS) violated.add("items");
	let total = 0;
	for (const entry of context) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const title = contextFieldBytes(record.title);
		const text = contextFieldBytes(record.text);
		const uri = contextFieldBytes(record.uri);
		if (title > BUS_MAX_CONTEXT_TITLE_BYTES || text > BUS_MAX_CONTEXT_TEXT_BYTES || uri > BUS_MAX_CONTEXT_URI_BYTES) {
			violated.add("field");
		}
		total += title + text + uri + contextFieldBytes(record.mediaType);
	}
	if (total > BUS_MAX_CONTEXT_TOTAL_BYTES) violated.add("total");
	return violated;
}

/** "limited" means our reference would break a budget; the caller must tell the user. */
export type VerificationAttachmentResult = "attached" | "not-applicable" | "limited";

/**
 * Attach a shared reference to a Bus task result.
 * Response messages gain a context item. Completed tasks gain a one-line note.
 * Requests are left unchanged.
 *
 * Reserved copies are removed first, whatever id they carry, and the cleaned payload
 * is always written back: even when the reference itself cannot fit, a fabricated
 * line must not survive. The item and note are always derived from the stored
 * record, never trusted from model-written copies: schema validation cannot
 * establish that a written claim matches a process observation.
 */
export function attachVerificationReference(
	toolName: string,
	input: Record<string, unknown>,
	item: VerificationContextItem,
	noteLine: string,
): VerificationAttachmentResult {
	if (toolName === BUS_MESSAGE_PEER_TOOL) {
		const isResult = input.mode === "response" || typeof input.responseTo === "string";
		if (!isResult) return "not-applicable";
		const context = Array.isArray(input.context) ? input.context : [];
		const cleaned = stripReservedContextItems(context);
		const candidate = [...cleaned, item];
		const baseViolated = violatedContextBudgets(cleaned);
		for (const budget of violatedContextBudgets(candidate)) {
			if (!baseViolated.has(budget)) {
				input.context = cleaned;
				return "limited";
			}
		}
		input.context = candidate;
		return "attached";
	}
	if (toolName === BUS_COMPLETE_TASK_TOOL) {
		const note = typeof input.note === "string" ? input.note : "";
		const rest = stripReservedNoteLines(note);
		const next = rest ? `${rest}\n${noteLine}` : noteLine;
		if (Buffer.byteLength(next, "utf-8") > BUS_MAX_NOTE_BYTES) {
			input.note = rest;
			return "limited";
		}
		input.note = next;
		return "attached";
	}
	return "not-applicable";
}

export async function verificationContextItem(
	evidence: VerificationEvidence,
	options?: { shareOutput?: boolean },
): Promise<VerificationContextItem> {
	const reference = await toVerificationReference(evidence, options);
	return {
		kind: "text",
		title: VERIFICATION_CONTEXT_TITLE,
		mediaType: "application/json",
		text: JSON.stringify(reference),
	};
}

function isEvidence(value: unknown): value is VerificationEvidence {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<VerificationEvidence>;
	if (record.version !== 1 || typeof record.id !== "string" || typeof record.command !== "string") {
		return false;
	}
	// The hook reads these; a hand-edited record missing them must not throw mid-call.
	if (!record.code || typeof record.code !== "object") return false;
	if (!record.output || typeof record.output !== "object" || typeof record.output.text !== "string") {
		return false;
	}
	return typeof record.changedDuringRun === "boolean" || record.changedDuringRun === null;
}

/** Effective attachment of one keyed `message_peer` send. Null item means "sent bare". */
export interface VerificationAttachmentRecord {
	version: 1;
	tool: string;
	key: string;
	item: VerificationContextItem | null;
}

function isAttachmentItem(value: unknown): value is VerificationContextItem {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<VerificationContextItem>;
	return (
		record.kind === "text" &&
		typeof record.title === "string" &&
		typeof record.text === "string" &&
		typeof record.mediaType === "string"
	);
}

function isAttachment(value: unknown): value is VerificationAttachmentRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<VerificationAttachmentRecord>;
	return (
		record.version === 1 &&
		typeof record.tool === "string" &&
		typeof record.key === "string" &&
		(record.item === null || isAttachmentItem(record.item))
	);
}

type SessionBranchEntry = { type: string; customType?: string; data?: unknown };

/**
 * The first persisted decision for a keyed send. First wins: the first send is what
 * the Bus may already have accepted, so every retry replays it byte-identically.
 */
export function findKeyedAttachment(
	entries: readonly SessionBranchEntry[],
	tool: string,
	key: string,
): VerificationAttachmentRecord | undefined {
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === VERIFICATION_ATTACHMENT_ENTRY &&
			isAttachment(entry.data) &&
			entry.data.tool === tool &&
			entry.data.key === key
		) {
			return entry.data;
		}
	}
	return undefined;
}

function latestEvidence(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): VerificationEvidence | undefined {
	let evidence: VerificationEvidence | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === VERIFICATION_ENTRY && isEvidence(entry.data)) {
			evidence = entry.data;
		}
	}
	return evidence;
}

function isShare(value: unknown): value is VerificationShareRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<VerificationShareRecord>;
	return record.version === 1 && (typeof record.evidenceId === "string" || record.evidenceId === null);
}

/**
 * The armed evidence, if any. Sharing arms the latest run only: a newer run disarms it, and
 * unsharing clears it. Entries are append-only, so the last share record wins.
 */
function sharedEvidence(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): VerificationEvidence | undefined {
	let share: VerificationShareRecord | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === VERIFICATION_SHARE_ENTRY && isShare(entry.data)) {
			share = entry.data;
		}
	}
	if (!share?.evidenceId) return undefined;
	const latest = latestEvidence(entries);
	return latest?.id === share.evidenceId ? latest : undefined;
}

function formatStatus(evidence: VerificationEvidence, stale: boolean | null, armed: boolean): string {
	const freshness = evidence.changedDuringRun
		? "changed during the run"
		: stale === null
			? "freshness unknown"
			: stale
				? "stale"
				: "current";
	const exit = evidence.exitStatus === null ? "no exit status" : `exit ${evidence.exitStatus}`;
	const lines = [
		`${evidence.outcome} (${freshness}, ${exit})`,
		evidence.command,
		evidence.code.revision
			? `revision ${evidence.code.revision}${evidence.code.dirty ? " dirty" : ""}`
			: "no git revision",
		armed ? "Sharing: armed for later task results" : "Sharing: off",
	];
	if (evidence.error) lines.push(`error: ${evidence.error}`);
	if (evidence.output.text) {
		const tail =
			evidence.output.text.length > STATUS_OUTPUT_CHARS
				? `...${evidence.output.text.slice(-STATUS_OUTPUT_CHARS)}`
				: evidence.output.text;
		lines.push("--- output ---", tail);
	}
	if (evidence.output.truncated) {
		lines.push(evidence.fullOutputPath ? `Full output: ${evidence.fullOutputPath}` : "Output was truncated.");
	}
	lines.push("Output stays local. /verify share previews it for a peer reference.");
	return lines.join("\n");
}

const VERIFY_SUBCOMMANDS = ["status", "share", "unshare", "run"];

/** Record explicitly selected commands. The outcome is the observed process result. */
export function registerVerificationEvidence(pi: ExtensionAPI): void {
	pi.registerCommand("verify", {
		description: "Run a verification command and record its observed result",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			const trimmed = prefix.trim();
			return VERIFY_SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(trimmed)).map((subcommand) => ({
				value: subcommand,
				label: subcommand,
			}));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const entries = ctx.sessionManager.getBranch();
			if (!trimmed || trimmed === "status") {
				const evidence = latestEvidence(entries);
				if (!evidence) {
					ctx.ui.notify("No verification evidence yet. Use /verify run <command>.", "info");
					return;
				}
				const armed = sharedEvidence(entries)?.id === evidence.id;
				ctx.ui.notify(formatStatus(evidence, await verificationStale(evidence), armed), "info");
				return;
			}
			if (trimmed === "share") {
				const evidence = latestEvidence(entries);
				if (!evidence) {
					ctx.ui.notify("No verification evidence to share.", "warning");
					return;
				}
				const item = await verificationContextItem(evidence, { shareOutput: true });
				pi.appendEntry(VERIFICATION_SHARE_ENTRY, {
					version: 1,
					evidenceId: evidence.id,
				} satisfies VerificationShareRecord);
				ctx.ui.notify(
					`Peer reference:\n${item.text}\nTask notes are visible to every agent in the task scope.`,
					"info",
				);
				return;
			}
			if (trimmed === "unshare") {
				pi.appendEntry(VERIFICATION_SHARE_ENTRY, {
					version: 1,
					evidenceId: null,
				} satisfies VerificationShareRecord);
				ctx.ui.notify("Verification sharing is off.", "info");
				return;
			}
			if (!trimmed.startsWith("run ")) {
				ctx.ui.notify("Usage: /verify status | /verify share | /verify unshare | /verify run <command>", "warning");
				return;
			}
			const command = trimmed.slice(4).trim();
			if (!command) {
				ctx.ui.notify("Usage: /verify run <command>", "warning");
				return;
			}
			ctx.ui.notify(`Running verification: ${command}`, "info");
			const evidence = await runVerification({
				command,
				cwd: ctx.cwd,
				runner: (runCommand) => pi.execBash(runCommand),
				signal: ctx.signal,
			});
			pi.appendEntry(VERIFICATION_ENTRY, evidence);
			// A new run disarms any previous share: sharing always arms the latest run only.
			ctx.ui.notify(
				formatStatus(evidence, await verificationStale(evidence), false),
				evidence.outcome === "success" ? "info" : "warning",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== BUS_MESSAGE_PEER_TOOL && event.toolName !== BUS_COMPLETE_TASK_TOOL) return undefined;
		const input = event.input as Record<string, unknown>;
		const entries = ctx.sessionManager.getBranch();
		if (event.toolName === BUS_MESSAGE_PEER_TOOL) {
			// Requests are the model's own content and stay byte-identical: the harness
			// only ever attaches to results, so a reserved title on a request cannot
			// impersonate harness evidence.
			const isResult = input.mode === "response" || typeof input.responseTo === "string";
			if (!isResult) return undefined;
			const rawKey = input.idempotencyKey;
			const key = typeof rawKey === "string" && rawKey ? rawKey : undefined;
			// A persisted decision replays before current sharing is consulted: the
			// Bus hashes the whole context and rejects same-key content changes.
			const replay = key ? findKeyedAttachment(entries, event.toolName, key) : undefined;
			if (replay) {
				// A bare replay must not add a context field the first send lacked:
				// the Bus hashes the whole context, so `[]` and missing differ.
				if (!Array.isArray(input.context)) {
					if (replay.item) input.context = [replay.item];
					return undefined;
				}
				const cleaned = stripReservedContextItems(input.context);
				input.context = replay.item ? [...cleaned, replay.item] : cleaned;
				return undefined;
			}
			const evidence = sharedEvidence(entries);
			if (!evidence) {
				// Unarmed: reservation still holds, and a keyed bare send is
				// recorded so a later share cannot corrupt its retry.
				if (Array.isArray(input.context)) input.context = stripReservedContextItems(input.context);
				if (key) {
					pi.appendEntry(VERIFICATION_ATTACHMENT_ENTRY, {
						version: 1,
						tool: event.toolName,
						key,
						item: null,
					} satisfies VerificationAttachmentRecord);
				}
				return undefined;
			}
			const item = await verificationContextItem(evidence, { shareOutput: true });
			const attached = attachVerificationReference(event.toolName, input, item, "");
			if (key) {
				pi.appendEntry(VERIFICATION_ATTACHMENT_ENTRY, {
					version: 1,
					tool: event.toolName,
					key,
					item: attached === "attached" ? item : null,
				} satisfies VerificationAttachmentRecord);
			}
			if (attached === "limited") {
				ctx.ui.notify(
					"Verification evidence was not attached: the message context or task note is at its Bus size limit.",
					"warning",
				);
			}
			return undefined;
		}
		// `complete_task` has no idempotency key in the pinned Bus input, so every
		// completion is evaluated fresh. Reserved lines are still always cleaned.
		const evidence = sharedEvidence(entries);
		if (!evidence) {
			if (typeof input.note === "string") input.note = stripReservedNoteLines(input.note);
			return undefined;
		}
		const reference = await toVerificationReference(evidence, { shareOutput: true });
		const attached = attachVerificationReference(
			event.toolName,
			input,
			{
				kind: "text",
				title: VERIFICATION_CONTEXT_TITLE,
				mediaType: "application/json",
				text: JSON.stringify(reference),
			},
			verificationResultLine(reference),
		);
		if (attached === "limited") {
			ctx.ui.notify(
				"Verification evidence was not attached: the message context or task note is at its Bus size limit.",
				"warning",
			);
		}
		return undefined;
	});
}
