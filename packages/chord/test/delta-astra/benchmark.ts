import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "astra" | "delta" | "head";
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
const modes: readonly Mode[] = ["astra", "delta", "head"];
const quick = process.argv.includes("--quick");
const size = quick ? 10_000 : 100_000;
const trials = quick ? 1 : 3;
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const headRoot = join(tmpdir(), `chord-astra-head-${process.pid}`);
const headFiles = [
	"packages/chord/src/state/diff.ts",
	"packages/chord/src/state/draft.ts",
	"packages/chord/src/state/value.ts",
	"packages/chord/src/delta/index.ts",
	"packages/chord/src/types.ts",
] as const;

function writeHeadFixture(): string {
	for (const path of headFiles) {
		const destination = join(headRoot, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, execFileSync("git", ["show", `HEAD:${path}`], { cwd: root }));
	}
	const worker = join(headRoot, "packages/chord/test/delta-astra/benchmark-head.worker.ts");
	mkdirSync(dirname(worker), { recursive: true });
	const source = readFileSync(new URL("./benchmark-head.worker.ts", import.meta.url), "utf8")
		.replaceAll("../../src/delta/diff.ts", "../../src/state/diff.ts")
		.replaceAll("../../src/delta/draft.ts", "../../src/state/draft.ts")
		.replaceAll("../../src/delta/value.ts", "../../src/state/value.ts");
	writeFileSync(worker, source);
	writeFileSync(join(headRoot, "package.json"), JSON.stringify({ type: "module" }));
	return worker;
}

function average(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

const headWorker = writeHeadFixture();
const currentWorker = fileURLToPath(new URL("./benchmark.worker.ts", import.meta.url));
const results: Result[] = [];
const failures: Failure[] = [];
try {
	for (let trial = 0; trial < trials; trial++) {
		for (const scenario of scenarios) {
			for (const mode of modes) {
				const worker = mode === "head" ? headWorker : currentWorker;
				const args =
					mode === "head"
						? [scenario, String(size), String(trial)]
						: [mode, scenario, String(size), String(trial)];
				const child = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=4096", worker, ...args], {
					cwd: mode === "head" ? headRoot : root,
					encoding: "utf8",
					timeout: 300_000,
					maxBuffer: 10 * 1024 * 1024,
				});
				if (child.status !== 0) {
					const failure = { mode, scenario, trial, stderr: child.stderr } satisfies Failure;
					failures.push(failure);
					console.log(JSON.stringify(failure));
					continue;
				}
				const result = JSON.parse(child.stdout) as Result;
				results.push(result);
				console.log(JSON.stringify(result));
			}
		}
	}
} finally {
	rmSync(headRoot, { recursive: true, force: true });
}

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
			readyMiB: average(selected.map((result) => result.readyMiB)),
			transientMiB: average(selected.map((result) => result.transientMiB)),
			retainedMiB: average(selected.map((result) => result.retainedMiB)),
			maxRssMiB: average(selected.map((result) => result.maxRssMiB)),
			failures: failures.filter((failure) => failure.mode === mode && failure.scenario === scenario).length,
		};
	}),
);
const report = { node: process.version, head, size, trials, results, failures, summary };
const output = join(tmpdir(), "chord-astra-benchmark.json");
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, node: process.version, head, size, trials, summary }));
