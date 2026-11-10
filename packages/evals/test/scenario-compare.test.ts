import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintScenario, loadScenario, type ScenarioFingerprint } from "../src/scenario.ts";
import { compareScenarioReports, formatScenarioComparison, readScenarioReport } from "../src/scenario-compare.ts";
import { buildScenarioReport, SCENARIO_REPORT_VERSION, type ScenarioReport } from "../src/scenario-report.ts";
import { erroredResult, FAUX_MODEL, runScenario, type ScenarioResult } from "../src/scenario-runner.ts";

const print: ScenarioFingerprint = { definition: "d1", checks: "c1", script: "s1", workspace: "w1" };

function result(id: string, checks: boolean[], overrides: Partial<ScenarioResult> = {}): ScenarioResult {
	return {
		id,
		fingerprint: print,
		mode: "faux",
		model: FAUX_MODEL,
		score: checks.filter(Boolean).length / checks.length,
		passed: checks.every(Boolean),
		checks: checks.map((passed, index) => ({ check: `check ${index}`, passed, weight: 1 })),
		errors: [],
		transcript: [],
		metrics: {
			turns: 2,
			toolCalls: 3,
			toolErrors: 0,
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			costUsd: null,
			durationMs: 40,
		},
		...overrides,
	};
}

function report(results: ScenarioResult[]): ScenarioReport {
	return buildScenarioReport(results, new Date("2026-11-10T00:00:00Z"));
}

describe("scenario baseline comparison", () => {
	it("reports equal runs as unchanged, with no regressions", () => {
		const comparison = compareScenarioReports(
			report([result("a", [true, true])]),
			report([result("a", [true, true])]),
		);
		expect(comparison).toMatchObject({ comparable: true, problems: [], regressions: 0 });
		expect(comparison.scenarios).toEqual([expect.objectContaining({ id: "a", status: "unchanged" })]);
		expect(comparison.scenarios[0]?.metrics?.totalTokens).toEqual({ baseline: 15, current: 15, change: 0 });
	});

	it("flags a newly failing check and a new run error as regressions", () => {
		const comparison = compareScenarioReports(
			report([result("a", [true, true]), result("b", [true])]),
			report([result("a", [true, false]), result("b", [true], { errors: ["Run ended with an error: boom"] })]),
		);
		expect(comparison.regressions).toBe(2);
		expect(comparison.scenarios[0]).toMatchObject({ status: "regressed", newlyFailingChecks: ["check 1"] });
		expect(comparison.scenarios[1]).toMatchObject({
			status: "regressed",
			newErrors: ["Run ended with an error: boom"],
		});
		expect(formatScenarioComparison(comparison)).toContain("a: newly failing: check 1");
	});

	it("reports a resolved failure as an improvement, not a regression", () => {
		const comparison = compareScenarioReports(
			report([result("a", [false, true])]),
			report([result("a", [true, true])]),
		);
		expect(comparison.regressions).toBe(0);
		expect(comparison.scenarios[0]).toMatchObject({ status: "improved", resolvedChecks: ["check 0"] });
	});

	it("does not count a failure that was already in the baseline", () => {
		const comparison = compareScenarioReports(report([result("a", [false])]), report([result("a", [false])]));
		expect(comparison.regressions).toBe(0);
		expect(comparison.scenarios[0]?.status).toBe("unchanged");
	});

	it("counts a missing scenario as a regression and an added one as information", () => {
		const comparison = compareScenarioReports(
			report([result("a", [true]), result("gone", [true])]),
			report([result("a", [true]), result("new", [false])]),
		);
		expect(comparison.regressions).toBe(1);
		expect(comparison.scenarios.map((entry) => [entry.id, entry.status])).toEqual([
			["a", "unchanged"],
			["gone", "missing"],
			["new", "added"],
		]);
	});

	it("rejects a scenario whose checks, fixture or definition changed", () => {
		for (const [field, words] of [
			["checks", "checks"],
			["workspace", "workspace fixture"],
			["definition", "definition"],
		] as const) {
			const changed = result("a", [true], { fingerprint: { ...print, [field]: "other" } });
			const comparison = compareScenarioReports(report([result("a", [false])]), report([changed]));
			expect(comparison, field).toMatchObject({ comparable: false, regressions: 0, scenarios: [] });
			expect(comparison.problems, field).toEqual([`a changed its ${words} since the baseline.`]);
		}
	});

	it("checks the faux script only when comparing faux runs", () => {
		const script = { ...print, script: "other" };
		const faux = compareScenarioReports(
			report([result("a", [true])]),
			report([result("a", [true], { fingerprint: script })]),
		);
		expect(faux.problems).toEqual(["a changed its faux script since the baseline."]);
		const model = (fingerprint: ScenarioFingerprint) =>
			report([result("a", [true], { mode: "model", model: "anthropic/x", fingerprint })]);
		expect(compareScenarioReports(model(print), model(script)).comparable).toBe(true);
	});

	it("rejects a different mode or model", () => {
		const faux = report([result("a", [true])]);
		const real = report([result("a", [true], { mode: "model", model: "anthropic/x" })]);
		const comparison = compareScenarioReports(faux, real);
		expect(comparison.comparable).toBe(false);
		expect(comparison.problems).toEqual([
			"The baseline ran in faux mode and the current report in model mode.",
			"The baseline used faux/faux-1 and the current report anthropic/x.",
		]);
	});

	it("rejects incomplete reports instead of comparing them", () => {
		const unloaded = result("a", [], { fingerprint: null, passed: false, errors: ["Scenario could not run: bad"] });
		expect(compareScenarioReports(report([unloaded]), report([result("a", [true])])).problems).toEqual([
			"a could not be loaded in the baseline run, so its identity is unknown.",
		]);
		const old = { ...report([result("a", [true])]), reportVersion: 1 };
		expect(compareScenarioReports(old, report([result("a", [true])])).problems[0]).toContain(
			`report version 1; comparison needs version ${SCENARIO_REPORT_VERSION}`,
		);
		for (const value of [null, [], { scenarios: "x" }]) {
			expect(compareScenarioReports(value, report([])).problems).toEqual(["Baseline is not a scenario report."]);
		}
		const twice = report([result("a", [true]), result("a", [true])]);
		expect(compareScenarioReports(twice, report([])).problems).toEqual(["Baseline lists scenario a more than once."]);
	});

	it("keeps unknown metrics unknown instead of treating them as zero", () => {
		const current = result("a", [true]);
		const { totalTokens: _dropped, ...withoutTokens } = current.metrics;
		const comparison = compareScenarioReports(
			report([result("a", [true])]),
			report([{ ...current, metrics: withoutTokens as ScenarioResult["metrics"] }]),
		);
		const metrics = comparison.scenarios[0]?.metrics;
		expect(metrics?.totalTokens).toEqual({ baseline: 15, current: null, change: null });
		expect(metrics?.costUsd).toEqual({ baseline: null, current: null, change: null });
		const markdown = formatScenarioComparison(comparison);
		expect(markdown).toContain("15 → n/a");
		expect(markdown).toContain("n/a → n/a");
	});

	it("never reports an improvement when the reports are not comparable", () => {
		const markdown = formatScenarioComparison(
			compareScenarioReports(
				report([result("a", [false])]),
				report([result("a", [true], { fingerprint: { ...print, checks: "other" } })]),
			),
		);
		expect(markdown).toContain("Not comparable");
		expect(markdown).not.toMatch(/improved|regression\(s\)|No regressions/);
	});

	it("records the runner and the report version in new reports", () => {
		expect(report([])).toMatchObject({
			reportVersion: 2,
			runner: { october: expect.any(String), evals: expect.any(String), scenarioFormat: 1 },
		});
	});
});

describe("comparison input validation", () => {
	const valid = () => JSON.parse(JSON.stringify(report([result("a", [true])])));
	const breaks: Record<string, (value: Record<string, any>) => void> = {
		"missing verdict": (value) => delete value.scenarios[0].passed,
		"malformed check entry": (value) => {
			value.scenarios[0].checks[0] = { check: 5, passed: "yes" };
		},
		"non-array errors": (value) => {
			value.scenarios[0].errors = {};
		},
		"missing runner": (value) => delete value.runner,
		"missing mode": (value) => delete value.mode,
		"missing model": (value) => delete value.model,
		"string fingerprint": (value) => {
			value.scenarios[0].fingerprint = "d1";
		},
	};

	it.each(Object.keys(breaks))("rejects a baseline with a %s, without throwing or judging", (name) => {
		const damaged = valid();
		breaks[name]?.(damaged);
		const comparison = compareScenarioReports(damaged, report([result("a", [true])]));
		expect(comparison).toMatchObject({ comparable: false, regressions: 0, scenarios: [] });
		expect(comparison.problems[0]).toMatch(/^Baseline is not a valid scenario report: /);
		expect(formatScenarioComparison(comparison)).not.toMatch(/improved|No regressions/);
	});

	it("rejects an unreadable baseline file instead of comparing it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-scenario-baseline-"));
		try {
			const truncated = join(directory, "scenarios.json");
			writeFileSync(truncated, JSON.stringify(valid()).slice(0, 40));
			await expect(readScenarioReport(truncated)).rejects.toThrow(SyntaxError);
			await expect(readScenarioReport(join(directory, "missing.json"))).rejects.toThrow(/ENOENT/);
			// A directory is read through its scenarios.json, which here is the truncated file.
			await expect(readScenarioReport(directory)).rejects.toThrow(SyntaxError);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("comparison of runs that could not run or load", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-scenario-errored-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function realRun() {
		mkdirSync(join(tempDir, "s", "workspace"), { recursive: true });
		writeFileSync(join(tempDir, "s", "workspace", "a.txt"), "x");
		writeFileSync(
			join(tempDir, "s", "scenario.json"),
			JSON.stringify({
				formatVersion: 1,
				id: "test/errored",
				prompt: "Say done.",
				tools: [],
				faux: [{ text: "Done." }],
				expect: [{ file: "a.txt", exists: true }],
			}),
		);
		const scenario = await loadScenario(join(tempDir, "s"));
		return { scenario, run: await runScenario(scenario) };
	}

	it("reports a scenario that loads but cannot run as a regression, not a model change", async () => {
		const { scenario, run } = await realRun();
		expect(run).toMatchObject({ passed: true, model: FAUX_MODEL });
		const thrown = erroredResult(scenario.id, new Error("boom"), undefined, await fingerprintScenario(scenario));
		const comparison = compareScenarioReports(report([run]), report([thrown]));
		expect(comparison).toMatchObject({ comparable: true, regressions: 1 });
		expect(comparison.scenarios).toEqual([
			expect.objectContaining({
				id: "test/errored",
				status: "regressed",
				newErrors: ["Scenario could not run: boom"],
			}),
		]);
	});

	it("reports a scenario that fails to load as its id missing plus its path added", async () => {
		const { run } = await realRun();
		// What the CLI records when loading fails: the directory path as the id and no fingerprint.
		const unloaded = erroredResult("scenarios/errored", new Error("Invalid scenario"));
		const comparison = compareScenarioReports(report([run]), report([unloaded]));
		expect(comparison).toMatchObject({ comparable: true, regressions: 1 });
		expect(comparison.scenarios.map((entry) => [entry.id, entry.status])).toEqual([
			["scenarios/errored", "added"],
			["test/errored", "missing"],
		]);
	});
});

describe("scenario fingerprints", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-scenario-fingerprint-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function write(relativePath: string, content: string): void {
		const path = join(tempDir, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	const scenario = {
		formatVersion: 1,
		id: "test/fingerprint",
		description: "first",
		prompt: "Do it.",
		tools: ["edit"],
		faux: [{ text: "Done." }],
		expect: [{ file: "a.txt", exists: true }],
	};

	async function fingerprint(definition: object, files: Record<string, string> = { "a.txt": "x" }) {
		rmSync(join(tempDir, "s"), { recursive: true, force: true });
		write("s/scenario.json", JSON.stringify(definition));
		for (const [path, content] of Object.entries(files)) write(join("s/workspace", path), content);
		return fingerprintScenario(await loadScenario(join(tempDir, "s")));
	}

	it("ignores key order and the description, and tracks each part separately", async () => {
		const base = await fingerprint(scenario);
		const reordered = Object.fromEntries(Object.entries(scenario).reverse());
		expect(await fingerprint({ ...reordered, description: "second" })).toEqual(base);
		expect(await fingerprint(scenario, { "a.txt": "changed" })).toEqual({
			...base,
			workspace: expect.not.stringMatching(base.workspace ?? ""),
		});
		const checks = await fingerprint({ ...scenario, expect: [{ file: "a.txt", contains: "x" }] });
		expect(checks).toEqual({ ...base, checks: expect.not.stringMatching(base.checks) });
		const prompt = await fingerprint({ ...scenario, prompt: "Do it twice." });
		expect(prompt).toEqual({ ...base, definition: expect.not.stringMatching(base.definition) });
		const script = await fingerprint({ ...scenario, faux: [{ text: "Finished." }] });
		expect(script).toEqual({ ...base, script: expect.not.stringMatching(base.script) });
		expect((await fingerprint(scenario, {})).workspace).toBeNull();
	});

	it("tracks fixture file names, not only contents", async () => {
		const base = await fingerprint(scenario, { "a.txt": "x" });
		expect((await fingerprint(scenario, { "b.txt": "x" })).workspace).not.toBe(base.workspace);
	});
});
