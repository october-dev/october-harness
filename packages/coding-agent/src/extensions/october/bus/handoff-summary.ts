/**
 * Structured `/handoff` payload (issue #43). Pure: no session, Bus, or model access.
 *
 * Each field is either `observed` (taken from a tool result) or `authored` (typed by the
 * sender or written by the agent). The sender reviews the serialized text before it is sent.
 */

import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const HANDOFF_SUMMARY_VERSION = 1;
export const HANDOFF_SUMMARY_MAX_CHARS = 16_000;
/** Title of the message context item that carries the serialized summary. */
export const HANDOFF_SUMMARY_CONTEXT_TITLE = "October handoff summary";

const strict = { additionalProperties: false } as const;
const source = Type.Union([Type.Literal("observed"), Type.Literal("authored")]);
const ref = Type.Optional(
	Type.Object(
		{
			messageId: Type.Optional(Type.String()),
			toolCallId: Type.Optional(Type.String()),
		},
		strict,
	),
);
const textItem = Type.Object({ text: Type.String(), source, ref }, strict);
const fileItem = Type.Object({ path: Type.String(), source, ref }, strict);
const checkItem = Type.Object(
	{
		command: Type.String(),
		status: Type.Union([
			Type.Literal("passed"),
			Type.Literal("failed"),
			Type.Literal("unknown"),
			Type.Literal("blocked"),
			Type.Literal("interrupted"),
		]),
		exitCode: Type.Optional(Type.Integer()),
		source,
		ref,
	},
	strict,
);
const sections = ["constraints", "decisions", "remainingWork", "checks", "changedFiles"] as const;
type Section = (typeof sections)[number];
const summarySchema = Type.Object(
	{
		version: Type.Literal(HANDOFF_SUMMARY_VERSION),
		historyComplete: Type.Boolean(),
		objective: Type.Object({ text: Type.String({ minLength: 1, pattern: "\\S" }), source, ref }, strict),
		constraints: Type.Array(textItem),
		decisions: Type.Array(textItem),
		changedFiles: Type.Array(fileItem),
		checks: Type.Array(checkItem),
		remainingWork: Type.Array(textItem),
		omitted: Type.Array(
			Type.Object(
				{
					section: Type.Enum(sections),
					count: Type.Integer({ minimum: 1 }),
					reason: Type.Literal("size limit"),
				},
				strict,
			),
		),
	},
	strict,
);
export type HandoffSummary = Static<typeof summarySchema>;
type CheckStatus = HandoffSummary["checks"][number]["status"];

/** Session records the builder reads. The `/handoff` adapter converts session entries into these. */
export type HandoffHistoryRecord =
	| { kind: "user"; messageId: string; text: string }
	| { kind: "assistant"; messageId: string; text: string }
	| { kind: "toolCall"; toolCallId: string; name: string; path?: string; command?: string }
	| {
			kind: "toolResult";
			toolCallId: string;
			isError: boolean;
			exitCode?: number;
			interruption?: "blocked" | "interrupted";
	  }
	| { kind: "compaction" }
	| { kind: "branchSummary"; messageId: string; text: string };

export interface HandoffSenderInput {
	objective: string;
	constraints: string[];
	remainingWork: string[];
	history: HandoffHistoryRecord[];
}

export type HandoffParseResult = { ok: true; summary: HandoffSummary } | { ok: false; error: string };

/** Recognizes conventional check commands, including npm scripts. Unknown shell operations are omitted. */
const CHECK_COMMAND = /\b(vitest|jest|test|check|lint|tsc|typecheck|biome)\b/i;
const NEXT_WORK = /\b(still need|next step|remaining|todo|to do|need to|will need|left to|next we|then we)\b/i;

export function serializeHandoffSummary(summary: HandoffSummary): string {
	return JSON.stringify(summary, null, 2);
}

/** Remove oldest historical items from the largest section. Explicit sender input stays in the draft. */
function fitToLimit(summary: HandoffSummary, limit: number): HandoffSummary {
	const skipped = new Map<Section, number>();
	while (serializeHandoffSummary(summary).length > limit) {
		let largest: Section | undefined;
		let largestCount = 0;
		for (const section of sections) {
			const count = summary[section].filter((item) => item.ref !== undefined).length;
			if (count > largestCount) {
				largest = section;
				largestCount = count;
			}
		}
		if (!largest) throw new Error(`Handoff summary exceeds the ${limit} character limit. Shorten sender input.`);
		summary[largest].splice(
			summary[largest].findIndex((item) => item.ref !== undefined),
			1,
		);
		skipped.set(largest, (skipped.get(largest) ?? 0) + 1);
		summary.omitted = [...skipped].map(([section, count]) => ({ section, count, reason: "size limit" }));
	}
	return summary;
}

export function buildHandoffSummary(
	input: HandoffSenderInput,
	limit: number = HANDOFF_SUMMARY_MAX_CHARS,
): HandoffSummary {
	const results = new Map<string, Extract<HandoffHistoryRecord, { kind: "toolResult" }>>();
	for (const record of input.history) if (record.kind === "toolResult") results.set(record.toolCallId, record);
	const files = new Map<string, HandoffSummary["changedFiles"][number]>();
	const checks = new Map<string, Map<CheckStatus, HandoffSummary["checks"][number]>>();
	const summary: HandoffSummary = {
		version: HANDOFF_SUMMARY_VERSION,
		historyComplete: true,
		objective: { text: input.objective, source: "authored" },
		constraints: input.constraints.map((text) => ({ text, source: "authored" })),
		decisions: [],
		remainingWork: input.remainingWork.map((text) => ({ text, source: "authored" })),
		checks: [],
		changedFiles: [],
		omitted: [],
	};
	for (const record of input.history) {
		if (record.kind === "assistant" || record.kind === "user" || record.kind === "branchSummary") {
			if (record.kind === "branchSummary") summary.historyComplete = false;
			for (const line of record.text.split("\n")) {
				const text = line.trim();
				if (!text) continue;
				const section = NEXT_WORK.test(text)
					? "remainingWork"
					: record.kind === "user"
						? "constraints"
						: "decisions";
				summary[section].push({ text, source: "authored", ref: { messageId: record.messageId } });
			}
		} else if (record.kind === "toolCall") {
			const result = results.get(record.toolCallId);
			const ref = { toolCallId: record.toolCallId };
			if ((record.name === "edit" || record.name === "write") && record.path && result && !result.isError) {
				files.delete(record.path);
				files.set(record.path, { path: record.path, source: "observed", ref });
			} else if (record.name === "bash" && record.command && CHECK_COMMAND.test(record.command)) {
				const status =
					result?.interruption ??
					(!result
						? "unknown"
						: !result.isError
							? "passed"
							: result.exitCode !== undefined
								? "failed"
								: "unknown");
				const outcomes = checks.get(record.command) ?? new Map<CheckStatus, HandoffSummary["checks"][number]>();
				outcomes.set(status, {
					command: record.command,
					status,
					exitCode: result?.exitCode,
					source: "observed",
					ref,
				});
				checks.set(record.command, outcomes);
			}
		}
	}
	summary.changedFiles = [...files.values()];
	summary.checks = [...checks.values()].flatMap((outcomes) => [...outcomes.values()]);
	return fitToLimit(summary, limit);
}

export function parseHandoffSummary(text: string): HandoffParseResult {
	try {
		const value: unknown = JSON.parse(text);
		if (!Check(summarySchema, value)) {
			const issue = Errors(summarySchema, value)[0];
			return {
				ok: false,
				error: `${issue?.instancePath || "/"}: ${issue?.message ?? "Invalid handoff summary"} ${JSON.stringify(issue?.params ?? {})}`,
			};
		}
		const size = serializeHandoffSummary(value).length;
		if (size > HANDOFF_SUMMARY_MAX_CHARS)
			return {
				ok: false,
				error: `Handoff summary exceeds the ${HANDOFF_SUMMARY_MAX_CHARS} character limit (${size} characters).`,
			};
		return { ok: true, summary: value };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
