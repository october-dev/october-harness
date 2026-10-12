import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ScenarioCheck } from "./scenario.ts";

const COMMAND_TIMEOUT_MS = 60_000;

export type ToolExecution = { name: string; isError: boolean };

export type Compaction = { reason: string; ok: boolean };
export type BusCall = { name: string; arguments: Record<string, unknown> };

export type RunObservation = {
	workspace: string;
	toolExecutions: ToolExecution[];
	finalText: string;
	turns: number;
	compactions: Compaction[];
	busCalls: BusCall[];
};

function isDeepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export type CheckResult = { check: string; passed: boolean; weight: number; detail?: string };

function workspacePath(workspace: string, file: string): string {
	const path = resolve(workspace, file);
	const fromWorkspace = relative(workspace, path);
	if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
		throw new Error(`Check path escapes the workspace: ${file}`);
	}
	return path;
}

function runCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((done) => {
		exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, env: { PATH: process.env.PATH } }, (error, stdout, stderr) => {
			const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			done({ exitCode, output: `${stdout}${stderr}` });
		});
	});
}

async function evaluate(check: ScenarioCheck, run: RunObservation): Promise<Omit<CheckResult, "weight">> {
	if ("file" in check) {
		const path = workspacePath(run.workspace, check.file);
		const exists = existsSync(path);
		const label = `file ${check.file}`;
		if (check.exists === false) return { check: `${label} is absent`, passed: !exists };
		if (!exists) return { check: `${label} exists`, passed: false, detail: "file not found" };
		const content = await readFile(path, "utf8");
		const failures: string[] = [];
		if (check.contains !== undefined && !content.includes(check.contains)) {
			failures.push(`missing ${JSON.stringify(check.contains)}`);
		}
		if (check.notContains !== undefined && content.includes(check.notContains)) {
			failures.push(`still contains ${JSON.stringify(check.notContains)}`);
		}
		if (check.matches !== undefined && !new RegExp(check.matches, "m").test(content)) {
			failures.push(`does not match /${check.matches}/`);
		}
		return { check: label, passed: failures.length === 0, detail: failures.join("; ") || undefined };
	}
	if ("command" in check) {
		const { exitCode, output } = await runCommand(check.command, run.workspace);
		const expected = check.exitCode ?? 0;
		const failures: string[] = [];
		if (exitCode !== expected) failures.push(`exit ${exitCode}, expected ${expected}`);
		if (check.outputContains !== undefined && !output.includes(check.outputContains)) {
			failures.push(`output missing ${JSON.stringify(check.outputContains)}`);
		}
		return {
			check: `command ${check.command}`,
			passed: failures.length === 0,
			detail: failures.join("; ") || undefined,
		};
	}
	if ("toolCalls" in check) {
		const { name, min, max, errors } = check.toolCalls;
		const calls = run.toolExecutions.filter((execution) => name === undefined || execution.name === name);
		const errorCount = calls.filter((execution) => execution.isError).length;
		const failures: string[] = [];
		if (min !== undefined && calls.length < min) failures.push(`${calls.length} calls, expected at least ${min}`);
		if (max !== undefined && calls.length > max) failures.push(`${calls.length} calls, expected at most ${max}`);
		if (errors !== undefined && errorCount !== errors) failures.push(`${errorCount} errors, expected ${errors}`);
		return {
			check: `tool calls${name ? ` to ${name}` : ""}`,
			passed: failures.length === 0,
			detail: failures.join("; ") || undefined,
		};
	}
	if ("finalText" in check) {
		const passed = run.finalText.includes(check.finalText.contains);
		return {
			check: "final text",
			passed,
			detail: passed ? undefined : `missing ${JSON.stringify(check.finalText.contains)}`,
		};
	}
	if ("compactions" in check) {
		const { min, max } = check.compactions;
		const completed = run.compactions.filter((compaction) => compaction.ok).length;
		const failed = run.compactions.length - completed;
		const failures: string[] = [];
		if (min !== undefined && completed < min) failures.push(`${completed} compactions, expected at least ${min}`);
		if (max !== undefined && completed > max) failures.push(`${completed} compactions, expected at most ${max}`);
		if (failed > 0) failures.push(`${failed} compaction(s) failed or were aborted`);
		return { check: "compactions", passed: failures.length === 0, detail: failures.join("; ") || undefined };
	}
	if ("busCall" in check) {
		const { name, arguments: expected, count } = check.busCall;
		const matching = run.busCalls.filter(
			(call) =>
				call.name === name &&
				Object.entries(expected ?? {}).every(([key, value]) => isDeepEqual(call.arguments[key], value)),
		);
		const passed = count === undefined ? matching.length > 0 : matching.length === count;
		return {
			check: `Bus call ${name}`,
			passed,
			detail: passed
				? undefined
				: `${matching.length} matching of ${run.busCalls.filter((call) => call.name === name).length} ${name} call(s)` +
					(count === undefined ? "" : `, expected ${count}`),
		};
	}
	const passed = run.turns <= check.maxTurns;
	return {
		check: `at most ${check.maxTurns} turns`,
		passed,
		detail: passed ? undefined : `${run.turns} turns`,
	};
}

/** Evaluate every check against the finished run, in order. */
export async function evaluateChecks(checks: ScenarioCheck[], run: RunObservation): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		results.push({ ...(await evaluate(check, run)), weight: check.weight ?? 1 });
	}
	return results;
}

/** Weighted share of passing checks, from 0 to 1. */
export function scoreChecks(results: CheckResult[]): number {
	const total = results.reduce((sum, result) => sum + result.weight, 0);
	const passed = results.reduce((sum, result) => sum + (result.passed ? result.weight : 0), 0);
	return total === 0 ? 0 : passed / total;
}
