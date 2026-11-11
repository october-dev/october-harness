// Issue #43: structured /handoff summary.
import { describe, expect, it } from "vitest";
import {
	buildHandoffSummary,
	HANDOFF_SUMMARY_MAX_CHARS,
	HANDOFF_SUMMARY_VERSION,
	type HandoffHistoryRecord,
	type HandoffSummary,
	parseHandoffSummary,
	serializeHandoffSummary,
} from "../src/extensions/october/bus/handoff-summary.ts";

const objective = "Finish the Bus handoff";

function build(history: HandoffHistoryRecord[], limit?: number): HandoffSummary {
	return buildHandoffSummary(
		{ objective, constraints: ["No new dependencies"], remainingWork: ["Wire the UI"], history },
		limit,
	);
}

describe("buildHandoffSummary (#43)", () => {
	it("separates observed facts from agent-authored decisions and keeps source references", () => {
		const summary = build([
			{ kind: "user", messageId: "m1", text: "use the existing Bus" },
			{ kind: "assistant", messageId: "m2", text: "Decision: keep /delegate unchanged" },
			{ kind: "toolCall", toolCallId: "t1", name: "edit", path: "src/a.ts" },
			{ kind: "toolResult", toolCallId: "t1", isError: false },
			{ kind: "toolCall", toolCallId: "t2", name: "bash", command: "npx vitest --run test/a.test.ts" },
			{ kind: "toolResult", toolCallId: "t2", isError: false, exitCode: 0 },
		]);

		expect(summary.version).toBe(HANDOFF_SUMMARY_VERSION);
		expect(summary.historyComplete).toBe(true);
		expect(summary.objective).toEqual({ text: objective, source: "authored" });
		expect(summary.decisions).toEqual([
			{ text: "Decision: keep /delegate unchanged", source: "authored", ref: { messageId: "m2" } },
		]);
		expect(summary.changedFiles).toEqual([{ path: "src/a.ts", source: "observed", ref: { toolCallId: "t1" } }]);
		expect(summary.checks).toEqual([
			{
				command: "npx vitest --run test/a.test.ts",
				status: "passed",
				exitCode: 0,
				source: "observed",
				ref: { toolCallId: "t2" },
			},
		]);
		expect(summary.omitted).toEqual([]);
	});

	it("records failed, failed-without-exit-code, and unknown check outcomes", () => {
		const summary = build([
			{ kind: "toolCall", toolCallId: "t1", name: "bash", command: "npm run check" },
			{ kind: "toolResult", toolCallId: "t1", isError: true, exitCode: 2 },
			{ kind: "toolCall", toolCallId: "t2", name: "bash", command: "npx vitest --run a.test.ts" },
			{ kind: "toolResult", toolCallId: "t2", isError: true },
			{ kind: "toolCall", toolCallId: "t3", name: "bash", command: "npx tsc" },
		]);

		expect(summary.checks.map((check) => [check.command, check.status])).toEqual([
			["npm run check", "failed"],
			["npx vitest --run a.test.ts", "failed"],
			["npx tsc", "unknown"],
		]);
	});

	it("omits failed edits from changed files", () => {
		const summary = build([
			{ kind: "toolCall", toolCallId: "t1", name: "edit", path: "src/bad.ts" },
			{ kind: "toolResult", toolCallId: "t1", isError: true },
		]);

		expect(summary.changedFiles).toEqual([]);
	});

	it("marks incomplete history when the branch starts after a compaction", () => {
		const summary = build([
			{ kind: "compaction" },
			{ kind: "assistant", messageId: "m9", text: "Decision: use the Bus context item" },
		]);

		expect(summary.historyComplete).toBe(false);
		expect(summary.decisions).toHaveLength(1);
	});

	it("drops the oldest decisions first when the size limit is reached and discloses the omission", () => {
		const history: HandoffHistoryRecord[] = [];
		for (let index = 0; index < 60; index++) {
			history.push({ kind: "assistant", messageId: `m${index}`, text: `Decision ${index}: ${"x".repeat(300)}` });
		}
		const limit = 6_000;
		const summary = build(history, limit);

		expect(serializeHandoffSummary(summary).length).toBeLessThanOrEqual(limit);
		const dropped = summary.omitted.find((record) => record.section === "decisions");
		expect(dropped?.reason).toBe("size limit");
		expect(dropped?.count).toBe(60 - summary.decisions.length);
		expect(summary.decisions.at(-1)?.ref).toEqual({ messageId: "m59" });
	});

	it("rejects sender text that cannot fit, instead of silently dropping it", () => {
		expect(() =>
			buildHandoffSummary({ objective: "x".repeat(5_000), constraints: [], remainingWork: [], history: [] }, 4_000),
		).toThrow(/exceeds the 4000 character limit/);
	});
});

describe("parseHandoffSummary (#43)", () => {
	it("round-trips a serialized summary", () => {
		const summary = build([{ kind: "assistant", messageId: "m1", text: "Decision: JSON payload" }]);
		const parsed = parseHandoffSummary(serializeHandoffSummary(summary));

		expect(parsed).toEqual({ ok: true, summary });
	});

	it("rejects a payload over the size limit, including sender edits that grow it", () => {
		const summary = build([{ kind: "assistant", messageId: "m1", text: "Decision: small" }]);
		const oversized = serializeHandoffSummary(summary).replace(
			`"${objective}"`,
			`"${"x".repeat(HANDOFF_SUMMARY_MAX_CHARS)}"`,
		);
		const parsed = parseHandoffSummary(oversized);

		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? "" : parsed.error).toMatch(/exceeds the 16000 character limit/);
	});

	it.each([
		["invalid JSON", "{not json"],
		["non-object root", JSON.stringify(["version", 1])],
		["unknown version", JSON.stringify({ version: 2 })],
		[
			"missing objective",
			JSON.stringify({
				version: 1,
				constraints: [],
				decisions: [],
				changedFiles: [],
				checks: [],
				remainingWork: [],
				omitted: [],
				historyComplete: true,
			}),
		],
		[
			"unknown provenance",
			JSON.stringify({
				version: 1,
				objective: { text: "x", source: "trusted" },
				constraints: [],
				decisions: [],
				changedFiles: [],
				checks: [],
				remainingWork: [],
				omitted: [],
				historyComplete: true,
			}),
		],
	])("rejects a malformed payload: %s", (_name, text) => {
		const parsed = parseHandoffSummary(text);

		expect(parsed.ok).toBe(false);
	});
});
