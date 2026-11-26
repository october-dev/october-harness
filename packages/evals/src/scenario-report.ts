import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION as OCTOBER_VERSION } from "@october-dev/october";
import { SCENARIO_FORMAT_VERSION } from "./scenario.ts";
import { FAUX_MODEL, type ScenarioResult } from "./scenario-runner.ts";

/** Version 2 adds `runner` and per-scenario `fingerprint`, which baseline comparison requires. */
export const SCENARIO_REPORT_VERSION = 2;

const EVALS_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;

/** Versions of the code that produced a report. Shown in comparisons; a difference is expected, not an error. */
export type ScenarioRunner = {
	october: string;
	evals: string;
	scenarioFormat: number;
};

export type ScenarioReport = {
	reportVersion: typeof SCENARIO_REPORT_VERSION;
	createdAt: string;
	runner: ScenarioRunner;
	mode: "faux" | "model";
	/** `provider/id` of the model that ran every scenario. */
	model: string;
	passed: number;
	total: number;
	scenarios: ScenarioResult[];
};

export function buildScenarioReport(results: ScenarioResult[], createdAt = new Date()): ScenarioReport {
	return {
		reportVersion: SCENARIO_REPORT_VERSION,
		createdAt: createdAt.toISOString(),
		runner: { october: OCTOBER_VERSION, evals: EVALS_VERSION, scenarioFormat: SCENARIO_FORMAT_VERSION },
		mode: results[0]?.mode ?? "faux",
		model: results[0]?.model ?? FAUX_MODEL,
		passed: results.filter((result) => result.passed).length,
		total: results.length,
		scenarios: results,
	};
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** A concise Markdown summary: one row per scenario, then the failing checks and run errors. */
export function formatScenarioMarkdown(report: ScenarioReport): string {
	const lines = [
		`# Scenario evals (${report.mode === "faux" ? "faux" : report.model})`,
		"",
		`${report.passed}/${report.total} scenarios passed.`,
		"",
		"| Scenario | Result | Score | Turns | Tool calls (errors) | Tokens | Cost | Time |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const { id, passed, score, metrics } of report.scenarios) {
		const cost = metrics.costUsd === null ? "n/a" : `$${metrics.costUsd.toFixed(4)}`;
		lines.push(
			`| ${cell(id)} | ${passed ? "pass" : "FAIL"} | ${score.toFixed(2)} | ${metrics.turns} | ` +
				`${metrics.toolCalls} (${metrics.toolErrors}) | ${metrics.totalTokens} | ${cost} | ${metrics.durationMs} ms |`,
		);
	}
	const failures = report.scenarios.filter((result) => !result.passed);
	if (failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const result of failures) {
			for (const error of result.errors) lines.push(`- ${cell(result.id)}: ${cell(error)}`);
			for (const check of result.checks.filter((entry) => !entry.passed)) {
				lines.push(`- ${cell(result.id)}: ${cell(check.check)}${check.detail ? `: ${cell(check.detail)}` : ""}`);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Write `scenarios.json` and `summary.md` into `directory`. */
export async function writeScenarioReport(directory: string, report: ScenarioReport): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "scenarios.json"), `${JSON.stringify(report, null, "\t")}\n`);
	await writeFile(join(directory, "summary.md"), formatScenarioMarkdown(report));
}
