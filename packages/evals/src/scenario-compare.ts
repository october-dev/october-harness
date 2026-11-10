import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { SCENARIO_REPORT_VERSION } from "./scenario-report.ts";

/**
 * Baseline comparison for scenario reports (#51).
 *
 * Two reports are compared only when they ran the same scenarios the same way: same report format, mode and
 * model, and for every shared scenario the same definition, checks, fixture and (for faux runs) script.
 * Anything else makes the comparison incompatible, and no improvement or regression is reported.
 */

export const SCENARIO_COMPARISON_VERSION = 1;

const OptionalMetric = Type.Optional(Type.Number());

/**
 * The fields comparison reads, validated before any are used: a baseline file is untrusted input. Other report
 * fields are allowed and ignored. Metrics stay optional, so a missing one is reported as unavailable.
 */
const ComparableReportSchema = Type.Object({
	reportVersion: Type.Literal(SCENARIO_REPORT_VERSION),
	createdAt: Type.String(),
	runner: Type.Object({ october: Type.String(), evals: Type.String(), scenarioFormat: Type.Integer() }),
	mode: Type.Union([Type.Literal("faux"), Type.Literal("model")]),
	model: Type.String({ minLength: 1 }),
	scenarios: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			fingerprint: Type.Union([
				Type.Object({
					definition: Type.String(),
					checks: Type.String(),
					script: Type.String(),
					workspace: Type.Union([Type.String(), Type.Null()]),
				}),
				Type.Null(),
			]),
			passed: Type.Boolean(),
			checks: Type.Array(Type.Object({ check: Type.String(), passed: Type.Boolean() })),
			errors: Type.Array(Type.String()),
			metrics: Type.Optional(
				Type.Object({
					turns: OptionalMetric,
					toolCalls: OptionalMetric,
					toolErrors: OptionalMetric,
					totalTokens: OptionalMetric,
					costUsd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
					durationMs: OptionalMetric,
				}),
			),
		}),
	),
});
const checkComparableReport = Compile(ComparableReportSchema);

type ComparableReport = Static<typeof ComparableReportSchema>;
type ComparableResult = ComparableReport["scenarios"][number];

type MetricName = "turns" | "toolCalls" | "toolErrors" | "totalTokens" | "costUsd" | "durationMs";
const METRICS: MetricName[] = ["turns", "toolCalls", "toolErrors", "totalTokens", "costUsd", "durationMs"];

/** A metric on both sides. `null` means unavailable (no price, or absent from the report), never zero. */
export type MetricChange = { baseline: number | null; current: number | null; change: number | null };

export type ScenarioChange = {
	id: string;
	/** `regressed` and `missing` count as regressions; `added` and `improved` never hide one. */
	status: "unchanged" | "regressed" | "improved" | "missing" | "added";
	baselinePassed: boolean | null;
	currentPassed: boolean | null;
	newlyFailingChecks: string[];
	resolvedChecks: string[];
	newErrors: string[];
	metrics: Record<MetricName, MetricChange> | null;
};

type ReportSide = Pick<ComparableReport, "createdAt" | "runner" | "mode" | "model">;

export type ScenarioComparison =
	| {
			comparisonVersion: typeof SCENARIO_COMPARISON_VERSION;
			comparable: true;
			problems: [];
			baseline: ReportSide;
			current: ReportSide;
			regressions: number;
			scenarios: ScenarioChange[];
	  }
	| {
			comparisonVersion: typeof SCENARIO_COMPARISON_VERSION;
			comparable: false;
			/** Why the reports cannot be compared. */
			problems: string[];
			baseline: ReportSide | null;
			current: ReportSide | null;
			regressions: 0;
			scenarios: [];
	  };

/** Validates one report; the version is checked first so an old report gets an actionable message. */
function parseReport(label: string, value: unknown): { report: ComparableReport } | { problems: string[] } {
	const version =
		typeof value === "object" && value !== null ? (value as { reportVersion?: unknown }).reportVersion : undefined;
	if (typeof version !== "number") return { problems: [`${label} is not a scenario report.`] };
	if (version !== SCENARIO_REPORT_VERSION) {
		return {
			problems: [
				`${label} has report version ${String(version)}; comparison needs version ${SCENARIO_REPORT_VERSION}. Re-run it with this runner.`,
			],
		};
	}
	if (!checkComparableReport.Check(value)) {
		const details = checkComparableReport
			.Errors(value)
			.slice(0, 5)
			.map((error) => `${error.instancePath || "/"} ${error.message}`);
		return { problems: [`${label} is not a valid scenario report: ${details.join("; ")}.`] };
	}
	const ids = new Set<string>();
	const problems: string[] = [];
	for (const { id } of value.scenarios) {
		if (ids.has(id)) problems.push(`${label} lists scenario ${id} more than once.`);
		ids.add(id);
	}
	return problems.length > 0 ? { problems } : { report: value };
}

function metricChanges(baseline: ComparableResult, current: ComparableResult): Record<MetricName, MetricChange> {
	const changes = {} as Record<MetricName, MetricChange>;
	for (const name of METRICS) {
		const before = baseline.metrics?.[name] ?? null;
		const after = current.metrics?.[name] ?? null;
		changes[name] = {
			baseline: before,
			current: after,
			change: before === null || after === null ? null : after - before,
		};
	}
	return changes;
}

/** Why one shared scenario cannot be compared, or nothing when it can. */
function fingerprintProblems(
	id: string,
	mode: string,
	before: ComparableResult["fingerprint"],
	after: ComparableResult["fingerprint"],
): string[] {
	if (!before || !after)
		return [`${id} could not be loaded in the ${before ? "current" : "baseline"} run, so its identity is unknown.`];
	const changed: string[] = [];
	if (before.definition !== after.definition) changed.push("definition");
	if (before.checks !== after.checks) changed.push("checks");
	if (before.workspace !== after.workspace) changed.push("workspace fixture");
	if (mode === "faux" && before.script !== after.script) changed.push("faux script");
	return changed.length > 0 ? [`${id} changed its ${changed.join(", ")} since the baseline.`] : [];
}

function compareScenario(baseline: ComparableResult, current: ComparableResult): ScenarioChange {
	const newlyFailingChecks: string[] = [];
	const resolvedChecks: string[] = [];
	// Identical check fingerprints guarantee the same checks in the same order, so index pairs them.
	for (const [index, after] of current.checks.entries()) {
		const before = baseline.checks[index];
		if (!before) continue;
		if (before.passed && !after.passed) newlyFailingChecks.push(after.check);
		if (!before.passed && after.passed) resolvedChecks.push(after.check);
	}
	const known = new Set(baseline.errors);
	const newErrors = current.errors.filter((error) => !known.has(error));
	const regressed = newlyFailingChecks.length > 0 || newErrors.length > 0 || (baseline.passed && !current.passed);
	const improved = !regressed && (resolvedChecks.length > 0 || (!baseline.passed && current.passed));
	return {
		id: current.id,
		status: regressed ? "regressed" : improved ? "improved" : "unchanged",
		baselinePassed: baseline.passed,
		currentPassed: current.passed,
		newlyFailingChecks,
		resolvedChecks,
		newErrors,
		metrics: metricChanges(baseline, current),
	};
}

function side({ createdAt, runner, mode, model }: ComparableReport): ReportSide {
	return { createdAt, runner, mode, model };
}

function incompatible(
	problems: string[],
	baseline: ReportSide | null = null,
	current: ReportSide | null = null,
): ScenarioComparison {
	return {
		comparisonVersion: SCENARIO_COMPARISON_VERSION,
		comparable: false,
		problems,
		baseline,
		current,
		regressions: 0,
		scenarios: [],
	};
}

/** Compares `current` with `baseline`. Both are untrusted values, such as parsed `scenarios.json` files. */
export function compareScenarioReports(baselineValue: unknown, currentValue: unknown): ScenarioComparison {
	const parsedBaseline = parseReport("Baseline", baselineValue);
	const parsedCurrent = parseReport("Current report", currentValue);
	if ("problems" in parsedBaseline || "problems" in parsedCurrent) {
		return incompatible([
			...("problems" in parsedBaseline ? parsedBaseline.problems : []),
			...("problems" in parsedCurrent ? parsedCurrent.problems : []),
		]);
	}
	const baseline = parsedBaseline.report;
	const current = parsedCurrent.report;
	const problems: string[] = [];
	if (baseline.mode !== current.mode)
		problems.push(`The baseline ran in ${baseline.mode} mode and the current report in ${current.mode} mode.`);
	if (baseline.model !== current.model)
		problems.push(`The baseline used ${baseline.model} and the current report ${current.model}.`);
	if (baseline.runner.scenarioFormat !== current.runner.scenarioFormat)
		problems.push("The reports use different scenario formats.");

	const before = new Map(baseline.scenarios.map((result) => [result.id, result]));
	const after = new Map(current.scenarios.map((result) => [result.id, result]));
	for (const [id, result] of before) {
		const match = after.get(id);
		if (match) problems.push(...fingerprintProblems(id, current.mode, result.fingerprint, match.fingerprint));
	}
	if (problems.length > 0) return incompatible(problems, side(baseline), side(current));

	const scenarios: ScenarioChange[] = [];
	const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
	for (const id of ids) {
		const was = before.get(id);
		const now = after.get(id);
		if (was && now) scenarios.push(compareScenario(was, now));
		else {
			scenarios.push({
				id,
				status: was ? "missing" : "added",
				baselinePassed: was?.passed ?? null,
				currentPassed: now?.passed ?? null,
				newlyFailingChecks: [],
				resolvedChecks: [],
				newErrors: [],
				metrics: null,
			});
		}
	}
	return {
		comparisonVersion: SCENARIO_COMPARISON_VERSION,
		comparable: true,
		problems: [],
		baseline: side(baseline),
		current: side(current),
		regressions: scenarios.filter((entry) => entry.status === "regressed" || entry.status === "missing").length,
		scenarios,
	};
}

/** Reads a baseline from `scenarios.json` or a report directory that contains one. Throws if unreadable. */
export async function readScenarioReport(path: string): Promise<unknown> {
	const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "scenarios.json") : path;
	return JSON.parse(await readFile(file, "utf8"));
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatChange(change: MetricChange, money = false): string {
	const show = (value: number | null) => (value === null ? "n/a" : money ? `$${value.toFixed(4)}` : String(value));
	if (change.change === null) return `${show(change.baseline)} → ${show(change.current)}`;
	const delta = money ? change.change.toFixed(4) : String(change.change);
	return `${show(change.baseline)} → ${show(change.current)} (${change.change > 0 ? "+" : ""}${delta})`;
}

function versions(report: ReportSide): string {
	return `October ${report.runner.october}, evals ${report.runner.evals}`;
}

export function formatScenarioComparison(comparison: ScenarioComparison): string {
	const lines = ["# Scenario comparison", ""];
	if (!comparison.comparable) {
		lines.push("**Not comparable.** No regression or improvement is reported.", "");
		for (const problem of comparison.problems) lines.push(`- ${cell(problem)}`);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`Baseline: ${comparison.baseline.createdAt} (${versions(comparison.baseline)})`,
		`Current: ${comparison.current.createdAt} (${versions(comparison.current)})`,
		"",
		comparison.regressions === 0 ? "No regressions." : `**${comparison.regressions} regression(s).**`,
		"",
		"| Scenario | Change | Baseline | Current | Turns | Tool calls | Tokens | Cost |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	);
	const result = (passed: boolean | null) => (passed === null ? "absent" : passed ? "pass" : "FAIL");
	for (const entry of comparison.scenarios) {
		const metrics = entry.metrics;
		lines.push(
			`| ${cell(entry.id)} | ${entry.status} | ${result(entry.baselinePassed)} | ${result(entry.currentPassed)} | ` +
				`${metrics ? formatChange(metrics.turns) : ""} | ${metrics ? formatChange(metrics.toolCalls) : ""} | ` +
				`${metrics ? formatChange(metrics.totalTokens) : ""} | ${metrics ? formatChange(metrics.costUsd, true) : ""} |`,
		);
	}
	const details: string[] = [];
	for (const entry of comparison.scenarios) {
		for (const check of entry.newlyFailingChecks) details.push(`- ${cell(entry.id)}: newly failing: ${cell(check)}`);
		for (const error of entry.newErrors) details.push(`- ${cell(entry.id)}: new error: ${cell(error)}`);
		if (entry.status === "missing") details.push(`- ${cell(entry.id)}: missing from the current report`);
		for (const check of entry.resolvedChecks) details.push(`- ${cell(entry.id)}: now passing: ${cell(check)}`);
		if (entry.status === "added") details.push(`- ${cell(entry.id)}: new since the baseline`);
	}
	if (details.length > 0) lines.push("", "## Changes", "", ...details);
	lines.push("", "Run time is recorded in the JSON comparison but never gated: it varies between machines and runs.");
	return `${lines.join("\n")}\n`;
}
