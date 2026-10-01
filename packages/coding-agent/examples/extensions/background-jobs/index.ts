/**
 * Background Jobs Extension - run long-lived commands while the conversation continues.
 *
 * Registers:
 * - a `background_jobs` tool with start, list, status, log, and cancel actions
 * - a `/jobs` command that inspects and cancels jobs without a model call (it cannot start jobs)
 *
 * Starting a job is an ordinary tool call, so it goes through the same `tool_call` permission checks as any
 * other command-class tool. Jobs belong to this extension runtime: every `session_shutdown` (quit, reload,
 * new, resume, fork) attempts to stop them and reports jobs whose cleanup was not confirmed. After a crash,
 * SIGKILL, or machine restart no cleanup runs, so processes may keep running or may die. Job IDs and control
 * are never restored after a restart.
 *
 * See README.md for limits, platform behavior, and security notes.
 */

import { stripVTControlCharacters } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	CLEANUP_DEADLINE_MS,
	JobManager,
	type JobSnapshot,
	type LogSlice,
	MAX_ACTIVE_JOBS,
	MAX_LOG_CODE_UNITS,
} from "./manager.ts";

const DEFAULT_TAIL_LINES = 100;
const COMMAND_TAIL_LINES = 20;
/** Part of the standard tool output budget reserved for the log metadata header. */
const LOG_METADATA_BYTES = 1024;
const LOG_METADATA_LINES = 8;

const ACTIONS = ["start", "list", "status", "log", "cancel"] as const;
type Action = (typeof ACTIONS)[number];
type Field = "command" | "id" | "tail" | "since";
const ACTION_FIELDS: Record<Action, readonly Field[]> = {
	start: ["command"],
	list: [],
	status: ["id"],
	log: ["id", "tail", "since"],
	cancel: ["id"],
};

const BackgroundJobsParams = Type.Object({
	action: StringEnum(ACTIONS, { description: "Operation to perform" }),
	command: Type.Optional(Type.String({ description: "Shell command to run (start only)" })),
	id: Type.Optional(Type.String({ description: "Job ID returned by start (status, log, cancel)" })),
	tail: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: DEFAULT_MAX_LINES,
			description: `Return at most this many trailing lines (log only, default ${DEFAULT_TAIL_LINES})`,
		}),
	),
	since: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Cursor from the previous log result's `next`; returns only newer output (log only)",
		}),
	),
});

type BackgroundJobsInput = Static<typeof BackgroundJobsParams>;

export interface BackgroundJobsDetails {
	action: Action;
	job?: JobSnapshot;
	jobs?: JobSnapshot[];
	log?: Omit<LogSlice, "text">;
}

function validate(params: BackgroundJobsInput): void {
	const allowed = ACTION_FIELDS[params.action];
	if (!allowed) throw new Error(`Unknown action. Use one of: ${ACTIONS.join(", ")}.`);
	const provided: Record<Field, unknown> = {
		command: params.command,
		id: params.id,
		tail: params.tail,
		since: params.since,
	};
	for (const field of Object.keys(provided) as Field[]) {
		if (provided[field] !== undefined && !allowed.includes(field)) {
			throw new Error(
				`${field} is not used by ${params.action}. ${params.action} accepts: ${allowed.join(", ") || "no fields"}.`,
			);
		}
	}
	if (allowed.includes("id") && (typeof params.id !== "string" || params.id.length === 0)) {
		throw new Error(`${params.action} requires id (a job ID returned by start).`);
	}
	if (params.action === "start" && typeof params.command !== "string") {
		throw new Error("start requires command.");
	}
	if (
		params.tail !== undefined &&
		(!Number.isInteger(params.tail) || params.tail < 1 || params.tail > DEFAULT_MAX_LINES)
	) {
		throw new Error(`tail must be an integer from 1 to ${DEFAULT_MAX_LINES}.`);
	}
	if (params.since !== undefined && (!Number.isSafeInteger(params.since) || params.since < 0)) {
		throw new Error("since must be a non-negative integer cursor from a previous log result.");
	}
}

/** Remove terminal control sequences and other control characters before text reaches a display or the model. */
function sanitize(text: string): string {
	let result = "";
	for (const char of stripVTControlCharacters(text)) {
		const code = char.charCodeAt(0);
		if (code === 0x09 || code === 0x0a || (code > 0x1f && code !== 0x7f)) result += char;
	}
	return result;
}

function duration(job: JobSnapshot): string {
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function outcome(job: JobSnapshot): string {
	if (job.exitCode === undefined) return job.state;
	const leader = job.exitCode === null ? `signal ${job.signal}` : `code ${job.exitCode}`;
	return `${job.state} (${leader}${job.cleanupPending ? ", cleanup pending" : ""})`;
}

function summaryLine(job: JobSnapshot): string {
	const pid = job.pid === undefined ? "" : ` pid ${job.pid}`;
	return `${job.id} ${outcome(job)}${pid} ${duration(job)}: ${job.command}`;
}

function formatStatus(job: JobSnapshot): string {
	const lines = [`${job.id}: ${outcome(job)}`, `Command: ${job.command}`, `Directory: ${job.cwd}`];
	if (job.pid !== undefined) lines.push(`PID: ${job.pid}`);
	lines.push(`Started: ${new Date(job.startedAt).toISOString()} (${duration(job)})`);
	if (job.endedAt !== undefined) lines.push(`Ended: ${new Date(job.endedAt).toISOString()}`);
	if (job.reason) lines.push(`Reason: ${job.reason}`);
	lines.push(
		`Output: stdout ${formatSize(job.stdoutBytes)}, stderr ${formatSize(job.stderrBytes)}; retained cursors ${job.retainedFrom}..${job.outputEnd} (UTF-16 code units)`,
	);
	return lines.join("\n");
}

function formatList(jobs: JobSnapshot[]): string {
	if (jobs.length === 0) return "No background jobs.";
	return jobs.map(summaryLine).join("\n");
}

function formatLog(job: JobSnapshot, slice: LogSlice, tail: number): string {
	const header = `[${job.id} ${outcome(job)} | output ${slice.from}..${slice.next} | next ${slice.next}]`;
	const omitted: string[] = [];
	if (slice.evicted > 0) omitted.push(`${slice.evicted} evicted before the retained output`);
	if (slice.truncated > 0) {
		omitted.push(
			`${slice.truncated} outside the ${tail}-line tail or the ${formatSize(DEFAULT_MAX_BYTES)} response limit`,
		);
	}
	const lines = [header];
	if (omitted.length > 0) lines.push(`[omitted UTF-16 code units: ${omitted.join("; ")}]`);
	lines.push(slice.text.length > 0 ? slice.text : "(no new output)");
	return lines.join("\n");
}

function completionText(job: JobSnapshot): string {
	return `Background job ${job.id} ${outcome(job)} after ${duration(job)}: ${job.command.slice(0, 80)}${job.reason ? `\n${job.reason}` : ""}\nUse background_jobs log to read its output.`;
}

export default function backgroundJobs(pi: ExtensionAPI) {
	const manager = new JobManager({
		onSettled: (job) => {
			// Never trigger or steer a turn: during streaming the message is appended after the current turn.
			try {
				pi.sendMessage(
					{
						customType: "background-job",
						content: sanitize(completionText(job)),
						display: true,
						details: { id: job.id, state: job.state, exitCode: job.exitCode, signal: job.signal },
					},
					{ triggerTurn: false },
				);
			} catch {
				// The runtime was replaced; its jobs were disposed and the message has no session to go to.
			}
		},
	});

	pi.registerTool({
		name: "background_jobs",
		label: "Background Jobs",
		description: `Run long-lived shell commands (dev servers, watchers, test loops) in the background and keep working. Actions: start (command) returns a job ID once the process has spawned; list; status (id); log (id, tail lines default ${DEFAULT_TAIL_LINES}, since cursor); cancel (id) kills the job's process group. Up to ${MAX_ACTIVE_JOBS} active jobs. Each job retains its last ${MAX_LOG_CODE_UNITS} UTF-16 code units of output; log results are limited to ${formatSize(DEFAULT_MAX_BYTES)}/${DEFAULT_MAX_LINES} lines and report omitted output. A normal Harness shutdown attempts to stop all jobs and reports any it cannot confirm stopped. After a crash or forced kill, processes may keep running. Job IDs and control are never restored after a restart.`,
		promptSnippet: "Start, inspect, and cancel long-running background processes",
		promptGuidelines: [
			"Use background_jobs start for servers, watchers, and other long-running commands instead of bash with `&`, nohup, or setsid. Keep the command in the foreground of its shell so cancellation reaches it.",
			"Poll background_jobs log with since set to the previous result's next cursor to read only new output.",
			"Cancel background jobs with background_jobs cancel once they are no longer needed.",
		],
		parameters: BackgroundJobsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			validate(params);
			const action = params.action;
			let text: string;
			const details: BackgroundJobsDetails = { action };
			switch (action) {
				case "start": {
					const job = await manager.start(params.command ?? "", ctx.cwd, signal);
					if (job.state === "failed") throw new Error(`Job ${job.id} failed to start: ${job.reason}`);
					details.job = job;
					text = `Started ${job.id}${job.pid === undefined ? "" : ` (pid ${job.pid})`} in ${job.cwd}. It runs in the background; use status, log, or cancel with this ID.`;
					break;
				}
				case "list": {
					details.jobs = manager.list();
					text = formatList(details.jobs);
					break;
				}
				case "status": {
					details.job = manager.status(params.id ?? "");
					text = formatStatus(details.job);
					break;
				}
				case "log": {
					const tail = params.tail ?? DEFAULT_TAIL_LINES;
					const { job, slice } = manager.read(params.id ?? "", {
						since: params.since,
						tail,
						maxBytes: DEFAULT_MAX_BYTES - LOG_METADATA_BYTES,
						maxLines: DEFAULT_MAX_LINES - LOG_METADATA_LINES,
					});
					details.job = job;
					details.log = { from: slice.from, next: slice.next, evicted: slice.evicted, truncated: slice.truncated };
					text = formatLog(job, slice, tail);
					break;
				}
				case "cancel": {
					details.job = await manager.cancel(params.id ?? "");
					text = formatStatus(details.job);
					break;
				}
			}
			return { content: [{ type: "text", text: sanitize(text) }], details };
		},
	});

	const show = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
		const clean = sanitize(text);
		if (ctx.hasUI) ctx.ui.notify(clean, level);
		else process.stderr.write(`${clean}\n`);
	};

	pi.registerCommand("jobs", {
		description: "Inspect or cancel background jobs: /jobs [list | status <id> | log <id> | cancel <id>]",
		handler: async (args, ctx) => {
			const [subcommand = "list", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			const usage = "Usage: /jobs [list | status <id> | log <id> | cancel <id>]";
			try {
				if (subcommand === "start") {
					show(
						ctx,
						"/jobs cannot start processes. Ask the agent to start a job; it runs background_jobs start under your permission settings.",
						"warning",
					);
					return;
				}
				if (subcommand === "list" && id === undefined) {
					show(ctx, formatList(manager.list()), "info");
					return;
				}
				if (id === undefined || extra.length > 0 || !["status", "log", "cancel"].includes(subcommand)) {
					show(ctx, usage, "warning");
					return;
				}
				if (subcommand === "status") show(ctx, formatStatus(manager.status(id)), "info");
				else if (subcommand === "cancel") show(ctx, formatStatus(await manager.cancel(id)), "info");
				else {
					const { job, slice } = manager.read(id, {
						tail: COMMAND_TAIL_LINES,
						maxBytes: DEFAULT_MAX_BYTES - LOG_METADATA_BYTES,
						maxLines: DEFAULT_MAX_LINES - LOG_METADATA_LINES,
					});
					show(ctx, formatLog(job, slice, COMMAND_TAIL_LINES), "info");
				}
			} catch (error) {
				show(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// Any shutdown reason ends this runtime's jobs. A repeated shutdown waits for the same cleanup and stays quiet.
	let shutdown: Promise<void> | undefined;
	pi.on("session_shutdown", (_event, ctx) => {
		shutdown ??= manager.dispose().then((unresolved) => {
			if (unresolved.length === 0) return;
			const lines = unresolved.map(
				(job) => `- ${job.id}${job.pid === undefined ? "" : ` pid ${job.pid}`}: ${job.reason}`,
			);
			show(
				ctx,
				`Background jobs: cleanup was not confirmed within ${CLEANUP_DEADLINE_MS} ms for ${unresolved.length} job(s). Their processes may still be running:\n${lines.join("\n")}`,
				"warning",
			);
		});
		return shutdown;
	});
}
