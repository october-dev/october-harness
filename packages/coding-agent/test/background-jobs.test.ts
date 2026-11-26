// october-dev/october-harness#16: reference background jobs extension, process manager behavior.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLEANUP_DEADLINE_MS,
	JobManager,
	type JobManagerOptions,
	type JobSnapshot,
	MAX_ACTIVE_JOBS,
	MAX_COMPLETED_JOBS,
	MAX_LOG_CODE_UNITS,
	OutputLog,
} from "../examples/extensions/background-jobs/manager.ts";

// Examples import the public package name; resolve it to this checkout's source.
vi.mock("@earendil-works/pi-coding-agent", () => vi.importActual("../src/index.ts"));

const FIXTURE = join(import.meta.dirname, "fixtures", "background-jobs.mjs");
const isWindows = process.platform === "win32";
const READ = { tail: 100, maxBytes: 50 * 1024, maxLines: 2000 };

function quote(value: string): string {
	const normalized = isWindows ? value.replaceAll("\\", "/") : value;
	return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function fixture(...args: string[]): string {
	return [process.execPath, FIXTURE, ...args].map(quote).join(" ");
}

const managers: JobManager[] = [];
const fixturePids = new Set<number>();

function createManager(options: JobManagerOptions = {}): JobManager {
	const manager = new JobManager(options);
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
	for (const pid of fixturePids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	fixturePids.clear();
});

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await delay(10);
	}
}

/** A process is gone when it no longer exists or is a zombie waiting to be reaped. */
function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (process.platform !== "linux") return false;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

function text(manager: JobManager, id: string): string {
	return manager.read(id, READ).slice.text;
}

/** Wait for the fixture's `pids <leader> <grandchild>` line and remember both for cleanup. */
async function fixtureProcessIds(manager: JobManager, id: string): Promise<[number, number]> {
	await until(() => /pids \d+ \d+/.test(text(manager, id)));
	const match = /pids (\d+) (\d+)/.exec(text(manager, id));
	const pids: [number, number] = [Number(match?.[1]), Number(match?.[2])];
	for (const pid of pids) fixturePids.add(pid);
	return pids;
}

async function settled(manager: JobManager, id: string): Promise<JobSnapshot> {
	await until(() => {
		const job = manager.status(id);
		return job.endedAt !== undefined;
	});
	return manager.status(id);
}

class FakeChild extends EventEmitter {
	readonly pid: number;
	readonly stdin = null;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	unrefCalls = 0;
	killCalls = 0;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	unref(): void {
		this.unrefCalls++;
	}

	kill(): boolean {
		this.killCalls++;
		return true;
	}

	finish(code: number): void {
		this.emit("exit", code, null);
		this.stdout.end();
		this.stderr.end();
	}
}

interface FakeSpawn {
	spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
	calls: Array<{ command: string; args: readonly string[]; child: FakeChild }>;
}

/** Spawned fakes acknowledge spawn on the next tick and never exit unless told to. */
function fakeSpawn(onSpawn?: (call: FakeSpawn["calls"][number]) => void): FakeSpawn {
	const calls: FakeSpawn["calls"] = [];
	return {
		calls,
		spawn: (command, args) => {
			const child = new FakeChild(90_000 + calls.length);
			const call = { command, args, child };
			calls.push(call);
			process.nextTick(() => {
				child.emit("spawn");
				onSpawn?.(call);
			});
			return child as unknown as ChildProcess;
		},
	};
}

describe("background jobs: start and identity", () => {
	it("returns a job ID after spawn and before exit, then cancels the process", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("wait"), tmpdir());
		expect(job.id).toMatch(/^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(job.state).toBe("running");
		expect(job.pid).toBeTypeOf("number");
		fixturePids.add(job.pid ?? 0);
		await until(() => text(manager, job.id).includes("ready"));
		expect(manager.status(job.id).state).toBe("running");

		const cancelled = await manager.cancel(job.id);
		expect(cancelled.state).toBe("cancelled");
		await until(() => processGone(job.pid ?? 0));
	});

	it("keeps IDs bound to their own jobs and rejects unknown IDs explicitly", async () => {
		const manager = createManager();
		const first = await manager.start(fixture("exit", "0"), tmpdir());
		const second = await manager.start(fixture("exit", "3"), tmpdir());
		expect(first.id).not.toBe(second.id);
		expect((await settled(manager, first.id)).state).toBe("exited");
		expect((await settled(manager, second.id)).exitCode).toBe(3);
		expect(() => manager.status("job-unknown")).toThrow(
			/Unknown job ID "job-unknown": no job with this ID is owned by this Harness runtime/,
		);
		await expect(manager.cancel("job-unknown")).rejects.toThrow(/Unknown job ID/);
	});

	it("validates commands before spawning", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn });
		await expect(manager.start("   ", tmpdir())).rejects.toThrow(/non-empty/);
		await expect(manager.start("x".repeat(4097), tmpdir())).rejects.toThrow(/limit is 4096/);
		expect(fake.calls).toHaveLength(0);
		expect(manager.list()).toEqual([]);
	});

	it("spawns nothing for a pre-aborted start", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn });
		const controller = new AbortController();
		controller.abort();
		await expect(manager.start("sleep 30", tmpdir(), controller.signal)).rejects.toThrow(/aborted before/);
		expect(fake.calls).toHaveLength(0);
		expect(manager.list()).toEqual([]);
	});

	it("cancels a process whose start is aborted during launch", async () => {
		const controller = new AbortController();
		let pid: number | undefined;
		const manager = createManager({
			spawn: (command, args, options) => {
				const child = spawn(command, args, options);
				pid = child.pid;
				if (pid) fixturePids.add(pid);
				controller.abort();
				return child;
			},
		});
		await expect(manager.start(fixture("wait"), tmpdir(), controller.signal)).rejects.toThrow(
			/aborted while launching; job job-.* is now cancelled/,
		);
		expect(manager.list()[0]?.state).toBe("cancelled");
		await until(() => processGone(pid ?? 0));
	});

	it("does not stop an acknowledged job when the start signal aborts later", async () => {
		const manager = createManager();
		const controller = new AbortController();
		const job = await manager.start(fixture("wait"), tmpdir(), controller.signal);
		fixturePids.add(job.pid ?? 0);
		controller.abort();
		await delay(100);
		expect(manager.status(job.id).state).toBe("running");
	});
});

describe("background jobs: outcomes", () => {
	it("reports exit 0 as exited and exit 3 as failed with one completion each", async () => {
		const completed: JobSnapshot[] = [];
		const manager = createManager({ onSettled: (job) => completed.push(job) });
		const ok = await manager.start(fixture("exit", "0"), tmpdir());
		const bad = await manager.start(fixture("exit", "3"), tmpdir());
		expect(await settled(manager, ok.id)).toMatchObject({ state: "exited", exitCode: 0, cleanupPending: false });
		expect(await settled(manager, bad.id)).toMatchObject({ state: "failed", exitCode: 3 });
		await delay(50);
		expect(completed.map((job) => job.id).sort()).toEqual([ok.id, bad.id].sort());
		// Completion snapshots carry no output.
		expect(JSON.stringify(completed)).not.toContain("exiting with");
	});

	it("reports a missing working directory as a failed start", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn });
		const job = await manager.start("true", join(tmpdir(), "background-jobs-missing-dir"));
		expect(job).toMatchObject({
			state: "failed",
			reason: expect.stringContaining("Working directory does not exist"),
		});
		expect(fake.calls).toHaveLength(0);
	});

	it("reports a spawn error as failed with its reason", async () => {
		const manager = createManager({
			spawn: () => {
				const child = new FakeChild(0);
				process.nextTick(() =>
					child.emit("error", Object.assign(new Error("spawn bash ENOENT"), { code: "ENOENT" })),
				);
				return child as unknown as ChildProcess;
			},
		});
		const job = await manager.start("true", tmpdir());
		expect(job).toMatchObject({ state: "failed", reason: "spawn bash ENOENT" });
		expect(manager.status(job.id).endedAt).toBeDefined();
	});

	it("reports a leader killed by a signal as failed", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("wait"), tmpdir());
		fixturePids.add(job.pid ?? 0);
		await until(() => text(manager, job.id).includes("ready"));
		process.kill(job.pid ?? 0, "SIGKILL");
		expect(await settled(manager, job.id)).toMatchObject({ state: "failed", exitCode: null });
	});
});

describe.skipIf(isWindows)("background jobs: POSIX process groups", () => {
	it("cancel kills the leader and a grandchild, and repeating it is harmless", async () => {
		const completed: JobSnapshot[] = [];
		const manager = createManager({ onSettled: (job) => completed.push(job) });
		const job = await manager.start(fixture("grandchild"), tmpdir());
		const [leader, grandchild] = await fixtureProcessIds(manager, job.id);

		expect((await manager.cancel(job.id)).state).toBe("cancelled");
		await until(() => processGone(leader) && processGone(grandchild));
		expect((await manager.cancel(job.id)).state).toBe("cancelled");
		await delay(50);
		expect(completed).toEqual([]);
	});

	it("kills a quiet descendant left behind when the leader exits", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("leader-exit-quiet"), tmpdir());
		const [, grandchild] = await fixtureProcessIds(manager, job.id);
		expect(await settled(manager, job.id)).toMatchObject({ state: "exited", exitCode: 0 });
		await until(() => processGone(grandchild));
	});

	it("observes leader exit while a descendant holds the pipes, then cleans the group", async () => {
		const completed: JobSnapshot[] = [];
		const manager = createManager({ onSettled: (job) => completed.push(job) });
		const job = await manager.start(fixture("leader-exit-active"), tmpdir());
		const [, grandchild] = await fixtureProcessIds(manager, job.id);
		const result = await settled(manager, job.id);
		expect(result).toMatchObject({ state: "exited", exitCode: 0, cleanupPending: false });
		expect(result.endedAt ?? 0).toBeLessThan(Date.now() + 1);
		await until(() => processGone(grandchild));
		await delay(50);
		expect(completed).toHaveLength(1);
	});

	it("reports a signalling error unchanged and keeps the job unreachable", async () => {
		const manager = createManager({
			kill: () => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			},
		});
		const job = await manager.start(fixture("wait"), tmpdir());
		fixturePids.add(job.pid ?? 0);
		const result = await manager.cancel(job.id);
		expect(result.state).toBe("unreachable");
		expect(result.reason).toContain(`kill(-${job.pid}, SIGKILL) failed: EPERM: operation not permitted`);
		expect(result.reason).toContain("process exit was not observed");
	});

	it("treats an already absent group as cleaned up", async () => {
		const manager = createManager({
			kill: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
		});
		const job = await manager.start(fixture("exit-after", "100", "0"), tmpdir());
		fixturePids.add(job.pid ?? 0);
		expect((await manager.cancel(job.id)).state).toBe("cancelled");
	});
});

describe("background jobs: capacity and eviction", () => {
	it("rejects a ninth active job before spawning, including concurrent starts", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, kill: () => {} });
		const results = await Promise.allSettled(
			Array.from({ length: MAX_ACTIVE_JOBS + 1 }, () => manager.start("sleep 30", tmpdir())),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(MAX_ACTIVE_JOBS);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" && String(rejected.reason)).toMatch(/limit is 8/);
		expect(fake.calls).toHaveLength(MAX_ACTIVE_JOBS);
	});

	it("keeps unconfirmed cleanup against capacity", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, kill: () => {} });
		const jobs = await Promise.all(
			Array.from({ length: MAX_ACTIVE_JOBS }, () => manager.start("sleep 30", tmpdir())),
		);
		const cancelled = await Promise.all(jobs.map((job) => manager.cancel(job.id)));
		expect(cancelled.every((job) => job.state === "unreachable")).toBe(true);
		await expect(manager.start("sleep 30", tmpdir())).rejects.toThrow(/Unreachable jobs keep their slot/);
		expect(fake.calls).toHaveLength(MAX_ACTIVE_JOBS);
	});

	it(`keeps ${MAX_COMPLETED_JOBS} completed records, evicts the oldest, and never reuses IDs`, async () => {
		const fake = fakeSpawn((call) => call.child.finish(0));
		const manager = createManager({ spawn: fake.spawn, kill: () => {} });
		const ids: string[] = [];
		for (let index = 0; index < MAX_COMPLETED_JOBS + 2; index++) {
			const job = await manager.start("true", tmpdir());
			ids.push(job.id);
			await settled(manager, job.id);
		}
		expect(new Set(ids).size).toBe(ids.length);
		expect(manager.list().map((job) => job.id)).toEqual(ids.slice(2));
		expect(() => manager.status(ids[0])).toThrow(/Unknown job ID/);
	});
});

describe("background jobs: cleanup deadline and late events", () => {
	it("marks accepted signalling without exit or pipe closure unreachable and releases handles", async () => {
		const completed: JobSnapshot[] = [];
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, kill: () => {}, onSettled: (job) => completed.push(job) });
		const job = await manager.start("sleep 30", tmpdir());
		const started = Date.now();
		const result = await manager.cancel(job.id);
		expect(Date.now() - started).toBeGreaterThanOrEqual(CLEANUP_DEADLINE_MS - 50);
		expect(result.state).toBe("unreachable");
		expect(result.reason).toContain("process exit was not observed within 2000 ms");
		expect(result.reason).toContain("output pipes did not close within 2000 ms");
		const child = fake.calls[0].child;
		expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
		expect(child.unrefCalls).toBe(1);

		// Late events cannot resurrect the record or produce a completion message.
		child.emit("exit", 0, null);
		child.stdout.emit("data", Buffer.from("late"));
		expect(manager.status(job.id)).toMatchObject({ state: "unreachable", outputEnd: 0 });
		expect(completed).toEqual([]);
	});

	it("reports a natural exit whose pipes stay open as unreachable in its single completion", async () => {
		const completed: JobSnapshot[] = [];
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, kill: () => {}, onSettled: (job) => completed.push(job) });
		const job = await manager.start("true", tmpdir());
		fake.calls[0].child.emit("exit", 0, null);
		expect(manager.status(job.id)).toMatchObject({ state: "exited", exitCode: 0, cleanupPending: true });
		await until(() => completed.length > 0, 5000);
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({ state: "unreachable", exitCode: 0 });
		expect(completed[0].reason).toContain("cleanup after exit not confirmed: leader exited with code 0");
	});

	it("dispose rejects new starts and cleans up every job within one shared deadline", async () => {
		const completed: JobSnapshot[] = [];
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, kill: () => {}, onSettled: (job) => completed.push(job) });
		const jobs = await Promise.all([1, 2, 3].map(() => manager.start("sleep 30", tmpdir())));
		const started = Date.now();
		const disposal = manager.dispose();
		await expect(manager.start("true", tmpdir())).rejects.toThrow(/shutting down/);
		const unresolved = await disposal;
		expect(Date.now() - started).toBeLessThan(CLEANUP_DEADLINE_MS * 2);
		expect(unresolved.map((job) => job.id).sort()).toEqual(jobs.map((job) => job.id).sort());
		expect(await manager.dispose()).toBe(unresolved);
		for (const call of fake.calls) call.child.finish(0);
		expect(completed).toEqual([]);
	});

	it("suppresses completion messages for jobs that finish during disposal", async () => {
		const completed: JobSnapshot[] = [];
		const fake = fakeSpawn();
		const manager = createManager({
			spawn: fake.spawn,
			kill: () => fake.calls[0].child.finish(137),
			onSettled: (job) => completed.push(job),
		});
		const job = await manager.start("sleep 30", tmpdir());
		expect(await manager.dispose()).toEqual([]);
		expect(manager.status(job.id).state).toBe("cancelled");
		expect(completed).toEqual([]);
	});
});

describe.runIf(isWindows)("background jobs: Windows process trees", () => {
	it("cancel kills the leader and a grandchild with taskkill /T", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("grandchild"), tmpdir());
		const [leader, grandchild] = await fixtureProcessIds(manager, job.id);
		expect((await manager.cancel(job.id)).state).toBe("cancelled");
		await until(() => processGone(leader) && processGone(grandchild));
	});
});

describe("background jobs: Windows tree cancellation (mocked)", () => {
	it("cancels a live leader with taskkill /F /T", async () => {
		const fake = fakeSpawn((call) => {
			if (call.command.endsWith("taskkill.exe")) {
				call.child.emit("exit", 0, null);
				fake.calls[0].child.finish(1);
			}
		});
		const manager = createManager({ spawn: fake.spawn, platform: "win32" });
		const job = await manager.start("sleep 30", tmpdir());
		expect((await manager.cancel(job.id)).state).toBe("cancelled");
		expect(fake.calls[1].command).toMatch(/System32[\\/]taskkill\.exe$/);
		expect(fake.calls[1].args).toEqual(["/F", "/T", "/PID", String(job.pid)]);
	});

	it("reports a failing taskkill unchanged", async () => {
		const fake = fakeSpawn((call) => {
			if (call.command.endsWith("taskkill.exe")) call.child.emit("exit", 128, null);
		});
		const manager = createManager({ spawn: fake.spawn, platform: "win32" });
		const job = await manager.start("sleep 30", tmpdir());
		const result = await manager.cancel(job.id);
		expect(result.state).toBe("unreachable");
		expect(result.reason).toContain("taskkill exited with code 128");
	});

	it("terminates and releases a taskkill helper that does not finish by the deadline", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, platform: "win32" });
		const job = await manager.start("sleep 30", tmpdir());
		const started = Date.now();
		const result = await manager.cancel(job.id);
		// One shared deadline: the helper timeout does not extend cleanup.
		expect(Date.now() - started).toBeLessThan(CLEANUP_DEADLINE_MS + 500);
		const helper = fake.calls[1].child;
		expect(helper.killCalls).toBe(1);
		expect(helper.unrefCalls).toBe(1);
		expect(helper.listenerCount("exit")).toBe(0);
		expect(helper.listenerCount("error")).toBe(1);
		expect(result.state).toBe("unreachable");
		expect(result.reason).toContain(
			`taskkill (pid ${helper.pid}) did not finish within ${CLEANUP_DEADLINE_MS} ms; termination of the helper was requested`,
		);
	});

	it("never runs taskkill against a leader that already exited", async () => {
		const fake = fakeSpawn();
		const manager = createManager({ spawn: fake.spawn, platform: "win32" });
		const finished = await manager.start("true", tmpdir());
		fake.calls[0].child.finish(0);
		expect(await settled(manager, finished.id)).toMatchObject({ state: "exited" });

		const lingering = await manager.start("true", tmpdir());
		fake.calls[1].child.emit("exit", 0, null);
		const result = await manager.cancel(lingering.id);
		expect(result.state).toBe("unreachable");
		expect(fake.calls.filter((call) => call.command.endsWith("taskkill.exe"))).toEqual([]);
	});
});

describe("background jobs: bounded output", () => {
	it("drains both streams of a 5 MB flood and retains at most the cap", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("flood", String(5 * 1024 * 1024)), tmpdir());
		const result = await settled(manager, job.id);
		expect(result.state).toBe("exited");
		expect(result.stdoutBytes).toBeGreaterThan(2 * 1024 * 1024);
		expect(result.stderrBytes).toBeGreaterThan(2 * 1024 * 1024);
		expect(result.outputEnd).toBe(result.stdoutBytes + result.stderrBytes);
		expect(result.outputEnd - result.retainedFrom).toBeLessThanOrEqual(MAX_LOG_CODE_UNITS);

		const { slice } = manager.read(job.id, READ);
		expect(Buffer.byteLength(slice.text)).toBeLessThanOrEqual(READ.maxBytes);
		expect(slice.evicted).toBe(result.retainedFrom);
		expect(slice.from + slice.text.length).toBe(slice.next);
		expect(slice.evicted + slice.truncated + slice.text.length).toBe(slice.next);
	});

	it("keeps one character intact when its UTF-8 bytes are split around stderr output", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("split-utf8"), tmpdir());
		await settled(manager, job.id);
		const output = text(manager, job.id);
		expect(output).toContain("\u{1F600}");
		expect(output).toContain("E");
		expect(output).not.toContain("�");
	});

	it("tails a huge line without newlines within the byte budget", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("big-line", "600000"), tmpdir());
		await settled(manager, job.id);
		const { slice } = manager.read(job.id, READ);
		expect(slice.text).toBe("y".repeat(READ.maxBytes));
		expect(slice.evicted).toBe(600_000 - MAX_LOG_CODE_UNITS);
		expect(slice.truncated).toBe(MAX_LOG_CODE_UNITS - READ.maxBytes);
	});

	it("polls with next cursors without repeating output", async () => {
		const manager = createManager();
		const job = await manager.start(fixture("lines", "3"), tmpdir());
		await settled(manager, job.id);
		const first = manager.read(job.id, { ...READ, tail: 2 }).slice;
		expect(first).toMatchObject({ text: "line 2\nline 3\n", truncated: 7, evicted: 0 });
		expect(manager.read(job.id, { ...READ, since: first.next }).slice).toMatchObject({ text: "", from: first.next });
		expect(() => manager.read(job.id, { ...READ, since: first.next + 1 })).toThrow(/beyond the end/);
	});
});

describe("background jobs: output log cursors", () => {
	it("returns only new output after a cursor and the default line tail", () => {
		const log = new OutputLog();
		log.append(Array.from({ length: 150 }, (_, index) => `line ${index + 1}\n`).join(""));
		const first = log.read(READ);
		expect(first.text.split("\n").filter(Boolean)).toHaveLength(100);
		expect(first.text.startsWith("line 51\n")).toBe(true);
		log.append("line 151\n");
		const second = log.read({ ...READ, since: first.next });
		expect(second).toMatchObject({ text: "line 151\n", from: first.next, evicted: 0, truncated: 0 });
	});

	it("caps an oversized single append and reports evicted code units", () => {
		const log = new OutputLog();
		log.append("z".repeat(MAX_LOG_CODE_UNITS + 1000));
		expect(log.retainedLength).toBe(MAX_LOG_CODE_UNITS);
		expect(log.retainedFrom).toBe(1000);
		const slice = log.read({ ...READ, since: 10 });
		expect(slice.evicted).toBe(990);
		expect(slice.from + slice.text.length).toBe(slice.next);
	});

	it("enforces the cap on every append without unbounded chunks", () => {
		const log = new OutputLog(1000);
		for (let index = 0; index < 5000; index++) log.append("ab");
		expect(log.retainedLength).toBe(1000);
		expect(log.retainedFrom).toBe(9000);
		expect(log.read({ ...READ, tail: 1 }).text).toBe("ab".repeat(500));
	});

	it("rejects cursors inside a retained surrogate pair", () => {
		const log = new OutputLog();
		log.append("x\u{1F600}y");
		expect(() => log.read({ ...READ, since: 2 })).toThrow(/surrogate pair/);
		expect(log.read({ ...READ, since: 1 }).text).toBe("\u{1F600}y");
		expect(log.read({ ...READ, since: 3 }).text).toBe("y");
		expect(() => log.read({ ...READ, since: -1 })).toThrow(/non-negative/);
		expect(() => log.read({ ...READ, since: 1.5 })).toThrow(/non-negative/);
	});

	it("never leaves a lone low surrogate when evicting from the front", () => {
		const log = new OutputLog(3);
		log.append("a\u{1F600}");
		log.append("b");
		expect(log.read(READ).text).toBe("\u{1F600}b");
		log.append("c");
		const slice = log.read(READ);
		expect(slice.text).toBe("bc");
		expect(slice.evicted).toBe(3);
		expect(slice.from + slice.text.length).toBe(slice.next);
	});
});
