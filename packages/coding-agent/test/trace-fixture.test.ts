import type * as ChildProcess from "node:child_process";
import { resolve } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { readTrace } from "../src/core/trace/format.ts";
import { createTraceReplay, replayTrace } from "../src/core/trace/replay.ts";

// Regression: october-dev/october-harness#9

function forbidden(name: string) {
	return () => {
		throw new Error(`${name} is not allowed during replay`);
	};
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawn: forbidden("spawn"),
		spawnSync: forbidden("spawnSync"),
		exec: forbidden("exec"),
		execSync: forbidden("execSync"),
		execFile: forbidden("execFile"),
		execFileSync: forbidden("execFileSync"),
		fork: forbidden("fork"),
	};
});
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawn: forbidden("spawn"),
		spawnSync: forbidden("spawnSync"),
		exec: forbidden("exec"),
		execSync: forbidden("execSync"),
		execFile: forbidden("execFile"),
		execFileSync: forbidden("execFileSync"),
		fork: forbidden("fork"),
	};
});

const fixturePath = resolve(__dirname, "fixtures/trace/synthetic.trace.jsonl");

describe("synthetic trace fixture", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation(forbidden("fetch"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("streams recorded intermediate states instead of the final message", async () => {
		const trace = readTrace(fixturePath);
		const runId = trace.records.find((record) => record.type === "run_start")?.runId ?? "";
		const replay = createTraceReplay(trace, runId);
		const partials: Array<[string, string]> = [];
		for await (const event of await replay.streamFn(replay.model, normalizeContext({ messages: [] }))) {
			if ("partial" in event) {
				const text = event.partial.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				partials.push([event.type, text]);
			}
		}
		expect(partials).toEqual([
			["start", ""],
			["text_start", "Hello! How can I help?"],
			["text_end", "Hello! How can I help?"],
		]);
	});

	it("replays twice offline with identical events and zero mismatches", async () => {
		const createRuntime = vi.spyOn(ModelRuntime, "create");
		const readCredential = vi.spyOn(AuthStorage.prototype, "read");
		const trace = readTrace(fixturePath);
		expect(trace.complete).toBe(true);

		const first = await replayTrace(trace);
		const second = await replayTrace(readTrace(fixturePath));

		expect(first.mismatches).toEqual([]);
		expect(first.complete).toBe(true);
		expect(first).toMatchObject({ runs: 2, modelResponses: 4, toolCalls: 4 });
		expect(second.events).toEqual(first.events);
		expect(first.events.filter((event) => event.type === "tool_update").map((event) => event.toolCallId)).toEqual([
			"call-2",
			"call-3",
			"call-2",
			"call-3",
		]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(createRuntime).not.toHaveBeenCalled();
		expect(readCredential).not.toHaveBeenCalled();
	});
});
