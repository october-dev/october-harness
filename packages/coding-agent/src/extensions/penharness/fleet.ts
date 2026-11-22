/**
 * The october-native fleet. Where upstream PenHarness dispatches opencode workers to boat.dev /
 * fly.io boxes over HTTP via `fleet.py`, this spawns october subagents locally: one fresh, isolated
 * october process per hypothesis, running in the hunt directory, told the worker doctrine and the
 * current ledger so it never re-digs a dead end. Concurrency is capped so the batch stays polite and
 * within provider limits; hand it the whole inventory and it drains the queue.
 *
 * Two tools are registered: `hunt_dispatch` (fan out hypotheses to workers) and `hunt_status`
 * (read the merged ledger). The lead calls these; workers are given neither, so they cannot fork.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { findHunt, readLedger, scopeLooksAuthorized, summarizeLedger } from "./hunt.ts";
import { WORKER_DOCTRINE } from "./methodology.ts";

/**
 * Default concurrent workers, tuned to october's shared-inference comfort zone. This is a default,
 * not a ceiling: the caller raises it freely with the `concurrency` parameter. October's standing
 * product rule is no caps or quotas on what the user starts, so there is no hard upper bound.
 */
const DEFAULT_CONCURRENCY = 4;
/**
 * Default guidance for how many hypotheses one dispatch typically carries. Also only a default: a
 * call may pass more and they all run. Kept to shape the tool description, not to refuse a batch.
 */
const DEFAULT_MAX_TASKS = 60;
/** Per-worker wall-clock ceiling. A probe that hangs this long is killed and reported as timed out. */
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
/** Worker tool allowlist. Deliberately excludes hunt_dispatch/subagent so leaves cannot fan out. */
const WORKER_TOOLS = "bash,read,write,edit,grep,find,ls";
/** Cap on the ledger/dead-end context pasted into each worker task. */
const CONTEXT_CAP = 8 * 1024;

interface WorkerResult {
	hypothesis: string;
	ok: boolean;
	output: string;
	stopReason?: string;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Resolve how to re-invoke october for a worker. Prefer the exact script this process is running so
 * the worker is the same build; fall back to the `october` binary on PATH when running from a
 * compiled single-file executable.
 */
function octoberInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "october", args };
}

function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text.trim();
			}
		}
	}
	return "";
}

async function writeWorkerPrompt(doctrine: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "october-hunt-worker-"));
	const filePath = path.join(dir, "worker-doctrine.md");
	await fs.promises.writeFile(filePath, doctrine, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

/** Compact ledger + dead-end context so a worker does not re-dig closed leads. */
function huntContext(huntDir: string): string {
	const { entries } = readLedger(huntDir);
	const confirmed = entries
		.filter((entry) => entry.status === "confirmed" || entry.status === "hypothesis")
		.map((entry) => `${entry.status}: ${entry.id ?? "?"} ${entry.title ?? ""} @ ${entry.where ?? "?"}`)
		.join("\n");
	let deadEnds = "";
	try {
		deadEnds = fs.readFileSync(path.join(huntDir, "dead-ends.md"), "utf-8");
	} catch {
		/* none */
	}
	let context = "";
	if (confirmed) context += `Known findings so far (do not re-report these):\n${confirmed}\n\n`;
	if (deadEnds.trim()) context += `Dead ends already fired (do not re-dig these):\n${deadEnds}\n`;
	if (context.length > CONTEXT_CAP) context = `${context.slice(0, CONTEXT_CAP)}\n[context truncated]`;
	return context;
}

async function runWorker(
	huntDir: string,
	lane: string,
	hypothesis: string,
	model: string | undefined,
	promptPath: string,
	context: string,
	signal: AbortSignal | undefined,
): Promise<WorkerResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--tools", WORKER_TOOLS, "--append-system-prompt", promptPath];
	if (model) args.push("--model", model);

	const task = [
		`Lane: ${lane}`,
		`Hypothesis to test: ${hypothesis}`,
		"",
		context,
		"Test exactly this one hypothesis against the live target per your worker doctrine, run a",
		"control, and serialize the result to findings.d/. Then stop.",
	].join("\n");
	args.push(task);

	const messages: Message[] = [];
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let timedOut = false;

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = octoberInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: huntDir,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line) as { type?: string; message?: Message };
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message;
				messages.push(msg);
				if (msg.role === "assistant") {
					if (msg.stopReason) stopReason = msg.stopReason;
					if (msg.errorMessage) errorMessage = msg.errorMessage;
				}
			}
		};
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		}, WORKER_TIMEOUT_MS);
		proc.on("close", () => clearTimeout(timer));

		if (signal) {
			const onAbort = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});

	const ok = exitCode === 0 && stopReason !== "error" && stopReason !== "aborted" && !timedOut;
	let output: string;
	if (timedOut) output = `(worker timed out after ${Math.round(WORKER_TIMEOUT_MS / 60000)}m)`;
	else if (!ok) output = errorMessage || finalAssistantText(messages) || stderr.trim() || "(worker failed, no output)";
	else output = finalAssistantText(messages) || "(worker produced no summary; check findings.d/)";

	return { hypothesis, ok, output: output.slice(0, 4000), stopReason: timedOut ? "timeout" : stopReason };
}

const DispatchParams = Type.Object({
	lane: Type.String({ description: "Short lane name this batch belongs to, e.g. 'cve-pillow' or 'authz-grep'." }),
	hypotheses: Type.Array(Type.String(), {
		description: "One probe hypothesis per entry. Each becomes one isolated worker. Micro-task: 30-60 is normal.",
	}),
	model: Type.Optional(
		Type.String({ description: "Override the model workers run (provider/id). Defaults to the lead's model." }),
	),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: `How many workers run at once. Defaults to ${DEFAULT_CONCURRENCY}; raise it freely, there is no hard cap.`,
		}),
	),
});

/**
 * Pre-spawn gate for a dispatch. Pure and synchronous so it is unit-testable without spawning any
 * worker. It refuses only on the two real trust boundaries — no hunt engaged, and `scope.md` not yet
 * authorized — plus an empty batch. It imposes no upper bound on the number of hypotheses: per
 * october's no-caps rule, a large batch is allowed and simply runs.
 */
export function prepareDispatch(cwd: string, rawHypotheses: string[]): { huntDir: string; hypotheses: string[] } {
	const huntDir = findHunt(cwd);
	if (!huntDir) {
		throw new Error("No hunt directory found from the current working directory. Run /hunt <target> first.");
	}
	if (!scopeLooksAuthorized(huntDir)) {
		throw new Error(
			"scope.md is not yet authorized for this hunt. Fill in its authorized targets before dispatching active probes.",
		);
	}
	const hypotheses = rawHypotheses.map((h) => h.trim()).filter(Boolean);
	if (hypotheses.length === 0) {
		throw new Error("No hypotheses provided.");
	}
	return { huntDir, hypotheses };
}

export function registerHuntFleet(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hunt_dispatch",
		label: "Hunt dispatch",
		description: [
			"Fan out hypotheses to parallel whitehat-hunt workers, one isolated october subagent per",
			"hypothesis, running in the active hunt directory. Each worker reads brief.md, tests its one",
			"hypothesis against the live target with a control, and serializes the result to findings.d/.",
			`Runs ${DEFAULT_CONCURRENCY} workers at once by default (raise with 'concurrency'); ${DEFAULT_MAX_TASKS}`,
			"hypotheses per call is typical but not a limit. Workers cannot dispatch further workers. Use",
			"this early and often — bias hard to parallelism.",
		].join(" "),
		parameters: DispatchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { huntDir, hypotheses } = prepareDispatch(ctx.cwd, params.hypotheses);
			const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;

			const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const context = huntContext(huntDir);
			const prompt = await writeWorkerPrompt(WORKER_DOCTRINE);

			let done = 0;
			const results: WorkerResult[] = new Array(hypotheses.length);
			try {
				await mapWithConcurrencyLimit(hypotheses, concurrency, async (hypothesis, index) => {
					const result = await runWorker(
						huntDir,
						params.lane,
						hypothesis,
						model,
						prompt.filePath,
						context,
						signal,
					);
					results[index] = result;
					done++;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `hunt_dispatch [${params.lane}]: ${done}/${hypotheses.length} workers done`,
							},
						],
						details: { lane: params.lane, done, total: hypotheses.length },
					});
					return result;
				});
			} finally {
				try {
					fs.rmSync(prompt.dir, { recursive: true, force: true });
				} catch {
					/* ignore cleanup failure */
				}
			}

			const okCount = results.filter((r) => r.ok).length;
			const summary = results
				.map((r, i) => {
					const status = r.ok ? "ok" : `failed${r.stopReason ? ` (${r.stopReason})` : ""}`;
					return `### worker ${i + 1} [${status}] — ${r.hypothesis}\n${r.output}`;
				})
				.join("\n\n");
			const ledger = summarizeLedger(huntDir);
			return {
				content: [
					{
						type: "text",
						text: `Dispatched ${hypotheses.length} worker(s) on lane "${params.lane}": ${okCount} ok, ${
							hypotheses.length - okCount
						} failed.\n\n${summary}\n\n--- Ledger now ---\n${ledger}`,
					},
				],
				details: { lane: params.lane, ok: okCount, total: hypotheses.length },
			};
		},
	});

	pi.registerTool({
		name: "hunt_status",
		label: "Hunt status",
		description:
			"Read the current hunt's merged ledger: counts by status and severity, confirmed headlines, and dead-end count. Use at the start of every loop tick to check state before acting.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const huntDir = findHunt(ctx.cwd);
			if (!huntDir) {
				throw new Error("No hunt directory found. Run /hunt <target> first.");
			}
			return { content: [{ type: "text", text: summarizeLedger(huntDir) }], details: {} };
		},
	});
}
