import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverScenarios, type LoadedScenario, loadScenario, writeRecordedScenario } from "./scenario.ts";
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
	},
});

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
		results.push(erroredResult(scenario.id, error, model));
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
