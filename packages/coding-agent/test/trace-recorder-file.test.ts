import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrace } from "../src/core/trace/format.ts";
import { TraceRecorder } from "../src/core/trace/recorder.ts";
import { replayTrace } from "../src/core/trace/replay.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

// Regression: october-dev/october-harness#9

const writeSync = vi.hoisted(() => ({ override: undefined as undefined | ((...args: unknown[]) => number) }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		writeSync: (...args: Parameters<typeof actual.writeSync>) =>
			writeSync.override ? writeSync.override(...args) : actual.writeSync(...args),
	};
});

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	writeSync.override = undefined;
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(name = "run.trace.jsonl"): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "pi-trace-file-"));
	tempDirs.push(dir);
	return join(dir, name);
}

async function harnessWith(tools: AgentTool[] = []): Promise<Harness> {
	const harness = await createHarness({ tools });
	harnesses.push(harness);
	return harness;
}

describe("trace file lifecycle", () => {
	it("refuses existing files and symlinks and creates new files with mode 0600", () => {
		const existing = tempPath();
		fs.writeFileSync(existing, "keep");
		expect(() => TraceRecorder.open(existing)).toThrow(/EEXIST/);
		expect(fs.readFileSync(existing, "utf-8")).toBe("keep");

		const link = tempPath("link.jsonl");
		fs.symlinkSync(join(tmpdir(), "pi-trace-dangling-target"), link);
		expect(() => TraceRecorder.open(link)).toThrow(/EEXIST/);

		const path = tempPath();
		const recorder = TraceRecorder.open(path, { env: {} });
		if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
		recorder.close();
		recorder.close();
		const trace = parseTrace(fs.readFileSync(path, "utf-8"));
		expect(trace.complete).toBe(true);
		expect(trace.records.map((record) => record.type)).toEqual(["header", "trace_end"]);
		expect(() => recorder.attach({} as never)).toThrow(/closed/);
	});

	it("completes short writes", async () => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		writeSync.override = (fd, buffer, offset, length) =>
			actual.writeSync(fd as number, buffer as Buffer, offset as number, Math.min(1, length as number));
		const path = tempPath();
		const harness = await harnessWith();
		const recorder = TraceRecorder.open(path, { env: {} });
		recorder.attach(harness.session);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		recorder.close();
		expect(recorder.error).toBeUndefined();
		expect(parseTrace(fs.readFileSync(path, "utf-8")).complete).toBe(true);
	});

	it("stops on write failure without changing the agent result or writing trace_end", async () => {
		const path = tempPath();
		const harness = await harnessWith();
		const recorder = TraceRecorder.open(path, { env: {} });
		recorder.attach(harness.session);
		writeSync.override = () => {
			throw new Error("disk full");
		};
		harness.setResponses([fauxAssistantMessage("still answered")]);
		await harness.session.prompt("hi");
		writeSync.override = undefined;
		recorder.close();

		expect(getMessageText(harness.session.messages.at(-1))).toBe("still answered");
		expect(recorder.error?.message).toBe("disk full");
		const trace = parseTrace(fs.readFileSync(path, "utf-8"));
		expect(trace.complete).toBe(false);
		expect(trace.records.map((record) => record.type)).not.toContain("trace_end");
	});

	it("stops on serialization failure without changing tool behavior", async () => {
		const bigint = {
			name: "big",
			label: "big",
			description: "returns a bigint",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: { value: 1n } }),
		} satisfies AgentTool;
		const path = tempPath();
		const harness = await harnessWith([bigint]);
		const recorder = TraceRecorder.open(path, { env: {} });
		recorder.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("hi");
		recorder.close();

		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
		expect(recorder.error?.message).toMatch(/BigInt/);
		expect(parseTrace(fs.readFileSync(path, "utf-8")).complete).toBe(false);
	});

	it("counts the pending budget in UTF-8 bytes", async () => {
		const capture = async (text: string) => {
			const big = {
				name: "big",
				label: "big",
				description: "emits one large update",
				parameters: Type.Object({}),
				execute: async (
					_id: string,
					_params: unknown,
					_signal?: AbortSignal,
					onUpdate?: (result: never) => void,
				) => {
					onUpdate?.({ content: [{ type: "text", text }], details: {} } as never);
					return { content: [{ type: "text" as const, text: "ok" }], details: {} };
				},
			} satisfies AgentTool;
			const harness = await harnessWith([big]);
			const recorder = TraceRecorder.open(tempPath(), { env: {}, maxPendingBytes: 10_000 });
			recorder.attach(harness.session);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("big", {}, { id: "call-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("hi");
			recorder.close();
			return recorder.error?.message;
		};
		// Both updates are 6000 UTF-16 code units; only the CJK one is 18000 UTF-8 bytes.
		expect(await capture("a".repeat(6000))).toBeUndefined();
		expect(await capture("字".repeat(6000))).toMatch(/exceeded 10000 bytes/);
	});

	it("redacts secrets from capture failure messages", async () => {
		const leaky = {
			name: "leaky",
			label: "leaky",
			description: "returns a value that fails to serialize",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "ok" }],
				details: {
					toJSON() {
						throw new Error("cannot serialize token s3cret-4821");
					},
				},
			}),
		} satisfies AgentTool;
		const path = tempPath();
		const harness = await harnessWith([leaky]);
		const recorder = TraceRecorder.open(path, { env: {}, secrets: ["s3cret-4821"] });
		recorder.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("leaky", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("hi");
		recorder.close();
		expect(recorder.error?.message).toBe("cannot serialize token <redacted>");
		expect(fs.readFileSync(path, "utf-8")).not.toContain("s3cret-4821");
	});

	it("keeps earlier runs replayable after the pending buffer limit stops capture", async () => {
		const path = tempPath();
		const harness = await harnessWith();
		const recorder = TraceRecorder.open(path, { env: {}, maxPendingBytes: 20_000 });
		recorder.attach(harness.session);
		harness.setResponses([fauxAssistantMessage("short"), fauxAssistantMessage("x".repeat(50_000))]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		recorder.close();

		expect(getMessageText(harness.session.messages.at(-1))).toHaveLength(50_000);
		expect(recorder.error?.message).toMatch(/exceeded 20000 bytes/);
		const text = fs.readFileSync(path, "utf-8");
		expect(text).not.toContain("x".repeat(100));
		const trace = parseTrace(text);
		expect(trace.complete).toBe(false);
		const result = await replayTrace(trace);
		expect(result).toMatchObject({ runs: 1, complete: false, mismatches: [] });
	});

	it("marks a capture closed during a running tool incomplete and does not replay that run", async () => {
		let release = () => {};
		const started = new Promise<void>((resolveStarted) => {
			release = resolveStarted;
		});
		let finish = () => {};
		const blocking = {
			name: "block",
			label: "block",
			description: "waits",
			parameters: Type.Object({}),
			execute: async () => {
				release();
				await new Promise<void>((resolveTool) => {
					finish = resolveTool;
				});
				return { content: [{ type: "text" as const, text: "late" }], details: {} };
			},
		} satisfies AgentTool;
		const path = tempPath();
		const harness = await harnessWith([blocking]);
		const recorder = TraceRecorder.open(path, { env: {} });
		recorder.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage("first run"),
			fauxAssistantMessage(fauxToolCall("block", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("one");
		const run = harness.session.prompt("two");
		await started;
		recorder.close();
		finish();
		await run;

		const trace = parseTrace(fs.readFileSync(path, "utf-8"));
		expect(trace.complete).toBe(false);
		expect(trace.records.map((record) => record.type)).not.toContain("trace_end");
		const result = await replayTrace(trace);
		expect(result).toMatchObject({ runs: 1, complete: false, mismatches: [] });
		expect(result.incompleteRuns).toHaveLength(1);
	});
});
