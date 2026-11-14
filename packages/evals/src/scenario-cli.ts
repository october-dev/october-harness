import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	discoverScenarios,
	fingerprintScenario,
	type LoadedScenario,
	loadScenario,
	writeRecordedScenario,
} from "./scenario.ts";
import { compareScenarioReports, formatScenarioComparison, readScenarioReport } from "./scenario-compare.ts";
import { buildScenarioReport, formatScenarioMarkdown, writeScenarioReport } from "./scenario-report.ts";
import { erroredResult, runScenario, type ScenarioModelSelection, type ScenarioResult } from "./scenario-runner.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
	options: {
		scenarios: { type: "string", multiple: true },
		out: { type: "string" },
		filter: { type: "string" },
		provider: { type: "string" },
		model: { type: "string" },
		record: { type: "string" },
		baseline: { type: "string" },
		gate: { type: "boolean" },
	},
});

if (values.gate && !values.baseline) throw new Error("--gate compares against a baseline; pass --baseline <report>.");
// Read the baseline first, so a bad path fails before any scenario runs.
let baseline: unknown;
if (values.baseline) {
	try {
		baseline = await readScenarioReport(values.baseline);
	} catch (error) {
		// Exit 2 means "cannot be compared"; 1 would read as a regression under --gate.
		process.stderr.write(
			`Cannot compare: the baseline ${values.baseline} could not be read as JSON (${error instanceof Error ? error.message : String(error)}).\n`,
		);
		process.exit(2);
	}
}
if (Boolean(values.provider) !== Boolean(values.model))
	throw new Error("Pass both --provider and --model, or neither.");
const model: ScenarioModelSelection | undefined =
	values.provider && values.model ? { provider: values.provider, id: values.model } : undefined;
if (values.record && !model) throw new Error("--record saves a real-model run; pass --provider and --model.");

const packs = values.scenarios ?? [join(packageRoot, "scenarios")];
const directories = (await Promise.all(packs.map((pack) => discoverScenarios(pack))))
	.flat()
	.filter((directory) => values.filter === undefined || directory.includes(values.filter));
if (directories.length === 0) throw new Error(`No scenarios found under ${packs.join(", ")}`);

const results: ScenarioResult[] = [];
// Sequential on purpose: each run changes process.env while it executes.
for (const directory of directories) {
	let scenario: LoadedScenario;
	try {
		scenario = await loadScenario(directory);
	} catch (error) {
		results.push(erroredResult(relative(process.cwd(), directory), error, model));
		continue;
	}
	let result: ScenarioResult;
	try {
		result = await runScenario(scenario, { model });
	} catch (error) {
		const fingerprint = await fingerprintScenario(scenario).catch(() => null);
		results.push(erroredResult(scenario.id, error, model, fingerprint));
		continue;
	}
	results.push(result);
	if (values.record) {
		const saved = await writeRecordedScenario(scenario, result.transcript, values.record);
		process.stdout.write(`Recorded ${scenario.id} -> ${saved}\n`);
	}
}
const report = buildScenarioReport(results);
const out = values.out ?? join(packageRoot, ".eval", `scenarios-${report.createdAt.replaceAll(":", "-")}`);
await writeScenarioReport(out, report);
process.stdout.write(`${formatScenarioMarkdown(report)}\nReport: ${out}\n`);
process.exitCode = report.passed === report.total ? 0 : 1;

if (baseline !== undefined) {
	const comparison = compareScenarioReports(baseline, report);
	const markdown = formatScenarioComparison(comparison);
	await writeFile(join(out, "comparison.json"), `${JSON.stringify(comparison, null, "\t")}\n`);
	await writeFile(join(out, "comparison.md"), markdown);
	process.stdout.write(`\n${markdown}`);
	// 2: the reports cannot be compared. With --gate, 1 means a regression against the baseline, so a
	// scenario that already failed in the baseline does not fail the gate.
	if (!comparison.comparable) process.exitCode = 2;
	else if (values.gate) process.exitCode = comparison.regressions > 0 ? 1 : 0;
}
