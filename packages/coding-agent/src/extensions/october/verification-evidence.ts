import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execCommand } from "../../core/exec.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/** Session record of one explicitly run verification command. Output stays in this record. */
export const VERIFICATION_ENTRY = "october-verification-evidence";
/** Session record that the user explicitly shared an evidence id with peers. */
export const VERIFICATION_SHARE_ENTRY = "october-verification-share";
export const VERIFICATION_CONTEXT_TITLE = "Verification evidence";
/** Public Bus tools whose task results can carry a verification reference. */
export const BUS_MESSAGE_PEER_TOOL = "mcp__october-bus__message_peer";
export const BUS_COMPLETE_TASK_TOOL = "mcp__october-bus__complete_task";

const DEFAULT_MAX_OUTPUT_BYTES = 8_192;
const SHARE_PREVIEW_CHARS = 240;
const MAX_DIRTY_FILES = 100;

export type VerificationOutcome = "success" | "failed" | "cancelled" | "unknown";

export interface DirtyFileIdentity {
	path: string;
	/** Null when the path was missing while hashing, such as a deletion. */
	sha256: string | null;
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
	code: CodeIdentity;
	output: { text: string; truncated: boolean };
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
	/** Null when this workspace cannot be compared to the recorded identity. */
	stale: boolean | null;
	outputPreview?: string;
}

export interface RunVerificationOptions {
	command: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
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
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Porcelain v1 -z paths, using the destination path for renames and copies. */
export function parseGitStatusPaths(raw: string): string[] {
	const parts = raw.split("\0").filter((part) => part.length > 0);
	const paths: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const filePath = entry.slice(3);
		if (status.includes("R") || status.includes("C")) {
			const destination = parts[++index];
			if (destination) paths.push(destination);
		} else if (filePath) {
			paths.push(filePath);
		}
	}
	return paths;
}

async function captureCodeIdentity(cwd: string): Promise<CodeIdentity> {
	let head: Awaited<ReturnType<typeof execCommand>>;
	try {
		head = await execCommand("git", ["rev-parse", "HEAD"], cwd, { timeout: 5_000 });
	} catch {
		return EMPTY_IDENTITY;
	}
	if (head.code !== 0) return EMPTY_IDENTITY;
	const revision = head.stdout.trim();
	if (!revision) return EMPTY_IDENTITY;
	let status: Awaited<ReturnType<typeof execCommand>>;
	try {
		status = await execCommand("git", ["status", "--porcelain=v1", "-z"], cwd, { timeout: 5_000 });
	} catch {
		return { ...EMPTY_IDENTITY, revision };
	}
	if (status.code !== 0) return { ...EMPTY_IDENTITY, revision };
	const dirtyPaths = [...new Set(parseGitStatusPaths(status.stdout))].sort();
	const limited = dirtyPaths.slice(0, MAX_DIRTY_FILES);
	const files: DirtyFileIdentity[] = [];
	for (const filePath of limited) {
		const absolute = path.resolve(cwd, filePath);
		if (!isInside(cwd, absolute)) continue;
		let sha256: string | null = null;
		try {
			sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
		} catch {
			sha256 = null;
		}
		files.push({ path: filePath.split(path.sep).join("/"), sha256 });
	}
	return {
		available: true,
		revision,
		dirty: dirtyPaths.length > 0,
		files,
		filesTruncated: dirtyPaths.length > MAX_DIRTY_FILES,
	};
}

export function isCodeIdentityStale(recorded: CodeIdentity, current: CodeIdentity): boolean | null {
	if (!recorded.available || !current.available) return null;
	if (recorded.filesTruncated || current.filesTruncated) return true;
	if (recorded.revision !== current.revision || recorded.dirty !== current.dirty) return true;
	if (recorded.files.length !== current.files.length) return true;
	for (let index = 0; index < recorded.files.length; index++) {
		const previous = recorded.files[index];
		const next = current.files[index];
		if (previous.path !== next.path || previous.sha256 !== next.sha256) return true;
	}
	return false;
}

/**
 * The process observation wins. A written claim such as "tests passed" cannot create a success.
 * With no evidence record, the outcome is unknown.
 */
export function reportedVerificationOutcome(
	_summary: string,
	evidence: VerificationEvidence | undefined,
): VerificationOutcome {
	return evidence?.outcome ?? "unknown";
}

export async function runVerification(options: RunVerificationOptions): Promise<VerificationEvidence> {
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const command = options.command;
	const cwd = options.cwd;
	const finish = (
		outcome: VerificationOutcome,
		exitStatus: number | null,
		code: CodeIdentity,
		output: { text: string; truncated: boolean },
	): VerificationEvidence => ({
		version: 1,
		id: randomUUID(),
		command,
		cwd,
		startedAt,
		endedAt: now().toISOString(),
		outcome,
		exitStatus,
		code,
		output,
	});

	if (options.signal?.aborted) {
		return finish("cancelled", null, EMPTY_IDENTITY, { text: "", truncated: false });
	}
	if (!command.trim()) {
		return finish("unknown", null, EMPTY_IDENTITY, { text: "", truncated: false });
	}

	const shell = process.platform === "win32" ? "cmd.exe" : "sh";
	const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
	let result: Awaited<ReturnType<typeof execCommand>>;
	try {
		result = await execCommand(shell, shellArgs, cwd, {
			signal: options.signal,
			timeout: options.timeoutMs,
			maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		});
	} catch {
		return finish("unknown", null, await captureCodeIdentity(cwd), { text: "", truncated: false });
	}

	const text = [result.stdout, result.stderr]
		.filter((part) => part.length > 0)
		.join(result.stdout && result.stderr ? "\n" : "");
	const code = await captureCodeIdentity(cwd);
	const cancelled = options.signal?.aborted === true || (result.killed && !result.truncated);
	if (cancelled) {
		const exitStatus = result.killed && result.code === 0 ? null : result.code;
		return finish("cancelled", exitStatus, code, { text, truncated: result.truncated });
	}
	if (result.truncated || result.code !== 0) {
		return finish("failed", result.code, code, { text, truncated: result.truncated });
	}
	return finish("success", 0, code, { text, truncated: false });
}

export async function verificationStale(evidence: VerificationEvidence): Promise<boolean | null> {
	return isCodeIdentityStale(evidence.code, await captureCodeIdentity(evidence.cwd));
}

export async function toVerificationReference(
	evidence: VerificationEvidence,
	options?: { shareOutput?: boolean },
): Promise<VerificationReference> {
	const reference: VerificationReference = {
		version: 1,
		id: evidence.id,
		command: evidence.command,
		cwd: evidence.cwd,
		startedAt: evidence.startedAt,
		endedAt: evidence.endedAt,
		outcome: evidence.outcome,
		exitStatus: evidence.exitStatus,
		revision: evidence.code.revision,
		dirty: evidence.code.dirty,
		stale: await verificationStale(evidence),
	};
	if (options?.shareOutput && evidence.output.text) {
		reference.outputPreview = evidence.output.text.slice(0, SHARE_PREVIEW_CHARS);
	}
	return reference;
}

interface VerificationShareRecord {
	version: 1;
	evidenceId: string;
}

/** One line for a task note. It names the check and omits command output. */
export function verificationResultLine(reference: VerificationReference): string {
	const exit = reference.exitStatus === null ? "no exit status" : `exit ${reference.exitStatus}`;
	const freshness = reference.stale === null ? "freshness unknown" : reference.stale ? "stale" : "current";
	const revision = reference.revision ? `, revision ${reference.revision}` : "";
	const command = reference.command.length > 160 ? `${reference.command.slice(0, 157)}...` : reference.command;
	return `Verification evidence ${reference.id}: ${reference.outcome} (${freshness}, ${exit}${revision}) \`${command}\``;
}

function contextHasEvidence(context: unknown[], evidenceId: string): boolean {
	for (const entry of context) {
		if (!entry || typeof entry !== "object") continue;
		const text = (entry as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && (parsed as { id?: unknown }).id === evidenceId) return true;
		} catch {
			// Unrelated context text.
		}
	}
	return false;
}

/**
 * Attach a shared reference to a Bus task result.
 * Response messages gain a context item. Completed tasks gain a one-line note.
 * Requests are left unchanged. Returns false when nothing was added.
 */
export function attachVerificationReference(
	toolName: string,
	input: Record<string, unknown>,
	item: { kind: "text"; title: string; text: string; mediaType: string },
	evidenceId: string,
	noteLine: string,
): boolean {
	if (toolName === BUS_MESSAGE_PEER_TOOL || toolName === "message_peer") {
		const isResult = input.mode === "response" || typeof input.responseTo === "string";
		if (!isResult) return false;
		const context = Array.isArray(input.context) ? input.context : [];
		if (contextHasEvidence(context, evidenceId)) return false;
		input.context = [...context, item];
		return true;
	}
	if (toolName === BUS_COMPLETE_TASK_TOOL || toolName === "complete_task") {
		const note = typeof input.note === "string" ? input.note : "";
		if (note.includes(`Verification evidence ${evidenceId}:`)) return false;
		input.note = note ? `${note}\n${noteLine}` : noteLine;
		return true;
	}
	return false;
}

/** Bus context item carrying the reference, not the local output, unless a preview was requested. */
export async function verificationContextItem(
	evidence: VerificationEvidence,
	options?: { shareOutput?: boolean },
): Promise<{ kind: "text"; title: string; text: string; mediaType: string }> {
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
	return record.version === 1 && typeof record.id === "string" && typeof record.command === "string";
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
	return (
		!!value &&
		typeof value === "object" &&
		(value as VerificationShareRecord).version === 1 &&
		typeof (value as VerificationShareRecord).evidenceId === "string"
	);
}

function sharedEvidence(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): VerificationEvidence | undefined {
	let evidenceId: string | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === VERIFICATION_SHARE_ENTRY && isShare(entry.data)) {
			evidenceId = entry.data.evidenceId;
		}
	}
	if (!evidenceId) return undefined;
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === VERIFICATION_ENTRY &&
			isEvidence(entry.data) &&
			entry.data.id === evidenceId
		) {
			return entry.data;
		}
	}
	return undefined;
}

function formatStatus(evidence: VerificationEvidence, stale: boolean | null): string {
	const freshness = stale === null ? "freshness unknown" : stale ? "stale" : "current";
	const exit = evidence.exitStatus === null ? "no exit status" : `exit ${evidence.exitStatus}`;
	return [
		`${evidence.outcome} (${freshness}, ${exit})`,
		evidence.command,
		evidence.code.revision
			? `revision ${evidence.code.revision}${evidence.code.dirty ? " dirty" : ""}`
			: "no git revision",
		"Output stays local. /verify share previews it for a peer reference.",
	].join("\n");
}

/** Record explicitly selected commands. The outcome is the observed process result. */
export function registerVerificationEvidence(pi: ExtensionAPI): void {
	pi.registerCommand("verify", {
		description: "Run a verification command and record its observed result",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const entries = ctx.sessionManager.getBranch();
			if (!trimmed || trimmed === "status") {
				const evidence = latestEvidence(entries);
				if (!evidence) {
					ctx.ui.notify("No verification evidence yet. Use /verify run <command>.", "info");
					return;
				}
				ctx.ui.notify(formatStatus(evidence, await verificationStale(evidence)), "info");
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
				ctx.ui.notify(`Peer reference:\n${item.text}`, "info");
				return;
			}
			if (!trimmed.startsWith("run ")) {
				ctx.ui.notify("Usage: /verify status | /verify share | /verify run <command>", "warning");
				return;
			}
			const command = trimmed.slice(4).trim();
			if (!command) {
				ctx.ui.notify("Usage: /verify run <command>", "warning");
				return;
			}
			const evidence = await runVerification({
				command,
				cwd: ctx.cwd,
				signal: ctx.signal,
				timeoutMs: 60_000,
			});
			pi.appendEntry(VERIFICATION_ENTRY, evidence);
			ctx.ui.notify(
				formatStatus(evidence, await verificationStale(evidence)),
				evidence.outcome === "success" ? "info" : "warning",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== BUS_MESSAGE_PEER_TOOL && event.toolName !== BUS_COMPLETE_TASK_TOOL) return undefined;
		const evidence = sharedEvidence(ctx.sessionManager.getBranch());
		if (!evidence || !event.input || typeof event.input !== "object") return undefined;
		const item = await verificationContextItem(evidence, { shareOutput: true });
		const reference = JSON.parse(item.text) as VerificationReference;
		attachVerificationReference(
			event.toolName,
			event.input as Record<string, unknown>,
			item,
			evidence.id,
			verificationResultLine(reference),
		);
		return undefined;
	});
}
