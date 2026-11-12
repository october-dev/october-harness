import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	attachVerificationReference,
	BUS_COMPLETE_TASK_TOOL,
	BUS_MESSAGE_PEER_TOOL,
	parseGitStatusPaths,
	registerVerificationEvidence,
	reportedVerificationOutcome,
	runVerification,
	VERIFICATION_CONTEXT_TITLE,
	VERIFICATION_ENTRY,
	VERIFICATION_SHARE_ENTRY,
	verificationContextItem,
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

describe("verification evidence", () => {
	it("parses rename destinations from porcelain status", () => {
		expect(parseGitStatusPaths("R  old.ts\0new.ts\0 M keep.ts\0")).toEqual(["new.ts", "keep.ts"]);
	});

	it("does not treat a written claim as a successful check", () => {
		expect(reportedVerificationOutcome("tests passed", undefined)).toBe("unknown");
		expect(
			reportedVerificationOutcome("tests passed", {
				version: 1,
				id: "e1",
				command: "node -e process.exit(1)",
				cwd: "/tmp",
				startedAt: "2026-11-12T00:00:00.000Z",
				endedAt: "2026-11-12T00:00:01.000Z",
				outcome: "failed",
				exitStatus: 1,
				code: { available: false, revision: null, dirty: false, files: [], filesTruncated: false },
				output: { text: "", truncated: false },
			}),
		).toBe("failed");
	});

	it("records success, failure, missing output, and cancellation from the process", async () => {
		const cwd = repo();
		const success = await runVerification({ command: 'node -e "console.log(1+1)"', cwd });
		expect(success.outcome).toBe("success");
		expect(success.exitStatus).toBe(0);
		expect(success.output.text).toContain("2");
		expect(success.code.available).toBe(true);
		expect(success.code.dirty).toBe(false);
		expect(success.code.revision).toMatch(/^[0-9a-f]{40}$/);

		const quiet = await runVerification({ command: 'node -e "process.exit(0)"', cwd });
		expect(quiet.outcome).toBe("success");
		expect(quiet.output.text).toBe("");

		const failed = await runVerification({ command: 'node -e "process.exit(3)"', cwd });
		expect(failed.outcome).toBe("failed");
		expect(failed.exitStatus).toBe(3);

		const controller = new AbortController();
		const pending = runVerification({
			command: 'node -e "setInterval(() => {}, 1000)"',
			cwd,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 30);
		const cancelled = await pending;
		expect(cancelled.outcome).toBe("cancelled");
		expect(cancelled.exitStatus).not.toBe(0);

		const hidden = await verificationContextItem(success);
		expect(hidden.title).toBe(VERIFICATION_CONTEXT_TITLE);
		expect(JSON.parse(hidden.text).outputPreview).toBeUndefined();
		const shared = await verificationContextItem(success, { shareOutput: true });
		expect(JSON.parse(shared.text).outputPreview).toContain("2");
	});

	it("marks evidence stale after a dirty-file edit and omits identity outside git", async () => {
		const cwd = repo();
		const evidence = await runVerification({ command: 'node -e "process.exit(0)"', cwd });
		expect(await verificationStale(evidence)).toBe(false);
		writeFileSync(join(cwd, "README.md"), "changed\n");
		expect(await verificationStale(evidence)).toBe(true);

		const plain = join(tmpdir(), `october-verify-plain-${Date.now()}`);
		mkdirSync(plain);
		directories.push(plain);
		const untracked = await runVerification({ command: 'node -e "process.exit(0)"', cwd: plain });
		expect(untracked.code.available).toBe(false);
		expect(await verificationStale(untracked)).toBeNull();
	});

	it("keeps bounded output local on the session record", async () => {
		const notify = vi.fn();
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({ notify }),
		});
		await harness.session.prompt("/verify run node -e \"process.stdout.write('z'.repeat(20000))\"");
		const entry = harness.sessionManager.getBranch().find((candidate) => {
			return candidate.type === "custom" && candidate.customType === VERIFICATION_ENTRY;
		});
		expect(entry && entry.type === "custom" && entry.data).toMatchObject({
			outcome: "failed",
			output: { truncated: true },
		});
		const text = entry && entry.type === "custom" ? (entry.data as { output: { text: string } }).output.text : "";
		expect(text.length).toBeLessThan(20_000);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed"), "warning");

		await harness.session.prompt("/verify share");
		const preview = String(notify.mock.calls.at(-1)?.[0]);
		expect(preview).toContain("outputPreview");
		expect(preview.length).toBeLessThan(2_000);
	});

	it("attaches a shared reference to task results and leaves requests unchanged", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerVerificationEvidence(pi)],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext(),
		});
		await harness.session.prompt("/verify run node -e \"console.log('verified-ok')\"");
		const beforeShare: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_MESSAGE_PEER_TOOL,
			toolCallId: "before-share",
			input: beforeShare,
		});
		expect(beforeShare.context).toBeUndefined();

		await harness.session.prompt("/verify share");
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === VERIFICATION_SHARE_ENTRY),
		).toBe(true);

		const request: Record<string, unknown> = { peer: "builder", mode: "request", message: "please" };
		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_MESSAGE_PEER_TOOL,
			toolCallId: "request",
			input: request,
		});
		expect(request.context).toBeUndefined();

		const response: Record<string, unknown> = {
			peer: "planner",
			mode: "response",
			message: "done",
			responseTo: "req-1",
		};
		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_MESSAGE_PEER_TOOL,
			toolCallId: "response",
			input: response,
		});
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

		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_MESSAGE_PEER_TOOL,
			toolCallId: "response-again",
			input: response,
		});
		expect(context).toHaveLength(1);

		const task: Record<string, unknown> = { taskId: "task-1", note: "done" };
		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_COMPLETE_TASK_TOOL,
			toolCallId: "complete",
			input: task,
		});
		const note = String(task.note);
		expect(note.startsWith("done\n")).toBe(true);
		expect(note).toContain(`Verification evidence ${reference.id}:`);
		expect(note).toContain("success");
		expect(note).not.toContain("outputPreview");
		await harness.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: BUS_COMPLETE_TASK_TOOL,
			toolCallId: "complete-again",
			input: task,
		});
		expect(String(task.note).split(`Verification evidence ${reference.id}:`)).toHaveLength(2);

		const bare = { peer: "planner", mode: "request", message: "no" };
		expect(
			attachVerificationReference(
				"message_peer",
				bare,
				{
					kind: "text",
					title: VERIFICATION_CONTEXT_TITLE,
					text: context[0]?.text ?? "",
					mediaType: "application/json",
				},
				reference.id ?? "",
				"unused",
			),
		).toBe(false);
		expect(bare).not.toHaveProperty("context");
	});
});
