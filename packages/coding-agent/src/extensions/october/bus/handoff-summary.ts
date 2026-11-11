/**
 * Structured `/handoff` payload (issue #43). Pure: no session, Bus, or model access.
 *
 * Each field is either `observed` (taken from a tool result) or `authored` (typed by the
 * sender or written by the agent). The sender reviews the serialized text before it is sent.
 */

export const HANDOFF_SUMMARY_VERSION = 1;
export const HANDOFF_SUMMARY_MAX_CHARS = 16_000;
/** Title of the message context item that carries the serialized summary. */
export const HANDOFF_SUMMARY_CONTEXT_TITLE = "October handoff summary";

export type HandoffSource = "observed" | "authored";
export type HandoffCheckStatus = "passed" | "failed" | "unknown";
export type HandoffOmissionSection = "decisions" | "checks" | "changedFiles";

export interface HandoffRef {
	messageId?: string;
	toolCallId?: string;
}

export interface HandoffText {
	text: string;
	source: HandoffSource;
	ref?: HandoffRef;
}

export interface HandoffChangedFile {
	path: string;
	source: HandoffSource;
	ref?: HandoffRef;
}

export interface HandoffCheck {
	command: string;
	status: HandoffCheckStatus;
	exitCode?: number;
	source: HandoffSource;
	ref?: HandoffRef;
}

/** Disclosure of content dropped to fit the size limit. */
export interface HandoffOmission {
	section: HandoffOmissionSection;
	count: number;
	reason: "size limit";
}

export interface HandoffSummary {
	version: typeof HANDOFF_SUMMARY_VERSION;
	/** False when the branch begins after a compaction, so earlier history is only in the compaction summary. */
	historyComplete: boolean;
	objective: HandoffText;
	constraints: HandoffText[];
	decisions: HandoffText[];
	changedFiles: HandoffChangedFile[];
	checks: HandoffCheck[];
	remainingWork: HandoffText[];
	omitted: HandoffOmission[];
}

/** Session records the builder reads. The `/handoff` adapter converts session entries into these. */
export type HandoffHistoryRecord =
	| { kind: "user"; messageId: string; text: string }
	| { kind: "assistant"; messageId: string; text: string }
	| { kind: "toolCall"; toolCallId: string; name: string; path?: string; command?: string }
	| { kind: "toolResult"; toolCallId: string; isError: boolean; exitCode?: number }
	| { kind: "compaction" };

export interface HandoffSenderInput {
	objective: string;
	constraints: string[];
	remainingWork: string[];
	history: HandoffHistoryRecord[];
}

export type HandoffParseResult = { ok: true; summary: HandoffSummary } | { ok: false; error: string };

/** An assistant line starting with "Decision" and a colon marks a decision, e.g. "Decision: keep /delegate". */
const DECISION_LINE = /^\s*Decision\b[^:\n]*:/i;
/** Bash commands that look like a test or check run. Other commands are not reported. */
const CHECK_COMMAND = /\b(vitest|jest|test|check|lint|tsc|typecheck|biome)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(summary: HandoffSummary): string {
	return JSON.stringify(summary, null, 2);
}

/** Keeps the summary under `limit` characters by dropping the oldest droppable items first. Sender text is never dropped. */
function fitToLimit(summary: HandoffSummary, limit: number): HandoffSummary {
	const current: HandoffSummary = {
		...summary,
		decisions: [...summary.decisions],
		checks: [...summary.checks],
		changedFiles: [...summary.changedFiles],
	};
	const dropped: Record<HandoffOmissionSection, number> = { decisions: 0, checks: 0, changedFiles: 0 };
	for (;;) {
		const omitted: HandoffOmission[] = [];
		for (const section of ["decisions", "checks", "changedFiles"] as const) {
			if (dropped[section] > 0) omitted.push({ section, count: dropped[section], reason: "size limit" });
		}
		const candidate: HandoffSummary = { ...current, omitted };
		const size = serialize(candidate).length;
		if (size <= limit) return candidate;
		if (current.decisions.length > 0) {
			current.decisions.shift();
			dropped.decisions++;
		} else if (current.checks.length > 0) {
			current.checks.shift();
			dropped.checks++;
		} else if (current.changedFiles.length > 0) {
			current.changedFiles.shift();
			dropped.changedFiles++;
		} else {
			throw new Error(
				`Handoff summary exceeds the ${limit} character limit (${size} characters). Shorten the objective, constraints, or remaining work.`,
			);
		}
	}
}

export function buildHandoffSummary(
	input: HandoffSenderInput,
	limit: number = HANDOFF_SUMMARY_MAX_CHARS,
): HandoffSummary {
	const results = new Map<string, { isError: boolean; exitCode?: number }>();
	for (const record of input.history) {
		if (record.kind === "toolResult") {
			results.set(record.toolCallId, { isError: record.isError, exitCode: record.exitCode });
		}
	}

	const decisions: HandoffText[] = [];
	const changedFiles: HandoffChangedFile[] = [];
	const checks: HandoffCheck[] = [];
	for (const record of input.history) {
		if (record.kind === "assistant") {
			for (const line of record.text.split("\n")) {
				if (DECISION_LINE.test(line)) {
					decisions.push({ text: line.trim(), source: "authored", ref: { messageId: record.messageId } });
				}
			}
		} else if (record.kind === "toolCall") {
			const result = results.get(record.toolCallId);
			const ref: HandoffRef = { toolCallId: record.toolCallId };
			if ((record.name === "edit" || record.name === "write") && record.path !== undefined) {
				if (result && !result.isError) changedFiles.push({ path: record.path, source: "observed", ref });
			} else if (record.name === "bash" && record.command !== undefined && CHECK_COMMAND.test(record.command)) {
				const status: HandoffCheckStatus = !result ? "unknown" : result.isError ? "failed" : "passed";
				checks.push({ command: record.command, status, exitCode: result?.exitCode, source: "observed", ref });
			}
		}
	}

	return fitToLimit(
		{
			version: HANDOFF_SUMMARY_VERSION,
			historyComplete: !input.history.some((record) => record.kind === "compaction"),
			objective: { text: input.objective, source: "authored" },
			constraints: input.constraints.map((text) => ({ text, source: "authored" })),
			decisions,
			changedFiles,
			checks,
			remainingWork: input.remainingWork.map((text) => ({ text, source: "authored" })),
			omitted: [],
		},
		limit,
	);
}

export function serializeHandoffSummary(summary: HandoffSummary): string {
	return serialize(summary);
}

// Validation below runs on wire input and on sender edits, so it is the trust boundary.
// Throwing keeps each check to one line; parseHandoffSummary turns the throw into a result.

function fail(reason: string): never {
	throw new Error(reason);
}

function readString(value: unknown, field: string): string {
	if (typeof value !== "string") fail(`${field} must be a string`);
	return value;
}

function readSource(value: unknown): HandoffSource {
	if (value === "observed" || value === "authored") return value;
	return fail("source must be observed or authored");
}

function readRef(value: unknown): HandoffRef | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) fail("ref must be an object");
	const ref: HandoffRef = {};
	if (value.messageId !== undefined) ref.messageId = readString(value.messageId, "ref.messageId");
	if (value.toolCallId !== undefined) ref.toolCallId = readString(value.toolCallId, "ref.toolCallId");
	return ref;
}

function readArray<T>(value: unknown, field: string, read: (item: unknown, field: string) => T): T[] {
	if (!Array.isArray(value)) fail(`${field} must be an array`);
	return value.map((item) => read(item, field));
}

function readText(value: unknown, field: string): HandoffText {
	if (!isRecord(value)) fail(`${field} item must be an object`);
	return {
		text: readString(value.text, field),
		source: readSource(value.source),
		ref: readRef(value.ref),
	};
}

function readChangedFile(value: unknown, field: string): HandoffChangedFile {
	if (!isRecord(value)) fail(`${field} item must be an object`);
	return {
		path: readString(value.path, `${field}.path`),
		source: readSource(value.source),
		ref: readRef(value.ref),
	};
}

function readCheck(value: unknown, field: string): HandoffCheck {
	if (!isRecord(value)) fail(`${field} item must be an object`);
	const status = value.status;
	if (status !== "passed" && status !== "failed" && status !== "unknown") fail("check status is invalid");
	if (value.exitCode !== undefined && typeof value.exitCode !== "number") fail("check exitCode must be a number");
	return {
		command: readString(value.command, `${field}.command`),
		status,
		exitCode: value.exitCode,
		source: readSource(value.source),
		ref: readRef(value.ref),
	};
}

function readOmission(value: unknown, field: string): HandoffOmission {
	if (!isRecord(value)) fail(`${field} item must be an object`);
	const section = value.section;
	if (section !== "decisions" && section !== "checks" && section !== "changedFiles")
		fail("omitted section is invalid");
	if (typeof value.count !== "number") fail("omitted count must be a number");
	if (value.reason !== "size limit") fail("omitted reason is invalid");
	return { section, count: value.count, reason: "size limit" };
}

function readSummary(value: Record<string, unknown>): HandoffSummary {
	if (typeof value.historyComplete !== "boolean") fail("historyComplete must be a boolean");
	return {
		version: HANDOFF_SUMMARY_VERSION,
		historyComplete: value.historyComplete,
		objective: readText(value.objective, "objective"),
		constraints: readArray(value.constraints, "constraints", readText),
		decisions: readArray(value.decisions, "decisions", readText),
		changedFiles: readArray(value.changedFiles, "changedFiles", readChangedFile),
		checks: readArray(value.checks, "checks", readCheck),
		remainingWork: readArray(value.remainingWork, "remainingWork", readText),
		omitted: readArray(value.omitted, "omitted", readOmission),
	};
}

export function parseHandoffSummary(text: string): HandoffParseResult {
	try {
		if (text.length > HANDOFF_SUMMARY_MAX_CHARS) {
			fail(`Handoff summary exceeds the ${HANDOFF_SUMMARY_MAX_CHARS} character limit (${text.length} characters).`);
		}
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) fail("payload is not a JSON object");
		if (value.version !== HANDOFF_SUMMARY_VERSION)
			fail(`unsupported handoff summary version ${String(value.version)}`);
		return { ok: true, summary: readSummary(value) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
