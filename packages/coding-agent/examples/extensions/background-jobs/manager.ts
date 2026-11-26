/**
 * Background job manager: owns child processes, their bounded output, and their cleanup for one extension
 * runtime. It has no UI dependency; index.ts adapts it to the tool, the /jobs command, and session events.
 *
 * Lifecycle summary:
 * - A job is launched through the default shell in its own POSIX process group (Windows: a normal child).
 * - The leader's exit and the closure of both output pipes are observed separately. A job is resolved only
 *   when both are observed, or when the 2 s cleanup deadline passes; then its handles are released.
 * - Cancellation sends SIGKILL to the whole POSIX group (Windows: `taskkill /F /T`). When the leader exits on
 *   its own, remaining POSIX group members are killed too, so a shell exit does not abandon its children.
 * - Anything not observed by the deadline makes the job `unreachable`. Such jobs keep their capacity slot
 *   until the runtime is disposed, so failed cleanup cannot be used to start unlimited processes.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig, truncateTail } from "@earendil-works/pi-coding-agent";

/** Jobs that are starting, running, awaiting cleanup, or unreachable. */
export const MAX_ACTIVE_JOBS = 8;
/** Finished records kept for inspection; the oldest is evicted first. */
export const MAX_COMPLETED_JOBS = 32;
/** Decoded output retained per job, in UTF-16 code units (JavaScript string length). */
export const MAX_LOG_CODE_UNITS = 262_144;
export const MAX_COMMAND_LENGTH = 4096;
/** How long cancellation, shutdown, and post-exit cleanup wait for process exit and pipe closure. */
export const CLEANUP_DEADLINE_MS = 2000;

const PREVIEW_LENGTH = 200;
const REASON_LENGTH = 500;
/** Small appends are merged so the retained chunk list stays short. */
const COALESCE_LENGTH = 8192;

export type JobState = "starting" | "running" | "exited" | "failed" | "cancelled" | "unreachable";

/** Bounded, copyable view of a job. Never contains output. */
export interface JobSnapshot {
	id: string;
	/** Command preview, at most 200 characters. */
	command: string;
	cwd: string;
	pid: number | undefined;
	state: JobState;
	/** Leader exit code, once the leader has exited. */
	exitCode: number | null | undefined;
	/** Signal that terminated the leader, once the leader has exited. */
	signal: string | null | undefined;
	/** Why the job failed or is unreachable. */
	reason: string | undefined;
	startedAt: number;
	endedAt: number | undefined;
	/** True while the leader has exited but cleanup of the group and pipes is not finished. */
	cleanupPending: boolean;
	stdoutBytes: number;
	stderrBytes: number;
	/** Absolute cursor where retained output starts. Earlier output was evicted. */
	retainedFrom: number;
	/** Absolute cursor after the last decoded output: total decoded UTF-16 code units. */
	outputEnd: number;
}

export interface LogSlice {
	text: string;
	/** Absolute cursor of the first returned code unit. */
	from: number;
	/** Cursor to pass as `since` on the next read. It never repeats returned output. */
	next: number;
	/** Requested code units that had already been evicted from the retained output. */
	evicted: number;
	/** Retained code units omitted by the line tail or the response size limit. */
	truncated: number;
}

export interface LogReadOptions {
	since?: number;
	tail: number;
	maxBytes: number;
	maxLines: number;
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface JobManagerOptions {
	/** Called once when a job ends on its own. Not called after cancellation or disposal. */
	onSettled?: (job: JobSnapshot) => void;
	/** Process boundary, replaceable in tests. */
	spawn?: SpawnProcess;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	platform?: NodeJS.Platform;
}

interface Job {
	id: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	state: JobState;
	exitCode: number | null | undefined;
	signal: string | null | undefined;
	reason: string | undefined;
	startedAt: number;
	endedAt: number | undefined;
	stdoutBytes: number;
	stderrBytes: number;
	log: OutputLog;
	child: ChildProcess | undefined;
	leaderExited: boolean;
	openStreams: number;
	/** Set once handles are released; later process events are ignored. */
	sealed: boolean;
	/** Cleanup finished: state is final and handles are released. */
	resolved: boolean;
	/** Suppresses the completion callback. */
	cancelRequested: boolean;
	launched: Promise<void>;
	cleanup: Promise<void> | undefined;
	endWaiters: Set<() => void>;
}

function noop(): void {}

function bounded(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether `index` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
	return (
		index > 0 &&
		index < text.length &&
		isLowSurrogate(text.charCodeAt(index)) &&
		isHighSurrogate(text.charCodeAt(index - 1))
	);
}

/** Index where the last `lines` lines of `text` start. A trailing newline does not start an empty line. */
function tailLineStart(text: string, lines: number): number {
	let index = text.endsWith("\n") ? text.length - 1 : text.length;
	for (let count = 0; count < lines; count++) {
		if (index <= 0) return 0;
		const newline = text.lastIndexOf("\n", index - 1);
		if (newline < 0) return 0;
		index = newline;
	}
	return index + 1;
}

/**
 * Decoded output of one job, merged from stdout and stderr in arrival order.
 *
 * Cursors are absolute offsets in UTF-16 code units of everything ever appended. At most `capacity` code units
 * are retained; older text is evicted from the front without splitting a surrogate pair.
 */
export class OutputLog {
	private chunks: string[] = [];
	private retained = 0;
	private start = 0;
	private end = 0;
	private readonly capacity: number;

	constructor(capacity = MAX_LOG_CODE_UNITS) {
		this.capacity = capacity;
	}

	get retainedFrom(): number {
		return this.start;
	}

	get outputEnd(): number {
		return this.end;
	}

	get retainedLength(): number {
		return this.retained;
	}

	append(text: string): void {
		if (text.length === 0) return;
		this.end += text.length;
		this.retained += text.length;
		const last = this.chunks.length - 1;
		if (last >= 0 && this.chunks[last].length + text.length <= COALESCE_LENGTH) this.chunks[last] += text;
		else this.chunks.push(text);
		while (this.retained > this.capacity) {
			const head = this.chunks[0];
			const excess = this.retained - this.capacity;
			if (head.length <= excess) {
				this.chunks.shift();
				this.retained -= head.length;
				this.start += head.length;
				continue;
			}
			const cut = splitsSurrogatePair(head, excess) ? excess + 1 : excess;
			this.chunks[0] = head.slice(cut);
			this.retained -= cut;
			this.start += cut;
			if (this.chunks[0].length === 0) this.chunks.shift();
		}
	}

	/**
	 * Read output at or after `since` (default: all retained output), keep the last `tail` lines, then apply
	 * the byte/line budget from the end. Omitted output is counted, never silently dropped.
	 */
	read(options: LogReadOptions): LogSlice {
		const { since } = options;
		if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
			throw new Error("since must be a non-negative integer cursor.");
		}
		if (since !== undefined && since > this.end) {
			throw new Error(`since ${since} is beyond the end of the output (next cursor is ${this.end}).`);
		}
		const text = this.chunks.join("");
		const requested = since ?? 0;
		const from = Math.max(requested, this.start);
		const offset = from - this.start;
		if (splitsSurrogatePair(text, offset)) {
			throw new Error(`since ${since} falls inside a surrogate pair. Use a cursor returned by a previous read.`);
		}
		const body = text.slice(offset);
		const lineStart = tailLineStart(body, options.tail);
		const tailText = body.slice(lineStart);
		const truncation = truncateTail(tailText, { maxBytes: options.maxBytes, maxLines: options.maxLines });
		let cut = lineStart;
		if (truncation.truncated) {
			// truncateTail returns a suffix of its input without the final newline.
			const contentEnd = tailText.endsWith("\n") ? tailText.length - 1 : tailText.length;
			cut += contentEnd - truncation.content.length;
		}
		return {
			text: body.slice(cut),
			from: from + cut,
			next: this.end,
			evicted: Math.max(0, this.start - requested),
			truncated: cut,
		};
	}
}

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly onSettled: ((job: JobSnapshot) => void) | undefined;
	private readonly spawnProcess: SpawnProcess;
	private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
	private readonly platform: NodeJS.Platform;
	private disposal: Promise<JobSnapshot[]> | undefined;

	constructor(options: JobManagerOptions = {}) {
		this.onSettled = options.onSettled;
		this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
		this.kill =
			options.kill ??
			((pid, signal) => {
				process.kill(pid, signal);
			});
		this.platform = options.platform ?? process.platform;
	}

	get closed(): boolean {
		return this.disposal !== undefined;
	}

	/**
	 * Launch `command` through the default shell in `cwd`. Resolves once the process has spawned (or failed to),
	 * not when it exits. A failed launch keeps its record with state `failed`.
	 */
	async start(command: string, cwd: string, signal?: AbortSignal): Promise<JobSnapshot> {
		if (this.closed) throw new Error("Background jobs are shutting down; new jobs cannot start.");
		if (command.trim().length === 0) throw new Error("command must be a non-empty string.");
		if (command.length > MAX_COMMAND_LENGTH) {
			throw new Error(`command is ${command.length} characters; the limit is ${MAX_COMMAND_LENGTH}.`);
		}
		if (signal?.aborted) throw new Error("Start was aborted before the job was launched.");
		const active = [...this.jobs.values()].filter((job) => !job.resolved || job.state === "unreachable").length;
		if (active >= MAX_ACTIVE_JOBS) {
			throw new Error(
				`${active} jobs are running, awaiting cleanup, or unreachable; the limit is ${MAX_ACTIVE_JOBS}. Cancel a running job first. Unreachable jobs keep their slot until Harness shuts down.`,
			);
		}
		// Reserve the slot synchronously, before anything asynchronous happens.
		const job: Job = {
			id: `job-${randomUUID()}`,
			command: bounded(command, PREVIEW_LENGTH),
			cwd: bounded(cwd, PREVIEW_LENGTH),
			pid: undefined,
			state: "starting",
			exitCode: undefined,
			signal: undefined,
			reason: undefined,
			startedAt: Date.now(),
			endedAt: undefined,
			stdoutBytes: 0,
			stderrBytes: 0,
			log: new OutputLog(),
			child: undefined,
			leaderExited: false,
			openStreams: 2,
			sealed: false,
			resolved: false,
			cancelRequested: false,
			launched: Promise.resolve(),
			cleanup: undefined,
			endWaiters: new Set(),
		};
		this.jobs.set(job.id, job);
		job.launched = this.launch(job, command, cwd);
		await job.launched;
		if (signal?.aborted && !job.resolved) {
			const result = await this.cancel(job.id);
			throw new Error(`Start was aborted while launching; job ${job.id} is now ${result.state}.`);
		}
		return this.snapshot(job);
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].map((job) => this.snapshot(job));
	}

	status(id: string): JobSnapshot {
		return this.snapshot(this.get(id));
	}

	read(id: string, options: LogReadOptions): { job: JobSnapshot; slice: LogSlice } {
		const job = this.get(id);
		return { job: this.snapshot(job), slice: job.log.read(options) };
	}

	/** Kill the job's process group (Windows: process tree) and wait for cleanup. Harmless when repeated. */
	async cancel(id: string): Promise<JobSnapshot> {
		const job = this.get(id);
		if (!job.resolved) {
			job.cancelRequested = true;
			job.cleanup ??= this.finish(job, "cancel", Date.now() + CLEANUP_DEADLINE_MS);
			await job.cleanup;
		}
		return this.snapshot(job);
	}

	/**
	 * Reject new starts, suppress completion callbacks, and clean up every job concurrently within one shared
	 * deadline. Resolves with the jobs whose cleanup could not be confirmed. Repeated calls share the result.
	 */
	dispose(): Promise<JobSnapshot[]> {
		this.disposal ??= this.disposeJobs();
		return this.disposal;
	}

	private async disposeJobs(): Promise<JobSnapshot[]> {
		const deadline = Date.now() + CLEANUP_DEADLINE_MS;
		await Promise.all(
			[...this.jobs.values()].map((job) => {
				if (job.resolved) return undefined;
				job.cancelRequested = true;
				job.cleanup ??= this.finish(job, "cancel", deadline);
				return job.cleanup;
			}),
		);
		return [...this.jobs.values()].filter((job) => job.state === "unreachable").map((job) => this.snapshot(job));
	}

	private get(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) {
			throw new Error(
				`Unknown job ID "${bounded(id, 80)}": no job with this ID is owned by this Harness runtime. It may have been evicted or started by an earlier runtime. This does not tell whether any process has stopped.`,
			);
		}
		return job;
	}

	private snapshot(job: Job): JobSnapshot {
		return {
			id: job.id,
			command: job.command,
			cwd: job.cwd,
			pid: job.pid,
			state: job.state,
			exitCode: job.exitCode,
			signal: job.signal,
			reason: job.reason,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			cleanupPending: !job.resolved && job.leaderExited,
			stdoutBytes: job.stdoutBytes,
			stderrBytes: job.stderrBytes,
			retainedFrom: job.log.retainedFrom,
			outputEnd: job.log.outputEnd,
		};
	}

	private async launch(job: Job, command: string, cwd: string): Promise<void> {
		let child: ChildProcess;
		let commandFromStdin: boolean;
		try {
			const shell = getShellConfig();
			if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			commandFromStdin = shell.commandTransport === "stdin";
			child = this.spawnProcess(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
				cwd,
				// A separate process group lets cancellation reach every POSIX descendant that stays in it.
				detached: this.platform !== "win32",
				env: process.env,
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.failLaunch(job, errorText(error));
			return;
		}
		job.child = child;
		this.attach(job, child);
		if (commandFromStdin) {
			child.stdin?.on("error", noop);
			child.stdin?.end(command);
		}
		const launchError = await new Promise<Error | undefined>((resolve) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve(undefined);
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				resolve(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		if (launchError) {
			this.failLaunch(job, errorText(launchError));
			return;
		}
		job.pid = child.pid;
		job.state = "running";
	}

	private attach(job: Job, child: ChildProcess): void {
		const streams = [
			[child.stdout, "stdoutBytes"],
			[child.stderr, "stderrBytes"],
		] as const;
		for (const [stream, counter] of streams) {
			if (!stream) {
				job.openStreams--;
				continue;
			}
			// One decoder per stream: a character split across chunks stays intact even when the other stream
			// writes in between. Incomplete bytes wait in the decoder and never reach the log.
			const decoder = new StringDecoder("utf8");
			stream.on("data", (chunk: Buffer) => {
				if (job.sealed) return;
				job[counter] += chunk.length;
				job.log.append(decoder.write(chunk));
			});
			stream.on("end", () => {
				if (!job.sealed) job.log.append(decoder.end());
			});
			stream.on("error", noop);
			stream.on("close", () => {
				if (job.sealed) return;
				job.openStreams--;
				this.checkEnded(job);
			});
		}
		child.on("error", (error) => {
			// After a successful spawn this only reports failures of the child handle itself.
			if (!job.sealed && job.state !== "starting") job.reason = bounded(errorText(error), REASON_LENGTH);
		});
		child.on("exit", (code, signal) => {
			if (job.sealed) return;
			job.leaderExited = true;
			job.exitCode = code;
			job.signal = signal;
			if (!job.cleanup) {
				// Report the leader's result now; group and pipe cleanup continue separately.
				job.state = code === 0 ? "exited" : "failed";
				job.cleanup = this.finish(job, "natural", Date.now() + CLEANUP_DEADLINE_MS);
			}
			this.checkEnded(job);
		});
	}

	private failLaunch(job: Job, reason: string): void {
		job.state = "failed";
		job.reason = bounded(reason, REASON_LENGTH);
		job.endedAt = Date.now();
		job.resolved = true;
		this.release(job);
		this.evictCompleted();
	}

	private hasEnded(job: Job): boolean {
		return job.leaderExited && job.openStreams <= 0;
	}

	private checkEnded(job: Job): void {
		if (!this.hasEnded(job)) return;
		for (const resolve of job.endWaiters) resolve();
		job.endWaiters.clear();
	}

	/** Resolves true once leader exit and pipe closure were both observed, false at the deadline. */
	private waitForEnd(job: Job, deadline: number): Promise<boolean> {
		if (this.hasEnded(job)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(
				() => {
					job.endWaiters.delete(done);
					resolve(false);
				},
				Math.max(0, deadline - Date.now()),
			);
			job.endWaiters.add(done);
		});
	}

	private async finish(job: Job, mode: "natural" | "cancel", deadline: number): Promise<void> {
		await job.launched;
		if (job.resolved) return;
		let signalError: string | undefined;
		if (this.platform !== "win32") {
			// Natural exit: kill members the shell left behind. Cancel: kill the whole group.
			signalError = this.signalGroup(job);
		} else if (mode === "cancel" && !job.leaderExited) {
			// An exited leader's PID no longer identifies an owned tree, so taskkill only targets a live leader.
			signalError = await this.taskkill(job, deadline);
		}
		const ended = await this.waitForEnd(job, deadline);
		this.settle(job, mode, ended, signalError);
	}

	/** Returns a factual error, or undefined when signalling was accepted or the group was already absent. */
	private signalGroup(job: Job): string | undefined {
		if (job.pid === undefined) return "the process has no ID, so it cannot be signalled";
		try {
			this.kill(-job.pid, "SIGKILL");
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
			return `kill(-${job.pid}, SIGKILL) failed: ${errorText(error)}`;
		}
	}

	private taskkill(job: Job, deadline: number): Promise<string | undefined> {
		const pid = job.pid;
		if (pid === undefined) return Promise.resolve("the process has no ID, so it cannot be signalled");
		const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		return new Promise((resolve) => {
			let helper: ChildProcess;
			try {
				helper = this.spawnProcess(executable, ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					windowsHide: true,
				});
			} catch (error) {
				resolve(`taskkill could not start: ${errorText(error)}`);
				return;
			}
			const done = (result: string | undefined) => {
				clearTimeout(timer);
				helper.removeAllListeners();
				helper.on("error", noop);
				helper.unref();
				resolve(result);
			};
			// The helper is owned too: at the deadline terminate it instead of leaving it running unobserved.
			const timer = setTimeout(
				() => {
					let terminated = false;
					try {
						terminated = helper.kill();
					} catch {
						// Reported below as a failed termination.
					}
					done(
						`taskkill (pid ${helper.pid}) did not finish within ${CLEANUP_DEADLINE_MS} ms; ${terminated ? "termination of the helper was requested" : "the helper could not be terminated"}`,
					);
				},
				Math.max(0, deadline - Date.now()),
			);
			helper.once("error", (error) => done(`taskkill failed: ${errorText(error)}`));
			helper.once("exit", (code, signal) =>
				done(
					code === 0 ? undefined : `taskkill exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
				),
			);
		});
	}

	private settle(job: Job, mode: "natural" | "cancel", ended: boolean, signalError: string | undefined): void {
		if (job.resolved) return;
		const problems: string[] = [];
		if (!job.leaderExited) problems.push(`process exit was not observed within ${CLEANUP_DEADLINE_MS} ms`);
		if (job.openStreams > 0) problems.push(`output pipes did not close within ${CLEANUP_DEADLINE_MS} ms`);
		if (signalError) problems.push(signalError);
		if (!ended || signalError) {
			const leader = job.leaderExited
				? `leader exited with ${job.exitCode === null ? `signal ${job.signal}` : `code ${job.exitCode}`}; `
				: "";
			job.state = "unreachable";
			job.reason = bounded(
				`${mode === "cancel" ? "cleanup after cancellation" : "cleanup after exit"} not confirmed: ${leader}${problems.join("; ")}`,
				REASON_LENGTH,
			);
		} else if (mode === "cancel") {
			job.state = "cancelled";
		} else {
			job.state = job.exitCode === 0 ? "exited" : "failed";
		}
		job.endedAt = Date.now();
		job.resolved = true;
		this.release(job);
		this.evictCompleted();
		if (mode === "natural" && !job.cancelRequested && !this.closed) this.onSettled?.(this.snapshot(job));
	}

	/** Stop accepting output and release pipes, listeners, and the child handle. */
	private release(job: Job): void {
		job.sealed = true;
		const child = job.child;
		job.child = undefined;
		if (!child) return;
		for (const stream of [child.stdin, child.stdout, child.stderr]) {
			if (!stream) continue;
			stream.removeAllListeners();
			stream.on("error", noop);
			stream.destroy();
		}
		child.removeAllListeners();
		// A still-live child must not crash the host if its handle reports an error later.
		child.on("error", noop);
		child.unref();
	}

	private evictCompleted(): void {
		const completed = [...this.jobs.values()]
			.filter((job) => job.resolved && job.state !== "unreachable")
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		for (const job of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_JOBS))) {
			this.jobs.delete(job.id);
		}
	}
}
