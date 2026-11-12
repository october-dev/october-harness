import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	BUS_MAX_NOTE_BYTES,
	BUS_MESSAGE_PEER_TOOL,
	type CodeIdentity,
	isCodeIdentityStale,
	parseGitStatusEntries,
	registerVerificationEvidence,
	runVerification,
	toVerificationReference,
	VERIFICATION_CONTEXT_TITLE,
	VERIFICATION_ENTRY,
	VERIFICATION_SHARE_ENTRY,
	type VerificationBashRunner,
	type VerificationEvidence,
	verificationContextItem,
	verificationResultLine,
	verificationStale,
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
		expect(evidence.changedDuringRun).toBe(false);
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

		const task: Record<string, unknown> = { taskId: "task-1", note: "done", idempotencyKey: "task-key" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-first", task);
		const firstNote = String(task.note);
		writeFileSync(join(cwd, "README.md"), "changed again\n");
		const taskRetry: Record<string, unknown> = { taskId: "task-1", note: "done", idempotencyKey: "task-key" };
		await emitToolCall(harness, BUS_COMPLETE_TASK_TOOL, "task-retry", taskRetry);
		expect(String(taskRetry.note)).toBe(firstNote);
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
		expect(attachVerificationReference(BUS_MESSAGE_PEER_TOOL, request, item, "e1", "unused")).toBe("not-applicable");
		expect(request.context).toBeUndefined();
		const other: Record<string, unknown> = { mode: "response", responseTo: "req-1" };
		expect(attachVerificationReference("mcp__october-bus__list_tasks", other, item, "e1", "unused")).toBe(
			"not-applicable",
		);
	});
});
