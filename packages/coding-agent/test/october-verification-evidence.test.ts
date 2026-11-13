import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashResult } from "../src/core/bash-executor.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { createRejectingShellOperations } from "../src/core/shell-runner.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import {
	attachVerificationReference,
	BUS_COMPLETE_TASK_TOOL,
	BUS_MAX_CONTEXT_ITEMS,
	BUS_MAX_CONTEXT_TEXT_BYTES,
	BUS_MAX_CONTEXT_TOTAL_BYTES,
	BUS_MAX_NOTE_BYTES,
	BUS_MESSAGE_PEER_TOOL,
	type CodeIdentity,
	findKeyedAttachment,
	isCodeIdentityStale,
	isUsableGitResult,
	parseGitStatusEntries,
	registerVerificationEvidence,
	runVerification,
	stripReservedContextItems,
	stripReservedNoteLines,
	toVerificationReference,
	VERIFICATION_ATTACHMENT_ENTRY,
	VERIFICATION_CONTEXT_TITLE,
	VERIFICATION_ENTRY,
	VERIFICATION_SHARE_ENTRY,
	type VerificationBashRunner,
	type VerificationEvidence,
	verificationContextItem,
	verificationResultLine,
	verificationStale,
	violatedContextBudgets,
} from "../src/extensions/october/verification-evidence.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function repo(): string {
	const cwd = join(tmpdir(), `october-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	directories.push(cwd);
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "verify@example.com"]);
	git(cwd, ["config", "user.name", "Verify"]);
	git(cwd, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(cwd, "README.md"), "checked\n");
	git(cwd, ["add", "README.md"]);
	git(cwd, ["commit", "-m", "init"]);
	return cwd;
}

function scratch(): string {
	const cwd = join(tmpdir(), `october-verify-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	directories.push(cwd);
	return cwd;
}

/** Forward slashes embed safely in node -e single-quoted strings on every platform. */
function fwd(path: string): string {
	return path.split("\\").join("/");
}

function localRunner(cwd: string): VerificationBashRunner {
	const operations = createLocalBashOperations();
	return (command: string) => executeBashWithOperations(command, cwd, operations, {});
}

function stubRunner(result: BashResult): VerificationBashRunner & { calls: string[] } {
	const calls: string[] = [];
	const runner = (async (command: string) => {
		calls.push(command);
		return result;
	}) as VerificationBashRunner & { calls: string[] };
	runner.calls = calls;
	return runner;
}

function latestEvidenceEntry(harness: Harness): VerificationEvidence | undefined {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((candidate) => candidate.type === "custom" && candidate.customType === VERIFICATION_ENTRY);
	return entry && entry.type === "custom" ? (entry.data as VerificationEvidence) : undefined;
}

async function emitToolCall(harness: Harness, toolName: string, toolCallId: string, input: Record<string, unknown>) {
	await harness.session.extensionRunner.emitToolCall({ type: "tool_call", toolName, toolCallId, input });
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
	const started = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function bindVerify(harness: Harness, notify?: ExtensionUIContext["notify"]) {
	await harness.session.bindExtensions({
		mode: "print",
		uiContext: createTestUiContext(notify ? { notify } : {}),
	});
}

/** A git checkout inside the harness working directory, so freshness compares against it. */
async function gitRepoHarness(notify?: ExtensionUIContext["notify"]): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
	});
	harnesses.push(harness);
	await bindVerify(harness, notify);
	const cwd = harness.tempDir;
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "verify@example.com"]);
	git(cwd, ["config", "user.name", "Verify"]);
	git(cwd, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(cwd, "README.md"), "checked\n");
	git(cwd, ["add", "README.md"]);
	git(cwd, ["commit", "-m", "init"]);
	return harness;
}

interface FixtureSendInput {
	to: string;
	body: string;
	mode?: string;
	responseTo?: string;
	expiresInMs?: number;
	idempotencyKey?: string;
	context?: unknown[];
}

/**
 * The Bus receive path the hook must satisfy, mirroring pinned Bus v0.1.0-rc.4 with
 * its own literals (validation.go, runtime.go, store.go): context budgets, whole-
 * context request hashing, same-key receipt recovery, same-key conflict on content
 * change, and one response per request. Tests drive hook output through this instead
 * of asserting helper state alone.
 */
class LocalBusFixture {
	private receipts = new Map<string, { hash: string; receipt: string }>();
	private answered = new Set<string>();
	private sent = 0;

	private static fieldBytes(value: unknown): number {
		return typeof value === "string" ? Buffer.byteLength(value, "utf-8") : 0;
	}

	send(input: FixtureSendInput): { status: "accepted" | "duplicate"; receipt: string } {
		const context = Array.isArray(input.context) ? input.context : [];
		if (context.length > 32) throw new Error("context exceeds 32 items");
		let total = 0;
		for (const entry of context) {
			if (!entry || typeof entry !== "object") throw new Error("context entry is invalid");
			const record = entry as Record<string, unknown>;
			if (!["text", "file", "url", "reference"].includes(record.kind as string)) {
				throw new Error("context kind is invalid");
			}
			if (typeof record.title !== "string" || !record.title.trim() || Buffer.byteLength(record.title) > 512) {
				throw new Error("context title is invalid");
			}
			if (LocalBusFixture.fieldBytes(record.text) > 65536) throw new Error("context text exceeds 65536 bytes");
			if (LocalBusFixture.fieldBytes(record.uri) > 4096) throw new Error("context uri exceeds 4096 bytes");
			total +=
				LocalBusFixture.fieldBytes(record.title) +
				LocalBusFixture.fieldBytes(record.text) +
				LocalBusFixture.fieldBytes(record.uri) +
				LocalBusFixture.fieldBytes(record.mediaType);
		}
		if (total > 262144) throw new Error("context exceeds 256 KiB");
		const hash = createHash("sha256")
			.update(
				JSON.stringify({
					to: input.to,
					body: input.body,
					mode: input.mode ?? "",
					responseTo: input.responseTo ?? "",
					expiresInMs: input.expiresInMs ?? 0,
					context,
				}),
			)
			.digest("hex");
		if (input.idempotencyKey) {
			const previous = this.receipts.get(input.idempotencyKey);
			if (previous) {
				if (previous.hash !== hash) {
					throw new Error("Idempotency key was already used with different message content");
				}
				return { status: "duplicate", receipt: previous.receipt };
			}
		}
		if (input.mode === "response" && input.responseTo) {
			if (this.answered.has(input.responseTo)) throw new Error("The request already has a response");
			this.answered.add(input.responseTo);
		}
		this.sent += 1;
		const receipt = `receipt-${this.sent}`;
		if (input.idempotencyKey) this.receipts.set(input.idempotencyKey, { hash, receipt });
		return { status: "accepted", receipt };
	}

	completeTask(note: string): void {
		if (Buffer.byteLength(note, "utf-8") > 16384) throw new Error("note exceeds 16384 bytes");
	}
}

/** Post-hook `message_peer` input in the shape the Bus hashes. */
function busSendInput(hookInput: Record<string, unknown>): FixtureSendInput {
	return {
		to: String(hookInput.peer ?? ""),
		body: String(hookInput.message ?? ""),
		mode: typeof hookInput.mode === "string" ? hookInput.mode : undefined,
		responseTo: typeof hookInput.responseTo === "string" ? hookInput.responseTo : undefined,
		expiresInMs: typeof hookInput.expiresInMs === "number" ? hookInput.expiresInMs : undefined,
		idempotencyKey: typeof hookInput.idempotencyKey === "string" ? hookInput.idempotencyKey : undefined,
		context: Array.isArray(hookInput.context) ? hookInput.context : [],
	};
}

describe("verification evidence", () => {
	// #44: git -z rename entries carry the destination first; hashing the old name is invisible.
	it("parses rename destinations first from porcelain status", () => {
		expect(
			parseGitStatusEntries(
				"R  new.ts\0old.ts\0C  copy.ts\0orig.ts\0 M keep.ts\0D  gone.ts\0 D lost.ts\0UU both.ts\0?? fresh.ts\0?? ..config\0",
			),
		).toEqual([
			{ path: "new.ts", deleted: false },
			{ path: "copy.ts", deleted: false },
			{ path: "keep.ts", deleted: false },
			{ path: "gone.ts", deleted: true },
			{ path: "lost.ts", deleted: true },
			{ path: "both.ts", deleted: false },
			{ path: "fresh.ts", deleted: false },
			{ path: "..config", deleted: false },
		]);
	});

	// #44: incomplete comparisons are unknown, unless another captured fact proves a change.
	it("reports unknown for incomplete identities without hiding proven changes", () => {
		const clean: CodeIdentity = { available: true, revision: "aaa", dirty: false, files: [], filesTruncated: false };
		const truncated: CodeIdentity = { ...clean, dirty: true, filesTruncated: true };
		const moved: CodeIdentity = { ...clean, revision: "bbb" };
		const missing: CodeIdentity = { ...clean, available: false };
		expect(isCodeIdentityStale(truncated, { ...truncated })).toBeNull();
		expect(isCodeIdentityStale(truncated, moved)).toBe(true);
		expect(isCodeIdentityStale(clean, missing)).toBeNull();
		expect(isCodeIdentityStale(clean, { ...clean })).toBe(false);
	});

	// #44: the outcome is the observed process result.
	it("records success, failure, and empty output from the process", async () => {
		const cwd = repo();
		const runner = localRunner(cwd);
		const success = await runVerification({ command: 'node -e "console.log(1+1)"', cwd, runner });
		expect(success.outcome).toBe("success");
		expect(success.exitStatus).toBe(0);
		expect(success.output.text).toContain("2");
		expect(success.changedDuringRun).toBe(false);
		expect(success.code.available).toBe(true);
		expect(success.code.dirty).toBe(false);
		expect(success.code.revision).toMatch(/^[0-9a-f]{40}$/);

		const quiet = await runVerification({ command: 'node -e "process.exit(0)"', cwd, runner });
		expect(quiet.outcome).toBe("success");
		expect(quiet.output.text).toBe("");

		const failed = await runVerification({ command: 'node -e "process.exit(3)"', cwd, runner });
		expect(failed.outcome).toBe("failed");
		expect(failed.exitStatus).toBe(3);

		const hidden = await verificationContextItem(success);
		expect(hidden.title).toBe(VERIFICATION_CONTEXT_TITLE);
		expect(JSON.parse(hidden.text).outputPreview).toBeUndefined();
		const shared = await verificationContextItem(success, { shareOutput: true });
		expect(JSON.parse(shared.text).outputPreview).toContain("2");
	});

	// #44: a signal-killed command reports no exit status; that is never success.
	it("treats signal termination and missing exit status as failure", async () => {
		const cwd = repo();
		const killed = await runVerification({
			command: "node -e \"process.kill(process.pid, 'SIGKILL')\"",
			cwd,
			runner: localRunner(cwd),
		});
		expect(killed.outcome).toBe("failed");
		expect(typeof killed.exitStatus).toBe("number");
		expect(killed.exitStatus).not.toBe(0);

		const nullStatus = stubRunner({ output: "", exitCode: undefined, cancelled: false, truncated: false });
		const missing = await runVerification({ command: "whatever", cwd, runner: nullStatus });
		expect(missing.outcome).toBe("failed");
		expect(missing.exitStatus).toBeNull();
	});

	// #44: an aborted signal cancels before spawning.
	it("cancels before spawning when already aborted", async () => {
		const runner = stubRunner({ output: "", exitCode: 0, cancelled: false, truncated: false });
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runVerification({
			command: "whatever",
			cwd: scratch(),
			runner,
			signal: controller.signal,
		});
		expect(cancelled.outcome).toBe("cancelled");
		expect(cancelled.exitStatus).toBeNull();
		expect(runner.calls).toHaveLength(0);
	});

	// #44: a storage limit truncates retained output; it never fails the check.
	it("keeps bounded output without failing the command", async () => {
		const cwd = repo();
		const big = await runVerification({
			command: "node -e \"process.stdout.write('z'.repeat(100000))\"",
			cwd,
			runner: localRunner(cwd),
		});
		expect(big.outcome).toBe("success");
		expect(big.exitStatus).toBe(0);
		expect(big.output.truncated).toBe(true);
		expect(big.output.text.length).toBeLessThan(100_000);
		expect(big.fullOutputPath).toBeDefined();
	});

	// #44: a runner that refuses the command is honored; nothing falls back to the host.
	it("records unknown with the rejection when the runner refuses", async () => {
		const runner: VerificationBashRunner = async () => {
			throw new Error("Shell runner: blocked. Test rejection.");
		};
		const evidence = await runVerification({ command: "whatever", cwd: repo(), runner });
		expect(evidence.outcome).toBe("unknown");
		expect(evidence.exitStatus).toBeNull();
		expect(evidence.error).toContain("blocked");
	});

	// #44: status paths resolve from the repository root, not the session directory.
	it("resolves already-dirty files from the repository root in subdirectories", async () => {
		const root = repo();
		const cwd = join(root, "pkg");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "file.ts"), "before\n");
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.available).toBe(true);
		expect(evidence.code.files.map((file) => file.path)).toContain("pkg/src/file.ts");
		expect(await verificationStale(evidence)).toBe(false);
		writeFileSync(join(cwd, "src", "file.ts"), "after\n");
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: a staged rename identifies the destination; edits to it are visible.
	it("follows staged renames to the destination", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "old.ts"), "before\n");
		git(cwd, ["add", "old.ts"]);
		git(cwd, ["commit", "-m", "add old"]);
		git(cwd, ["mv", "old.ts", "new.ts"]);
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.files.map((file) => file.path)).toContain("new.ts");
		writeFileSync(join(cwd, "new.ts"), "after\n");
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: untracked directories expand to files; edits inside them are visible.
	it("hashes inside untracked directories", async () => {
		const cwd = repo();
		mkdirSync(join(cwd, "newdir"), { recursive: true });
		writeFileSync(join(cwd, "newdir", "inside.ts"), "before\n");
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.files.map((file) => file.path)).toContain("newdir/inside.ts");
		writeFileSync(join(cwd, "newdir", "inside.ts"), "after\n");
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: names starting with two dots are ordinary files, not parent escapes.
	it("keeps two-dot filenames in the identity", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "..config"), "before\n");
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.available).toBe(true);
		expect(evidence.code.files.map((file) => file.path)).toContain("..config");
		writeFileSync(join(cwd, "..config"), "after\n");
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: only a known deletion has a useful "missing" identity; unreadable state is unknown.
	it.runIf(process.platform !== "win32")("reports unknown for unreadable files", async () => {
		const cwd = repo();
		const target = join(cwd, "secret.ts");
		writeFileSync(target, "before\n");
		chmodSync(target, 0o000);
		try {
			const evidence = await runVerification({
				command: 'node -e "process.exit(0)"',
				cwd,
				runner: localRunner(cwd),
			});
			expect(evidence.code.available).toBe(false);
			expect(await verificationStale(evidence)).toBeNull();
		} finally {
			chmodSync(target, 0o644);
		}
	});

	// #44: past the file cap the comparison is incomplete, so freshness is unknown.
	it("reports unknown past the dirty-file cap", async () => {
		const cwd = repo();
		for (let index = 0; index < 101; index++) {
			writeFileSync(join(cwd, `bulk-${String(index).padStart(3, "0")}.txt`), "bulk\n");
		}
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.filesTruncated).toBe(true);
		expect(await verificationStale(evidence)).toBeNull();
	});

	// #44: the check observes the process, not the tree it leaves behind. A command that
	// writes files itself (formatter, snapshot update) trips this by design.
	it("flags trees that changed during the run instead of calling them current", async () => {
		const cwd = repo();
		const evidence = await runVerification({
			command: "node -e \"require('fs').writeFileSync('gen.txt','x')\"",
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.outcome).toBe("success");
		expect(evidence.changedDuringRun).toBe(true);
		const reference = await toVerificationReference(evidence);
		expect(reference.changedDuringRun).toBe(true);
		expect(reference.stale).toBeNull();
		expect(verificationResultLine(reference)).toContain("changed during the run");
	});

	// #44: committing exactly the verified changes reads stale. Conservative, not wrong: the
	// revision differs, so the record no longer describes the current tree.
	it("treats committing the verified changes as stale", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "README.md"), "changed\n");
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.dirty).toBe(true);
		git(cwd, ["add", "README.md"]);
		git(cwd, ["commit", "-m", "verify then commit"]);
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: outside a repository there is no identity to compare.
	it("omits identity outside git", async () => {
		const cwd = scratch();
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.available).toBe(false);
		expect(evidence.changedDuringRun).toBeNull();
		expect(await verificationStale(evidence)).toBeNull();
	});

	// #44: /verify run goes through the session runner; large output stays successful and local.
	it("keeps bounded output local on the session record", async () => {
		const notify = vi.fn();
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness, notify);
		await harness.session.prompt("/verify run node -e \"process.stdout.write('z'.repeat(100000))\"");
		const evidence = latestEvidenceEntry(harness);
		expect(evidence).toMatchObject({ outcome: "success", output: { truncated: true } });
		expect(evidence?.output.text.length).toBeLessThan(100_000);
		expect(evidence?.fullOutputPath).toBeDefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("success"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Full output:"), "info");
		const bashMessage = harness.sessionManager
			.getBranch()
			.find(
				(candidate) =>
					candidate.type === "message" &&
					(candidate as { message?: { role?: string } }).message?.role === "bashExecution",
			);
		expect(bashMessage).toBeDefined();

		await harness.session.prompt("/verify share");
		const preview = String(notify.mock.calls.at(-1)?.[0]);
		expect(preview).toContain("outputPreview");
		expect(preview).toContain("every agent in the task scope");
		expect(preview.length).toBeLessThan(2_000);
	});

	// #44: a rejecting session runner refuses the run; the command never touches the host.
	it("honors a rejecting shell runner without host fallback", async () => {
		const notify = vi.fn();
		const marker = join(scratch(), "host-marker.txt");
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
			shellRunner: {
				kind: "invalid",
				notice: "Shell runner: blocked. Test rejection.",
				operations: createRejectingShellOperations("Shell runner: blocked. Test rejection."),
			},
		});
		harnesses.push(harness);
		await bindVerify(harness, notify);
		await harness.session.prompt(`/verify run node -e "require('fs').writeFileSync('${fwd(marker)}','x')"`);
		const evidence = latestEvidenceEntry(harness);
		expect(evidence?.outcome).toBe("unknown");
		expect(evidence?.error).toContain("blocked");
		expect(existsSync(marker)).toBe(false);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("blocked"), "warning");
	});

	// #44: configured runners and shell settings apply to verification runs.
	it("honors configured runners and the shell command prefix", async () => {
		const received: string[] = [];
		const operations: BashOperations = {
			exec: async (command) => {
				received.push(command);
				return { exitCode: 0 };
			},
		};
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
			settings: { shellCommandPrefix: "export OCTOBER_VERIFY_PREFIX=1" },
			shellRunner: { kind: "custom", notice: "test runner", operations },
		});
		harnesses.push(harness);
		await bindVerify(harness);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		expect(received).toHaveLength(1);
		expect(received[0]).toBe('export OCTOBER_VERIFY_PREFIX=1\nnode -e "process.exit(0)"');
		expect(latestEvidenceEntry(harness)?.outcome).toBe("success");
	});

	// #44: idle runs join session cancellation, and descendants do not survive it.
	it("connects idle runs to session cancellation with process-tree cleanup", { timeout: 30_000 }, async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness);
		const dir = scratch();
		const ready = join(dir, "ready");
		const marker = join(dir, "marker");
		const child = join(dir, "child.js");
		writeFileSync(child, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1200);`);
		const pending = harness.session.prompt(
			`/verify run node -e "require('fs').writeFileSync('${fwd(ready)}','up');require('child_process').spawn(process.execPath,['${fwd(child)}'],{stdio:'ignore'});setTimeout(()=>{},60000)"`,
		);
		await waitFor(ready, 10_000);
		harness.session.abortBash();
		await pending;
		expect(latestEvidenceEntry(harness)?.outcome).toBe("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		expect(existsSync(marker)).toBe(false);
	});

	// #44: shared references ride on task results; requests stay unchanged.
	it("attaches a shared reference to task results and leaves requests unchanged", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness);
		await harness.session.prompt("/verify run node -e \"console.log('verified-ok')\"");
		const beforeShare: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "before-share", beforeShare);
		expect(beforeShare.context).toBeUndefined();

		await harness.session.prompt("/verify share");
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === VERIFICATION_SHARE_ENTRY),
		).toBe(true);

		const request: Record<string, unknown> = { peer: "builder", mode: "request", message: "please" };
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "request", request);
		expect(request.context).toBeUndefined();

		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "response", response);
		const context = response.context as { title: string; text: string }[];
		expect(context).toHaveLength(1);
		expect(context[0]?.title).toBe(VERIFICATION_CONTEXT_TITLE);
		const reference = JSON.parse(context[0]?.text ?? "{}") as {
			id?: string;
			outputPreview?: string;
			outcome?: string;
		};
		expect(reference.outcome).toBe("success");
		expect(reference.outputPreview).toContain("verified-ok");
		expect(reference.outputPreview?.length).toBeLessThan(300);

		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "response-again", response);
		expect(response.context as unknown[]).toHaveLength(1);

		const task: Record<string, unknown> = { taskId: "task-1", note: "done" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "complete", task);
		const note = String(task.note);
		expect(note.startsWith("done\n")).toBe(true);
		expect(note).toContain(`Verification evidence ${reference.id}:`);
		expect(note).toContain("success");
		expect(note).not.toContain("outputPreview");
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "complete-again", task);
		expect(String(task.note).split(`Verification evidence ${reference.id}:`)).toHaveLength(2);
	});

	// #44: a written claim cannot manufacture a successful check; the record wins.
	it("replaces model-written copies with the authoritative record", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness);
		await harness.session.prompt('/verify run node -e "process.exit(2)"');
		await harness.session.prompt("/verify share");
		const evidence = latestEvidenceEntry(harness);
		expect(evidence?.outcome).toBe("failed");
		const evidenceId = evidence?.id ?? "";

		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [
				{
					kind: "text",
					title: VERIFICATION_CONTEXT_TITLE,
					mediaType: "application/json",
					text: JSON.stringify({ id: evidenceId, outcome: "success", stale: false }),
				},
			],
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "spoofed-context", response);
		const context = response.context as { text: string }[];
		expect(context).toHaveLength(1);
		expect(JSON.parse(context[0]?.text ?? "{}")).toMatchObject({ id: evidenceId, outcome: "failed" });

		const task: Record<string, unknown> = {
			taskId: "task-1",
			note: `done\nVerification evidence ${evidenceId}: success (current, exit 0) \`made up\``,
		};
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "spoofed-note", task);
		const lines = String(task.note).split("\n");
		expect(lines.filter((line) => line.startsWith(`Verification evidence ${evidenceId}:`))).toHaveLength(1);
		expect(String(task.note)).toContain("failed");
		expect(String(task.note)).not.toContain("made up");
	});

	// #44: a retried send reuses its idempotency key; the Bus rejects same-key content changes.
	it("keeps same-key retries byte-identical and refreshes new sends", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness);
		const cwd = harness.tempDir;
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "verify@example.com"]);
		git(cwd, ["config", "user.name", "Verify"]);
		git(cwd, ["config", "commit.gpgsign", "false"]);
		writeFileSync(join(cwd, "README.md"), "checked\n");
		git(cwd, ["add", "README.md"]);
		git(cwd, ["commit", "-m", "init"]);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");

		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "key-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		const firstText = (first.context as { text: string }[])[0]?.text ?? "";
		expect(JSON.parse(firstText).stale).toBe(false);

		writeFileSync(join(cwd, "README.md"), "changed after send\n");
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "key-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect((retry.context as { text: string }[])[0]?.text).toBe(firstText);

		const fresh: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "key-2",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "fresh", fresh);
		expect(JSON.parse((fresh.context as { text: string }[])[0]?.text ?? "{}").stale).toBe(true);

		// `complete_task` has no idempotency key in the pinned Bus input, so every
		// completion is evaluated fresh: an identical key must not freeze the note.
		writeFileSync(join(cwd, "README.md"), "checked\n");
		const task: Record<string, unknown> = { taskId: "task-1", note: "done", idempotencyKey: "task-key" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-first", task);
		expect(String(task.note)).toContain("current");
		writeFileSync(join(cwd, "README.md"), "changed again\n");
		const taskRetry: Record<string, unknown> = { taskId: "task-1", note: "done", idempotencyKey: "task-key" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-retry", taskRetry);
		expect(String(taskRetry.note)).toContain("stale");
		for (const entry of harness.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === VERIFICATION_ATTACHMENT_ENTRY) {
				expect((entry.data as { tool?: unknown }).tool).toBe(BUS_MESSAGE_PEER_TOOL);
			}
		}
	});

	// #44: attachment respects the Bus payload budgets and says when it cannot fit.
	it("skips attachment at Bus payload limits and says so", async () => {
		const notify = vi.fn();
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness, notify);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const evidenceId = latestEvidenceEntry(harness)?.id ?? "";
		notify.mockClear();

		const full: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: Array.from({ length: BUS_MAX_CONTEXT_ITEMS }, (_, index) => ({ text: `{"n":${index}}` })),
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "full-context", full);
		expect(full.context as unknown[]).toHaveLength(BUS_MAX_CONTEXT_ITEMS);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");

		const longNote: Record<string, unknown> = { taskId: "task-1", note: "x".repeat(BUS_MAX_NOTE_BYTES) };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "long-note", longNote);
		expect(String(longNote.note)).toHaveLength(BUS_MAX_NOTE_BYTES);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");

		// Replacing a same-id copy does not grow the payload, so it still attaches.
		const crowded: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: Array.from({ length: BUS_MAX_CONTEXT_ITEMS }, (_, index) =>
				index === 5
					? { text: JSON.stringify({ id: evidenceId, outcome: "success", stale: false }) }
					: { text: `{"n":${index}}` },
			),
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "crowded-replace", crowded);
		const replaced = (crowded.context as { text: string }[])[5]?.text ?? "{}";
		expect(JSON.parse(replaced).id).toBe(evidenceId);
		expect(crowded.context as unknown[]).toHaveLength(BUS_MAX_CONTEXT_ITEMS);
	});

	// #44: sharing arms the latest run; a newer run or unsharing disarms it.
	it("shares the latest run until a newer run or unshare disarms it", async () => {
		const notify = vi.fn();
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await bindVerify(harness, notify);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		await harness.session.prompt("/verify status");
		expect(String(notify.mock.calls.at(-1)?.[0])).toContain("armed");

		const attached: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "attached", attached);
		expect(attached.context).toBeDefined();

		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		expect(String(notify.mock.calls.at(-1)?.[0])).toContain("Sharing: off");
		const disarmed: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "disarmed", disarmed);
		expect(disarmed.context).toBeUndefined();

		await harness.session.prompt("/verify share");
		const rearmed: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "rearmed", rearmed);
		expect(rearmed.context).toBeDefined();

		await harness.session.prompt("/verify unshare");
		const cleared: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "cleared", cleared);
		expect(cleared.context).toBeUndefined();
	});

	// #44: attachment leaves anything that is not a task result untouched.
	it("leaves non-result tool calls unchanged", () => {
		const item = {
			kind: "text" as const,
			title: VERIFICATION_CONTEXT_TITLE,
			text: "{}",
			mediaType: "application/json",
		};
		const request: Record<string, unknown> = { peer: "builder", mode: "request", message: "please" };
		expect(attachVerificationReference(BUS_MESSAGE_PEER_TOOL, request, item, "unused")).toBe("not-applicable");
		expect(request.context).toBeUndefined();
		const other: Record<string, unknown> = { mode: "response", responseTo: "req-1" };
		expect(attachVerificationReference("mcp__october-bus__list_tasks", other, item, "unused")).toBe("not-applicable");
	});

	// #44: reservation holds when sharing is off. A copied evidence line from an
	// earlier completion is stripped from the unarmed send; nothing is attached.
	it("strips reserved copies when unarmed instead of attaching", async () => {
		const harness = await gitRepoHarness();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const taskA: Record<string, unknown> = { taskId: "task-a", note: "done" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-a", taskA);
		const copied = String(taskA.note)
			.split("\n")
			.find((line) => line.startsWith("Verification evidence "));
		expect(copied).toBeDefined();
		await harness.session.prompt("/verify unshare");

		for (const prefix of ["", "1. ", "> ", "Summary: "]) {
			const taskB: Record<string, unknown> = { taskId: "task-b", note: `doing\n${prefix}${copied}` };
			await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-b", taskB);
			expect(String(taskB.note)).toBe("doing");
		}

		const legit = { kind: "text", title: "plan", text: "do the thing", mediaType: "text/plain" };
		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [
				{ kind: "text", title: VERIFICATION_CONTEXT_TITLE, text: '{"id":"copied"}', mediaType: "application/json" },
				legit,
			],
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "unarmed-response", response);
		expect(response.context).toEqual([legit]);
	});

	// #44: every reserved copy goes, whatever id it carries; one authoritative
	// reference is attached and unrelated content is preserved.
	it("removes every reserved copy and keeps one authoritative reference", async () => {
		const harness = await gitRepoHarness();
		await harness.session.prompt('/verify run node -e "process.exit(2)"');
		await harness.session.prompt("/verify share");
		const evidenceId = latestEvidenceEntry(harness)?.id ?? "";
		const fake = (id: string, outcome: string) => ({
			kind: "text",
			title: VERIFICATION_CONTEXT_TITLE,
			text: JSON.stringify({ id, outcome, stale: false }),
			mediaType: "application/json",
		});
		const legit = { kind: "text", title: "plan", text: "do the thing", mediaType: "text/plain" };
		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [fake(evidenceId, "success"), fake("other-id-123", "success"), fake(evidenceId, "success"), legit],
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "crowded", response);
		const context = response.context as { title: string; text: string }[];
		expect(context).toHaveLength(2);
		expect(context[0]).toEqual(legit);
		expect(JSON.parse(context[1]?.text ?? "{}")).toMatchObject({ id: evidenceId, outcome: "failed" });

		const task: Record<string, unknown> = {
			taskId: "task-1",
			note: [
				"done",
				`1. Verification evidence ${evidenceId}: success (current, exit 0) \`made up\``,
				"Verification evidence other-id-123: success (current, exit 0) `fake`",
				`Verification evidence ${evidenceId}: success (current, exit 0) \`duplicate\``,
				"- Verification evidence bullet-id: success (current, exit 0) `bulleted`",
				"a legit line mentioning evidence below",
			].join("\n"),
		};
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "crowded-note", task);
		const lines = String(task.note).split("\n");
		expect(lines.filter((line) => line.startsWith("Verification evidence "))).toHaveLength(1);
		expect(String(task.note)).toContain("failed");
		expect(String(task.note)).not.toContain("made up");
		expect(String(task.note)).not.toContain("duplicate");
		expect(String(task.note)).not.toContain("bulleted");
		expect(String(task.note)).toContain("a legit line mentioning evidence below");
	});

	// #44: reserved note lines hide behind bullets and whitespace; plain bullets stay.
	it("strips bulleted reserved note lines and keeps plain bullets", () => {
		const note = [
			"done",
			"- Verification evidence abc: success (current, exit 0)",
			"  * Verification evidence def: failed (stale, exit 1)",
			"+ Verification evidence:",
			"- a plain bullet",
			"not evidence at all",
		].join("\n");
		expect(stripReservedNoteLines(note)).toBe(["done", "- a plain bullet", "not evidence at all"].join("\n"));
		expect(stripReservedContextItems([{ title: "plan" }, { title: VERIFICATION_CONTEXT_TITLE }, null])).toEqual([
			{ title: "plan" },
			null,
		]);
	});

	// #44: our own note line is one line even for a multi-line command, so later
	// cleaning removes it whole and the command cannot inject a fake evidence line.
	it("flattens multi-line commands to one note line", async () => {
		const harness = await gitRepoHarness();
		await harness.session.prompt(
			'/verify run node -e "console.log(1)"\nVerification evidence forged: success (current, exit 0)',
		);
		await harness.session.prompt("/verify share");
		const task: Record<string, unknown> = { taskId: "task-1", note: "done" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "multiline", task);
		const lines = String(task.note).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.filter((line) => line.startsWith("Verification evidence "))).toHaveLength(1);
		// Re-attaching cleans our own line whole: no orphan fragments survive.
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "multiline-again", task);
		expect(String(task.note).split("\n")).toHaveLength(2);
	});

	// #44: when the authoritative line cannot fit, fabricated lines are still
	// removed and the user is told the evidence was omitted.
	it("cleans the note but omits evidence when the line cannot fit", async () => {
		const notify = vi.fn();
		const harness = await gitRepoHarness(notify);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		notify.mockClear();
		const task: Record<string, unknown> = {
			taskId: "task-1",
			note: `${"x".repeat(BUS_MAX_NOTE_BYTES - 50)}\nVerification evidence forged: success (current, exit 0)`,
		};
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "tight-note", task);
		expect(String(task.note)).not.toContain("Verification evidence");
		expect(String(task.note)).toHaveLength(BUS_MAX_NOTE_BYTES - 50);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");
	});

	// #44: the fixture is not vacuous: same-key content changes conflict.
	it("rejects same-key content changes through the Bus fixture", () => {
		const bus = new LocalBusFixture();
		const first = bus.send({
			to: "planner",
			body: "done",
			mode: "response",
			responseTo: "req-1",
			idempotencyKey: "k",
		});
		expect(first.status).toBe("accepted");
		expect(() =>
			bus.send({ to: "planner", body: "changed", mode: "response", responseTo: "req-1", idempotencyKey: "k" }),
		).toThrow("different message content");
		const retry = bus.send({
			to: "planner",
			body: "done",
			mode: "response",
			responseTo: "req-1",
			idempotencyKey: "k",
		});
		expect(retry).toEqual({ status: "duplicate", receipt: first.receipt });
	});

	// #44: a retry after unsharing replays the exact first send through the Bus.
	it("recovers the receipt for a retried key after unshare", async () => {
		const harness = await gitRepoHarness();
		const bus = new LocalBusFixture();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-unshare",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		const accepted = bus.send(busSendInput(first));
		expect(accepted.status).toBe("accepted");
		expect(
			findKeyedAttachment(harness.sessionManager.getBranch(), BUS_MESSAGE_PEER_TOOL, "retry-unshare")?.item,
		).toBeDefined();

		await harness.session.prompt("/verify unshare");
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-unshare",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect(retry.context).toEqual(first.context);
		expect(bus.send(busSendInput(retry))).toEqual({ status: "duplicate", receipt: accepted.receipt });
	});

	// #44: a newer run disarms sharing, but a keyed retry still replays its send.
	it("keeps retries stable across a newer run", async () => {
		const harness = await gitRepoHarness();
		const bus = new LocalBusFixture();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-newer-run",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		const accepted = bus.send(busSendInput(first));
		expect(accepted.status).toBe("accepted");

		await harness.session.prompt('/verify run node -e "process.exit(1)"');
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-newer-run",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect(retry.context).toEqual(first.context);
		expect(bus.send(busSendInput(retry))).toEqual({ status: "duplicate", receipt: accepted.receipt });
	});

	// #44: a key first sent bare stays bare when sharing is enabled later. The
	// retry must not gain a context field the first send lacked.
	it("keeps a bare first send bare after sharing is enabled", async () => {
		const harness = await gitRepoHarness();
		const bus = new LocalBusFixture();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-bare",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		expect(first.context).toBeUndefined();
		const accepted = bus.send(busSendInput(first));
		expect(accepted.status).toBe("accepted");

		await harness.session.prompt("/verify share");
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-bare",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect(retry.context).toBeUndefined();
		expect(bus.send(busSendInput(retry))).toEqual({ status: "duplicate", receipt: accepted.receipt });
	});

	// #44: attachment decisions live in the session, not the extension closure:
	// a retry after a real extension reload still recovers its receipt.
	it("recovers retried sends after an extension reload", async () => {
		const harness = await gitRepoHarness();
		const bus = new LocalBusFixture();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-reload",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		const accepted = bus.send(busSendInput(first));
		expect(accepted.status).toBe("accepted");

		await harness.session.reload();
		await harness.session.prompt("/verify unshare");
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			idempotencyKey: "retry-reload",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect(retry.context).toEqual(first.context);
		expect(bus.send(busSendInput(retry))).toEqual({ status: "duplicate", receipt: accepted.receipt });
	});

	// #44: persisted decisions have no eviction cap: an early key still replays
	// after a hundred later sends.
	it("remembers keyed decisions without an eviction cap", async () => {
		const harness = await gitRepoHarness();
		const bus = new LocalBusFixture();
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const first: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-0",
			idempotencyKey: "no-evict-0",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "first", first);
		const accepted = bus.send(busSendInput(first));
		for (let index = 1; index <= 105; index++) {
			const send: Record<string, unknown> = {
				peer: "planner",
				mode: "response",
				message: "done",
				responseTo: `req-${index}`,
				idempotencyKey: `no-evict-${index}`,
			};
			await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, `send-${index}`, send);
		}
		await harness.session.prompt("/verify unshare");
		const retry: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-0",
			idempotencyKey: "no-evict-0",
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "retry", retry);
		expect(retry.context).toEqual(first.context);
		expect(bus.send(busSendInput(retry))).toEqual({ status: "duplicate", receipt: accepted.receipt });
	});

	// #44: only a completed probe counts: killed, truncated, and failed probes
	// are unusable even when the exit code reads 0.
	it("rejects killed, truncated, and failed git probes", () => {
		expect(isUsableGitResult({ code: 0, killed: false, truncated: false })).toBe(true);
		expect(isUsableGitResult({ code: 0, killed: true, truncated: false })).toBe(false);
		expect(isUsableGitResult({ code: 1, killed: false, truncated: false })).toBe(false);
		expect(isUsableGitResult({ code: 0, killed: false, truncated: true })).toBe(false);
	});

	// #44: a git status ended by a signal leaves no identity behind; its empty
	// output must not read as a clean tree.
	it.runIf(process.platform !== "win32")("reports unknown when git status is signalled", async () => {
		const cwd = repo();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		const bin = join(scratch(), "bin");
		mkdirSync(bin, { recursive: true });
		const fakeGit = join(bin, "git");
		writeFileSync(
			fakeGit,
			`#!/bin/sh\ncase "$1 $2" in\n"rev-parse --show-toplevel") pwd ;;\n"rev-parse HEAD") echo ${head} ;;\n*) kill -KILL $$ ;;\nesac\n`,
		);
		chmodSync(fakeGit, 0o755);
		const previousPath = process.env.PATH ?? "";
		process.env.PATH = `${bin}:${previousPath}`;
		try {
			const runner = stubRunner({ output: "", exitCode: 0, cancelled: false, truncated: false });
			const evidence = await runVerification({ command: "whatever", cwd, runner });
			expect(evidence.outcome).toBe("success");
			expect(evidence.code.available).toBe(false);
			expect(evidence.changedDuringRun).toBeNull();
			expect(await verificationStale(evidence)).toBeNull();
		} finally {
			process.env.PATH = previousPath;
		}
	});

	// #44: execute permission is part of the identity: losing it changes the tree
	// even when every byte is the same.
	it.runIf(process.platform !== "win32")("marks an execute-bit-only change stale", async () => {
		const cwd = repo();
		const script = join(cwd, "check.sh");
		writeFileSync(script, "echo ok\n");
		chmodSync(script, 0o755);
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.available).toBe(true);
		expect(await verificationStale(evidence)).toBe(false);
		chmodSync(script, 0o644);
		expect(await verificationStale(evidence)).toBe(true);
		chmodSync(script, 0o755);
		expect(await verificationStale(evidence)).toBe(false);
	});

	// #44: symlinks are identified by their target: swapping a regular file for a
	// link to identical bytes is a change, as is retargeting the link.
	it.runIf(process.platform !== "win32")("distinguishes symlinks from identical-byte regular files", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "target.txt"), "same\n");
		writeFileSync(join(cwd, "link-me.txt"), "same\n");
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: localRunner(cwd),
		});
		expect(evidence.code.available).toBe(true);
		expect(await verificationStale(evidence)).toBe(false);
		rmSync(join(cwd, "link-me.txt"));
		symlinkSync("target.txt", join(cwd, "link-me.txt"));
		expect(await verificationStale(evidence)).toBe(true);

		const linked = repo();
		writeFileSync(join(linked, "target.txt"), "same\n");
		symlinkSync("target.txt", join(linked, "link-me.txt"));
		const linkEvidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd: linked,
			runner: localRunner(linked),
		});
		expect(await verificationStale(linkEvidence)).toBe(false);
		writeFileSync(join(linked, "other.txt"), "same\n");
		rmSync(join(linked, "link-me.txt"));
		symlinkSync("other.txt", join(linked, "link-me.txt"));
		expect(await verificationStale(linkEvidence)).toBe(true);
	});

	// #44: an incomplete start/end comparison is unknown, never "changed during
	// the run". Only a proven difference claims a mid-run change.
	it("keeps unknown distinct from a proven mid-run change", async () => {
		const cwd = repo();
		const evidence = await runVerification({
			command: 'node -e "process.exit(0)"',
			cwd,
			runner: (async () => {
				rmSync(join(cwd, ".git"), { recursive: true, force: true });
				return { output: "", exitCode: 0, cancelled: false, truncated: false };
			}) satisfies VerificationBashRunner,
		});
		expect(evidence.outcome).toBe("success");
		expect(evidence.changedDuringRun).toBeNull();
		const reference = await toVerificationReference(evidence);
		expect(reference.stale).toBeNull();
		expect(verificationResultLine(reference)).toContain("freshness unknown");
		expect(verificationResultLine(reference)).not.toContain("changed during the run");
	});

	// #44: an incomplete start capture cannot establish what the command ran against,
	// so a complete end capture must never read "current".
	it("never reads current when the start capture was incomplete", async () => {
		const cwd = repo();
		for (let index = 0; index < 101; index++) {
			writeFileSync(join(cwd, `bulk-${String(index).padStart(3, "0")}.txt`), "bulk\n");
		}
		const evidence = await runVerification({
			command: "whatever",
			cwd,
			runner: (async () => {
				for (let index = 0; index < 60; index++) {
					rmSync(join(cwd, `bulk-${String(index).padStart(3, "0")}.txt`));
				}
				return { output: "", exitCode: 0, cancelled: false, truncated: false };
			}) satisfies VerificationBashRunner,
		});
		expect(evidence.code.filesTruncated).toBe(false);
		expect(evidence.changedDuringRun).toBeNull();
		expect(await verificationStale(evidence)).toBeNull();
		const reference = await toVerificationReference(evidence);
		expect(verificationResultLine(reference)).toContain("freshness unknown");
		writeFileSync(join(cwd, "bulk-100.txt"), "edited\n");
		expect(await verificationStale(evidence)).toBe(true);
	});

	// #44: the exported budgets pin the pinned Bus release (validation.go caps
	// context at 32 items / 512 title / 65536 text / 4096 URI bytes / 256 KiB
	// total; runtime.go caps task notes at 16384 bytes).
	it("pins the Bus payload budgets to the pinned release", () => {
		expect(BUS_MAX_CONTEXT_ITEMS).toBe(32);
		expect(BUS_MAX_CONTEXT_TEXT_BYTES).toBe(65536);
		expect(BUS_MAX_CONTEXT_TOTAL_BYTES).toBe(262144);
		expect(BUS_MAX_NOTE_BYTES).toBe(16384);
		expect(violatedContextBudgets([]).size).toBe(0);
	});

	// #44: evidence fits exactly at the byte budget; one byte over skips it.
	it("fits evidence exactly at the byte budget and skips one byte over", async () => {
		const notify = vi.fn();
		const harness = await gitRepoHarness(notify);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const evidence = latestEvidenceEntry(harness);
		expect(evidence).toBeDefined();
		if (!evidence) return;
		const item = await verificationContextItem(evidence, { shareOutput: true });
		const itemBytes =
			Buffer.byteLength(item.title, "utf-8") +
			Buffer.byteLength(item.text, "utf-8") +
			Buffer.byteLength(item.mediaType, "utf-8");
		const modelOverhead = Buffer.byteLength("m", "utf-8") + Buffer.byteLength("text/plain", "utf-8");
		const modelText = BUS_MAX_CONTEXT_TOTAL_BYTES - itemBytes - modelOverhead;

		const fits: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [{ kind: "text", title: "m", text: "p".repeat(modelText), mediaType: "text/plain" }],
		};
		notify.mockClear();
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "fits", fits);
		expect(fits.context as unknown[]).toHaveLength(2);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");

		const over: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [{ kind: "text", title: "m", text: "p".repeat(modelText + 1), mediaType: "text/plain" }],
		};
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "over", over);
		expect(over.context as unknown[]).toHaveLength(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");
	});

	// #44: the reference bounds its own fields, so an enormous command or runner
	// error cannot break the per-field budget by itself.
	it("caps oversized commands and errors in the reference", async () => {
		const cwd = scratch();
		const huge = await runVerification({
			command: `node -e "0" # ${"c".repeat(100_000)}`,
			cwd,
			runner: stubRunner({ output: "", exitCode: 0, cancelled: false, truncated: false }),
		});
		const item = await verificationContextItem(huge, { shareOutput: true });
		expect(Buffer.byteLength(item.text, "utf-8")).toBeLessThanOrEqual(BUS_MAX_CONTEXT_TEXT_BYTES);
		expect(JSON.parse(item.text).command).toContain("...");
		expect(huge.command).toHaveLength(100_014);

		const failing = await runVerification({
			command: "whatever",
			cwd,
			runner: (async () => {
				throw new Error(`blocked: ${"e".repeat(100_000)}`);
			}) satisfies VerificationBashRunner,
		});
		const failingItem = await verificationContextItem(failing, { shareOutput: true });
		expect(Buffer.byteLength(failingItem.text, "utf-8")).toBeLessThanOrEqual(BUS_MAX_CONTEXT_TEXT_BYTES);
		expect(JSON.parse(failingItem.text).error).toContain("...");
		expect(failing.error).toContain("e".repeat(100));
	});

	// #44: replacing a small fabrication with the real reference can still grow
	// past the budget. Then the evidence is omitted but the fabrication is gone.
	it("omits evidence when replacement grows past the budget but still cleans", async () => {
		const notify = vi.fn();
		const harness = await gitRepoHarness(notify);
		await harness.session.prompt('/verify run node -e "process.exit(0)"');
		await harness.session.prompt("/verify share");
		const evidence = latestEvidenceEntry(harness);
		expect(evidence).toBeDefined();
		if (!evidence) return;
		const item = await verificationContextItem(evidence, { shareOutput: true });
		const itemBytes =
			Buffer.byteLength(item.title, "utf-8") +
			Buffer.byteLength(item.text, "utf-8") +
			Buffer.byteLength(item.mediaType, "utf-8");
		const fake = {
			kind: "text",
			title: VERIFICATION_CONTEXT_TITLE,
			text: "f".repeat(100),
			mediaType: "application/json",
		};
		const modelOverhead = Buffer.byteLength("m", "utf-8") + Buffer.byteLength("text/plain", "utf-8");
		// Cleaned base fits; cleaned base plus our reference does not.
		const modelText = BUS_MAX_CONTEXT_TOTAL_BYTES - modelOverhead - itemBytes + 100;
		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
			context: [fake, { kind: "text", title: "m", text: "p".repeat(modelText), mediaType: "text/plain" }],
		};
		notify.mockClear();
		await emitToolCall(harness, BUS_MESSAGE_PEER_TOOL, "grown", response);
		const context = response.context as { title: string; text: string }[];
		expect(context).toHaveLength(1);
		expect(context[0]?.title).toBe("m");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("size limit"), "warning");
	});
});
