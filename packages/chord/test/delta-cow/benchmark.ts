import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "cow" | "delta" | "astra";
type Scenario = "import" | "committed-read" | "draft-read" | "sparse" | "queue" | "sort" | "dense" | "unshift";
type Result = {
	mode: Mode;
	scenario: Scenario;
	size: number;
	trial: number;
	queueOperations: number;
	importMs: number;
	mutateMs: number;
	prepareMs: number;
	serializeMs: number;
	adoptMs: number;
	opBytes: number;
	operationCount: number;
	checksum: number;
	readyMiB: number;
	transientMiB: number;
	retainedMiB: number;
	maxRssMiB: number;
};

type Failure = { mode: Mode; scenario: Scenario; trial: number; stderr: string };

const scenarios: readonly Scenario[] = [
	"import",
	"committed-read",
	"draft-read",
	"sparse",
	"queue",
	"sort",
	"dense",
	"unshift",
];
const modes: readonly Mode[] = ["cow", "delta", "astra"];
const quick = process.argv.includes("--quick");
const size = quick ? 10_000 : 100_000;
const trials = quick ? 1 : 3;
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const worker = fileURLToPath(new URL("./benchmark.worker.ts", import.meta.url));
const results: Result[] = [];
const failures: Failure[] = [];

for (let trial = 0; trial < trials; trial++) {
	for (const scenario of scenarios) {
		for (const mode of modes) {
			const child = spawnSync(
				process.execPath,
				["--expose-gc", "--max-old-space-size=4096", worker, mode, scenario, String(size), String(trial)],
				{ cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
			);
			if (child.status !== 0) {
				const failure = { mode, scenario, trial, stderr: child.stderr } satisfies Failure;
				failures.push(failure);
				console.log(JSON.stringify(failure));
			} else {
				const result = JSON.parse(child.stdout) as Result;
				results.push(result);
				console.log(JSON.stringify(result));
			}
		}
	}
}

const average = (values: readonly number[]): number | null =>
	values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
const summary = scenarios.flatMap((scenario) =>
	modes.map((mode) => {
		const selected = results.filter((result) => result.mode === mode && result.scenario === scenario);
		return {
			mode,
			scenario,
			importMs: average(selected.map((result) => result.importMs)),
			mutateMs: average(selected.map((result) => result.mutateMs)),
			prepareMs: average(selected.map((result) => result.prepareMs)),
			serializeMs: average(selected.map((result) => result.serializeMs)),
			adoptMs: average(selected.map((result) => result.adoptMs)),
			opBytes: average(selected.map((result) => result.opBytes)),
			operationCount: average(selected.map((result) => result.operationCount)),
			readyMiB: average(selected.map((result) => result.readyMiB)),
			transientMiB: average(selected.map((result) => result.transientMiB)),
			retainedMiB: average(selected.map((result) => result.retainedMiB)),
			maxRssMiB: average(selected.map((result) => result.maxRssMiB)),
		};
	}),
);
const output = join(tmpdir(), "chord-cow-benchmark.json");
writeFileSync(output, JSON.stringify({ node: process.version, size, trials, results, failures, summary }, null, 2));
console.log(JSON.stringify({ output, node: process.version, size, trials, failures: failures.length, summary }));
