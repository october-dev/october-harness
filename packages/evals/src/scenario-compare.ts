import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioFingerprint } from "./scenario.ts";
import { SCENARIO_REPORT_VERSION, type ScenarioReport, type ScenarioRunner } from "./scenario-report.ts";
import type { ScenarioResult } from "./scenario-runner.ts";

/**
 * Baseline comparison for scenario reports (#51).
 *
 * Two reports are compared only when they ran the same scenarios the same way: same report format, mode and
 * model, and for every shared scenario the same definition, checks, fixture and (for faux runs) script.
 * Anything else makes the comparison incompatible, and no improvement or regression is reported.
 */

export const SCENARIO_COMPARISON_VERSION = 1;

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

type ReportSide = Pick<ScenarioReport, "createdAt" | "mode" | "model"> & { runner: ScenarioRunner | null };

export type ScenarioComparison = {
	comparisonVersion: typeof SCENARIO_COMPARISON_VERSION;
	comparable: boolean;
	/** Why the reports cannot be compared. Empty when `comparable`. */
	problems: string[];
	baseline: ReportSide | null;
	current: ReportSide | null;
	regressions: number;
	scenarios: ScenarioChange[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the fields comparison relies on, since a baseline file is untrusted input. */
function reportProblems(label: string, value: unknown): string[] {
	if (!isRecord(value) || !Array.isArray(value.scenarios)) return [`${label} is not a scenario report.`];
	if (value.reportVersion !== SCENARIO_REPORT_VERSION) {
		return [
			`${label} has report version ${String(value.reportVersion)}; comparison needs version ${SCENARIO_REPORT_VERSION}. Re-run it with this runner.`,
		];
	}
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const [index, scenario] of value.scenarios.entries()) {
		if (!isRecord(scenario) || typeof scenario.id !== "string" || !Array.isArray(scenario.checks)) {
			problems.push(`${label} scenario ${index} is malformed.`);
			continue;
		}
		if (ids.has(scenario.id)) problems.push(`${label} lists scenario ${scenario.id} more than once.`);
		ids.add(scenario.id);
	}
	return problems;
}

function metric(result: ScenarioResult, name: MetricName): number | null {
	const value: unknown = isRecord(result.metrics) ? result.metrics[name] : undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricChanges(baseline: ScenarioResult, current: ScenarioResult): Record<MetricName, MetricChange> {
	const changes = {} as Record<MetricName, MetricChange>;
	for (const name of METRICS) {
		const before = metric(baseline, name);
		const after = metric(current, name);
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
	before: ScenarioFingerprint | null,
	after: ScenarioFingerprint | null,
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

function compareScenario(baseline: ScenarioResult, current: ScenarioResult): ScenarioChange {
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

function side(report: ScenarioReport): ReportSide {
	return { createdAt: report.createdAt, runner: report.runner ?? null, mode: report.mode, model: report.model };
}

/** Compares `current` with `baseline`. Both are untrusted values, such as parsed `scenarios.json` files. */
export function compareScenarioReports(baselineValue: unknown, currentValue: unknown): ScenarioComparison {
	const problems = [...reportProblems("Baseline", baselineValue), ...reportProblems("Current report", currentValue)];
	const incompatible = (
		reasons: string[],
		baseline: ReportSide | null = null,
		current: ReportSide | null = null,
	): ScenarioComparison => ({
		comparisonVersion: SCENARIO_COMPARISON_VERSION,
		comparable: false,
		problems: reasons,
		baseline,
		current,
		regressions: 0,
		scenarios: [],
	});
	if (problems.length > 0) return incompatible(problems);
	const baseline = baselineValue as ScenarioReport;
	const current = currentValue as ScenarioReport;
	if (baseline.mode !== current.mode)
		problems.push(`The baseline ran in ${baseline.mode} mode and the current report in ${current.mode} mode.`);
	if (baseline.model !== current.model)
		problems.push(`The baseline used ${baseline.model} and the current report ${current.model}.`);
	if (baseline.runner?.scenarioFormat !== current.runner?.scenarioFormat)
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

/** Reads a baseline from `scenarios.json` or a report directory that contains one. */
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

function versions(report: ReportSide | null): string {
	return report?.runner ? `October ${report.runner.october}, evals ${report.runner.evals}` : "unknown runner";
}

export function formatScenarioComparison(comparison: ScenarioComparison): string {
	const lines = ["# Scenario comparison", ""];
	if (!comparison.comparable) {
		lines.push("**Not comparable.** No regression or improvement is reported.", "");
		for (const problem of comparison.problems) lines.push(`- ${cell(problem)}`);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`Baseline: ${comparison.baseline?.createdAt} (${versions(comparison.baseline)})`,
		`Current: ${comparison.current?.createdAt} (${versions(comparison.current)})`,
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
