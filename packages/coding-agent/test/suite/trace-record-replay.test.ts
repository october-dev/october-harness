import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageFrame,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	normalizeContext,
	reduceAssistantMessageFrames,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { parseTrace, type Trace, type TraceRecord, type TraceRecordOf } from "../../src/core/trace/format.ts";
import {
	TraceRecorder,
	type TraceRecorderOptions,
	traceAuxiliaryStreamFn,
	unwrapTracedStreamFn,
} from "../../src/core/trace/recorder.ts";
import { createTraceReplay, replayTrace } from "../../src/core/trace/replay.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

// Regression: october-dev/october-harness#9

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tracePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-trace-"));
	tempDirs.push(dir);
	return join(dir, "run.trace.jsonl");
}

async function newHarness(options: HarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness(options);
	harnesses.push(harness);
	return harness;
}

async function tracedHarness(
	options: HarnessOptions = {},
	recorderOptions: TraceRecorderOptions = {},
	beforeAttach?: (harness: Harness) => void,
): Promise<{ harness: Harness; recorder: TraceRecorder; path: string }> {
	const harness = await newHarness(options);
	beforeAttach?.(harness);
	const path = tracePath();
	const recorder = TraceRecorder.open(path, { env: {}, ...recorderOptions });
	recorder.attach(harness.session);
	return { harness, recorder, path };
}

function readClosed(recorder: TraceRecorder, path: string): { text: string; trace: Trace } {
	recorder.close();
	expect(recorder.error).toBeUndefined();
	const text = readFileSync(path, "utf-8");
	return { text, trace: parseTrace(text) };
}

function ofType<T extends TraceRecord["type"]>(trace: Trace, type: T): TraceRecordOf<T>[] {
	return trace.records.filter((record): record is TraceRecordOf<T> => record.type === type);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function textTool(name: string, run: AgentTool["execute"], executionMode?: AgentTool["executionMode"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ text: Type.String() }),
		...(executionMode ? { executionMode } : {}),
		execute: run,
	};
}

function echoTool(updates: string[] = []): AgentTool {
	return textTool("echo", async (_toolCallId, params, _signal, onUpdate) => {
		const text = (params as { text: string }).text;
		for (const update of updates) onUpdate?.({ content: [{ type: "text", text: update }], details: {} });
		return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
	});
}

function toolTurn(...calls: Array<[name: string, text: string, id: string]>): AssistantMessage {
	return fauxAssistantMessage(
		calls.map(([name, text, id]) => fauxToolCall(name, { text }, { id })),
		{ stopReason: "toolUse" },
	);
}

async function expectReplay(trace: Trace, runs?: number) {
	const result = await replayTrace(trace);
	expect(result.mismatches).toEqual([]);
	expect(result.complete).toBe(true);
	if (runs !== undefined) expect(result.runs).toBe(runs);
	return result;
}

function extension(factory: (pi: ExtensionAPI) => void): HarnessOptions["extensionFactories"] {
	return [{ factory, path: "<test-extension>" }];
}

describe("trace capture", () => {
	it("records a tool turn and replays it with zero mismatches", async () => {
		const { harness, recorder, path } = await tracedHarness({ tools: [echoTool(["working"])] });
		harness.setResponses([toolTurn(["echo", "hi", "call-1"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("say hi");
		const { trace } = readClosed(recorder, path);

		expect(trace.complete).toBe(true);
		const types = trace.records.map((record) => record.type);
		for (const type of ["run_start", "turn_start", "model_request", "model_frame", "model_response", "tool_start"]) {
			expect(types).toContain(type);
		}
		expect(types.slice(-3)).toEqual(["session", "session_detach", "trace_end"]);
		expect(ofType(trace, "model_request").map((record) => record.kind)).toEqual(["session", "session"]);
		const [executed] = ofType(trace, "tool_executed");
		expect(executed.result).toEqual({ content: [{ type: "text", text: "echo:hi" }], details: { text: "hi" } });
		// The session's after hook returned undefined; the raw result is still recorded.
		const after = ofType(trace, "tool_hook").find((record) => record.hook === "after_tool_call");
		expect(after && "result" in after).toBe(false);

		await expectReplay(trace, 1);
	});

	it("leaves session output unchanged and creates nothing when capture is off", async () => {
		const script = () => [toolTurn(["echo", "hi", "call-1"]), fauxAssistantMessage("done")];
		// Faux streaming chunk sizes vary per run, so consecutive message_update events are collapsed.
		const summarize = (harness: Harness) => ({
			messages: harness.session.messages.map((message) => [message.role, getMessageText(message)]),
			events: harness.events
				.map((event) => event.type)
				.filter((type, index, types) => type !== "message_update" || types[index - 1] !== "message_update"),
		});

		const plain = await newHarness({ tools: [echoTool(["working"])] });
		const originalStream = plain.session.agent.streamFunction;
		expect(traceAuxiliaryStreamFn(originalStream)).toBe(originalStream);
		expect(unwrapTracedStreamFn(originalStream)).toBe(originalStream);
		plain.setResponses(script());
		await plain.session.prompt("say hi");
		expect(plain.session.agent.streamFunction).toBe(originalStream);

		const { harness, recorder } = await tracedHarness({ tools: [echoTool(["working"])] });
		const original = unwrapTracedStreamFn(harness.session.agent.streamFunction);
		expect(harness.session.agent.streamFunction).not.toBe(original);
		harness.setResponses(script());
		await harness.session.prompt("say hi");
		recorder.close();

		expect(summarize(harness)).toEqual(summarize(plain));
		expect(harness.session.agent.streamFunction).toBe(original);
	});

	it("keeps an extension message_end replacement separate from the provider result", async () => {
		const { harness, recorder, path } = await tracedHarness({
			extensionFactories: extension((pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role !== "assistant") return undefined;
					return { message: { ...event.message, content: [{ type: "text", text: "replaced" }] } };
				});
			}),
		});
		harness.setResponses([fauxAssistantMessage("original")]);
		await harness.session.prompt("hi");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("replaced");
		const { trace } = readClosed(recorder, path);

		const [response] = ofType(trace, "model_response");
		expect(getMessageText(response.terminal.message)).toBe("original");
		const replacement = ofType(trace, "message").find((record) => record.requestId === response.requestId);
		expect(getMessageText(replacement?.message)).toBe("replaced");

		const result = await expectReplay(trace, 1);
		expect(result.events.filter((event) => event.type === "model_response")).toHaveLength(1);
	});

	it("snapshots tool results before later in-place mutation", async () => {
		const { harness, recorder, path } = await tracedHarness({
			tools: [echoTool()],
			extensionFactories: extension((pi) => {
				pi.on("tool_result", (event) => {
					const first = event.content[0];
					if (first?.type === "text") first.text = "mutated";
					return { content: event.content };
				});
			}),
		});
		harness.setResponses([toolTurn(["echo", "hi", "call-1"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("hi");
		const { trace } = readClosed(recorder, path);

		expect(getMessageText(ofType(trace, "tool_executed")[0].result)).toBe("echo:hi");
		expect(getMessageText(ofType(trace, "tool_end")[0].result)).toBe("mutated");
		await expectReplay(trace, 1);
	});

	it("records blocked, throwing, invalid, and unknown tool calls and replays them", async () => {
		const failing = textTool("fail", async () => {
			throw new Error("tool exploded");
		});
		const { harness, recorder, path } = await tracedHarness({
			tools: [echoTool(), failing],
			extensionFactories: extension((pi) => {
				pi.on("tool_call", (event) =>
					event.toolCallId === "blocked" ? { block: true, reason: "not allowed" } : undefined,
				);
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "a" }, { id: "blocked" }),
					fauxToolCall("fail", { text: "b" }, { id: "throws" }),
					fauxToolCall("echo", {}, { id: "invalid" }),
					fauxToolCall("missing", { text: "c" }, { id: "unknown" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("hi");
		const { trace } = readClosed(recorder, path);

		// Tool call IDs are written as pseudonyms in order of first appearance:
		// blocked → call-1, throws → call-2, invalid → call-3, unknown → call-4.
		const executed = ofType(trace, "tool_executed").map((record) => record.toolCallId);
		expect(executed).toEqual(["call-2"]);
		expect(ofType(trace, "tool_executed")[0].isError).toBe(true);
		const ends = Object.fromEntries(ofType(trace, "tool_end").map((record) => [record.toolCallId, record.isError]));
		expect(ends).toEqual({ "call-1": true, "call-2": true, "call-3": true, "call-4": true });
		expect(ofType(trace, "tool_hook").find((record) => record.toolCallId === "call-1")?.result).toEqual({
			block: true,
			reason: "not allowed",
		});
		await expectReplay(trace, 1);
	});

	it("keeps parallel update and completion order separate from transcript order", async () => {
		const steps = new Map<number, ReturnType<typeof deferred>>();
		const step = (index: number) => {
			let entry = steps.get(index);
			if (!entry) {
				entry = deferred();
				steps.set(index, entry);
			}
			return entry;
		};
		const update = (onUpdate: Parameters<AgentTool["execute"]>[3], text: string) =>
			onUpdate?.({ content: [{ type: "text", text }], details: {} });
		const slow = textTool("slow", async (_id, _params, _signal, onUpdate) => {
			update(onUpdate, "a1");
			step(1).resolve();
			await step(2).promise;
			update(onUpdate, "a2");
			step(3).resolve();
			await step(4).promise;
			return { content: [{ type: "text", text: "slow done" }], details: {} };
		});
		const fast = textTool("fast", async (_id, _params, _signal, onUpdate) => {
			await step(1).promise;
			update(onUpdate, "b1");
			step(2).resolve();
			await step(3).promise;
			update(onUpdate, "b2");
			setTimeout(() => step(4).resolve(), 10);
			return { content: [{ type: "text", text: "fast done" }], details: {} };
		});
		const { harness, recorder, path } = await tracedHarness({ tools: [slow, fast] });
		harness.setResponses([toolTurn(["slow", "x", "a"], ["fast", "y", "b"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const { trace } = readClosed(recorder, path);

		const order = trace.records
			.filter((record) => record.type === "tool_update" || record.type === "tool_end")
			.map((record) =>
				record.type === "tool_update"
					? getMessageText(record.partialResult)
					: `end:${(record as TraceRecordOf<"tool_end">).toolCallId}`,
			);
		// Tool call "a" is written as call-1 and "b" as call-2.
		expect(order).toEqual(["a1", "b1", "a2", "b2", "end:call-2", "end:call-1"]);
		const transcript = ofType(trace, "message")
			.map((record) => record.message as { role: string; toolCallId?: string })
			.filter((message) => message.role === "toolResult")
			.map((message) => message.toolCallId);
		expect(transcript).toEqual(["call-1", "call-2"]);

		const result = await expectReplay(trace, 1);
		const replayed = result.events
			.filter((event) => event.type === "tool_update" || event.type === "tool_end")
			.map((event) => `${event.type}:${event.toolCallId}`);
		expect(replayed).toEqual([
			"tool_update:call-1",
			"tool_update:call-2",
			"tool_update:call-1",
			"tool_update:call-2",
			"tool_end:call-2",
			"tool_end:call-1",
		]);

		// Changing the recorded policy to sequential makes the recorded interleaving impossible.
		const sequential = structuredClone(trace);
		for (const record of ofType(sequential, "model_request")) {
			for (const tool of record.tools ?? []) tool.executionMode = "sequential";
		}
		const stalled = await replayTrace(sequential);
		expect(stalled.mismatches.map((mismatch) => mismatch.kind)).toEqual(["stalled"]);
	});

	it("replays delayed after-hook completion distinctly from raw completion", async () => {
		const { harness, recorder, path } = await tracedHarness({
			tools: [echoTool()],
			extensionFactories: extension((pi) => {
				pi.on("tool_result", async (event) => {
					if (event.toolCallId === "late") await new Promise((resolve) => setTimeout(resolve, 20));
					return undefined;
				});
			}),
		});
		harness.setResponses([toolTurn(["echo", "a", "late"], ["echo", "b", "early"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const { trace } = readClosed(recorder, path);
		// "late" is written as call-1 and "early" as call-2.
		expect(ofType(trace, "tool_end").map((record) => record.toolCallId)).toEqual(["call-2", "call-1"]);
		const result = await expectReplay(trace, 1);
		expect(result.events.filter((event) => event.type === "tool_end").map((event) => event.toolCallId)).toEqual([
			"call-2",
			"call-1",
		]);
	});

	it("scopes reused tool call IDs by request and replays per-turn tool and mode changes", async () => {
		const sequentialTool = textTool(
			"step",
			async (_id, params) => {
				harness.session.setActiveToolsByName(["echo", "step"]);
				return { content: [{ type: "text", text: (params as { text: string }).text }], details: {} };
			},
			"sequential",
		);
		const { harness, recorder, path } = await tracedHarness({
			tools: [echoTool(), sequentialTool],
			initialActiveToolNames: ["step"],
		});
		harness.setResponses([
			toolTurn(["step", "one", "call-1"]),
			toolTurn(["echo", "two", "call-1"]),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const { trace } = readClosed(recorder, path);

		expect(ofType(trace, "tool_start").map((record) => record.toolCallId)).toEqual(["call-1", "call-1"]);
		const requests = ofType(trace, "model_request");
		expect(requests[0].tools?.map((tool) => [tool.name, tool.executionMode])).toEqual([["step", "sequential"]]);
		expect(requests[1].tools?.map((tool) => tool.name)).toEqual(["echo", "step"]);
		expect(requests[2].tools).toBeUndefined();
		await expectReplay(trace, 1);
	});

	it("records extension hook successes, undefined returns, and errors", async () => {
		const { harness, recorder, path } = await tracedHarness({
			extensionFactories: extension((pi) => {
				pi.on("turn_start", () => undefined);
				pi.on("agent_start", () => {
					throw new Error("hook failed");
				});
				pi.on("before_agent_start", () => ({ message: { customType: "note", content: "ctx", display: false } }));
			}),
		});
		const reported: string[] = [];
		harness.session.extensionRunner.onError((error) => reported.push(error.error));
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("hi");
		const { trace } = readClosed(recorder, path);

		// The observer rethrows, so the runner's own error policy still applies.
		expect(reported).toEqual(["hook failed"]);
		const hooks = ofType(trace, "hook");
		const starts = new Map(
			hooks.flatMap((record) => (record.phase === "start" ? [[record.hookId, record.event] as const] : [])),
		);
		const outcome = (event: string) =>
			hooks.find((record) => record.phase === "end" && starts.get(record.hookId) === event);
		expect(outcome("turn_start")).toMatchObject({ status: "ok", returned: false });
		expect(outcome("before_agent_start")).toMatchObject({ status: "ok", returned: true });
		expect(outcome("agent_start")).toMatchObject({ status: "error", error: "hook failed" });
		expect(ofType(trace, "error").map((record) => record.source)).toContain("hook");
		expect(hooks.find((record) => record.phase === "start")).toMatchObject({ extensionPath: "<test-extension>" });
		await expectReplay(trace, 1);
	});

	it("replays an auto-retry continuation as a separate run", async () => {
		const { harness, recorder, path } = await tracedHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("hi");
		const { trace } = readClosed(recorder, path);

		expect(ofType(trace, "run_end").map((record) => record.willRetry)).toEqual([true, false]);
		expect(ofType(trace, "error").map((record) => record.source)).toEqual(["model"]);
		const sessionEvents = ofType(trace, "session").map((record) => record.event);
		expect(sessionEvents).toContain("auto_retry_start");
		await expectReplay(trace, 2);
	});

	it("tags compaction and bug-report summaries as auxiliary and replays only session requests", async () => {
		const { harness, recorder, path } = await tracedHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		harness.setResponses([fauxAssistantMessage("## Summary\ncompacted"), fauxAssistantMessage("## Summary\nprefix")]);
		await harness.session.compact();
		harness.setResponses([fauxAssistantMessage("bug summary")]);
		await harness.session.summarizeForBugReport({ signal: new AbortController().signal });
		const { trace } = readClosed(recorder, path);

		const kinds = ofType(trace, "model_request").map((record) => record.kind);
		expect(kinds.slice(0, 2)).toEqual(["session", "session"]);
		expect(kinds.length).toBeGreaterThanOrEqual(4);
		expect(kinds.slice(2).every((kind) => kind === "auxiliary")).toBe(true);
		const result = await expectReplay(trace, 2);
		expect(result.modelResponses).toBe(2);
	});

	it("keeps a summary awaited by a context callback auxiliary and the conversation session", async () => {
		let summarized = false;
		const holder: { harness?: Harness } = {};
		const { harness, recorder, path } = await tracedHarness({
			extensionFactories: extension((pi) => {
				pi.on("context", async () => {
					if (summarized || !holder.harness) return undefined;
					summarized = true;
					await holder.harness.session.summarizeForBugReport({ signal: new AbortController().signal });
					return undefined;
				});
			}),
		});
		holder.harness = harness;
		harness.setResponses([fauxAssistantMessage("bug summary"), fauxAssistantMessage("conversation")]);
		await harness.session.prompt("hi");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("conversation");
		const { trace } = readClosed(recorder, path);

		const requests = ofType(trace, "model_request");
		expect(requests.map((record) => record.kind)).toEqual(["auxiliary", "session"]);
		const sessionResponse = ofType(trace, "model_response").find(
			(record) => record.requestId === requests[1].requestId,
		);
		expect(getMessageText(sessionResponse?.terminal.message)).toBe("conversation");
		await expectReplay(trace, 1);
	});

	it("records a stream setup failure and replays it", async () => {
		const { harness, recorder, path } = await tracedHarness({}, {}, (target) => {
			target.session.agent.streamFunction = () => {
				throw new Error("setup failed");
			};
		});
		await harness.session.prompt("hi");
		const { trace } = readClosed(recorder, path);
		const [response] = ofType(trace, "model_response");
		expect(response.error).toBe("setup failed");
		expect(response.terminal.reason).toBe("error");
		await expectReplay(trace, 1);
	});

	it("records streams that end with end(result) and no terminal event", async () => {
		const { harness, recorder, path } = await tracedHarness({}, {}, (target) => {
			target.session.agent.streamFunction = (model) => {
				const stream = createAssistantMessageEventStream();
				const message = fauxAssistantMessage("quiet end");
				message.api = model.api;
				message.provider = model.provider;
				message.model = model.id;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.end(message);
				});
				return stream;
			};
		});
		await harness.session.prompt("hi");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("quiet end");
		const { trace } = readClosed(recorder, path);
		expect(getMessageText(ofType(trace, "model_response")[0].terminal.message)).toBe("quiet end");
		await expectReplay(trace, 1);
	});

	it("passes stream iteration and result failures to the agent as without tracing", async () => {
		const failingStream =
			(failure: "iterate" | "result", withBlock: boolean): Harness["session"]["agent"]["streamFunction"] =>
			(model) => {
				const stream = createAssistantMessageEventStream();
				const partial = fauxAssistantMessage("");
				partial.api = model.api;
				partial.provider = model.provider;
				partial.model = model.id;
				partial.stopReason = "pending";
				partial.content = [];
				const produce = async function* () {
					yield { type: "start" as const, partial };
					if (!withBlock) return;
					partial.content.push({ type: "text", text: "Hello! How can I help?" });
					yield { type: "text_start" as const, contentIndex: 0, partial };
					yield { type: "text_end" as const, contentIndex: 0, content: "Hello! How can I help?", partial };
				};
				if (failure === "iterate") {
					stream[Symbol.asyncIterator] = async function* () {
						yield* produce();
						throw new Error("stream iteration failed");
					};
				} else {
					stream[Symbol.asyncIterator] = produce;
					stream.result = () => Promise.reject(new Error("stream result failed"));
				}
				return stream;
			};
		for (const failure of ["iterate", "result"] as const) {
			// Regression: the failure can follow a completed block; the capture must stay loadable.
			for (const withBlock of [false, true]) {
				const outcome = async (traced: boolean) => {
					const harness = await newHarness();
					harness.session.agent.streamFunction = failingStream(failure, withBlock);
					let recorder: TraceRecorder | undefined;
					let path = "";
					if (traced) {
						path = tracePath();
						recorder = TraceRecorder.open(path, { env: {} });
						recorder.attach(harness.session);
					}
					await harness.session.prompt("hi");
					recorder?.close();
					const last = harness.session.messages.at(-1) as AssistantMessage;
					return { result: [last.stopReason, last.errorMessage], path };
				};
				const plain = await outcome(false);
				const traced = await outcome(true);
				expect(traced.result).toEqual(plain.result);
				const trace = parseTrace(readFileSync(traced.path, "utf-8"));
				expect(trace.complete).toBe(true);
				const [response] = ofType(trace, "model_response");
				expect(response.error).toBe(failure === "iterate" ? "stream iteration failed" : "stream result failed");
				expect(getMessageText(response.terminal.message)).toBe(withBlock ? "Hello! How can I help?" : "");
				expect(ofType(trace, "model_frame").map((record) => record.frame.type)).toEqual(
					withBlock ? ["start", "text_start", "text_end"] : ["start"],
				);
				await expectReplay(trace, 1);
			}
		}
	});

	it("records the executable tools a prepareRequest override supplies", async () => {
		const extra = textTool(
			"extra",
			async () => ({ content: [{ type: "text", text: "extra ran" }], details: {} }),
			"sequential",
		);
		const { harness, recorder, path } = await tracedHarness({ tools: [echoTool()] }, {}, (target) => {
			const original = target.session.agent.prepareRequest;
			target.session.agent.prepareRequest = async (request, signal) => {
				const update = (await original?.(request, signal)) ?? undefined;
				const context = update?.context ?? request.context;
				return { ...update, context: { ...context, tools: [...(context.tools ?? []), extra] } };
			};
		});
		harness.setResponses([toolTurn(["extra", "x", "call-1"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(harness.session.getActiveToolNames()).not.toContain("extra");
		const { trace } = readClosed(recorder, path);

		expect(ofType(trace, "tool_end")[0]).toMatchObject({ isError: false });
		expect(ofType(trace, "model_request")[0].tools?.map((tool) => [tool.name, tool.executionMode])).toEqual([
			["echo", undefined],
			["extra", "sequential"],
		]);
		await expectReplay(trace, 1);
	});

	it("records cancellation during a tool and replays it without waiting", async () => {
		const started = deferred();
		const waiting = textTool("wait", async (_id, _params, signal) => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
			});
			return { content: [], details: {} };
		});
		const { harness, recorder, path } = await tracedHarness({ tools: [waiting] });
		harness.setResponses([toolTurn(["wait", "x", "call-1"]), fauxAssistantMessage("never")]);
		const run = harness.session.prompt("go");
		await started.promise;
		await harness.session.abort();
		await run;
		const { trace } = readClosed(recorder, path);

		expect(ofType(trace, "cancel")).toHaveLength(1);
		expect(ofType(trace, "tool_end")[0].isError).toBe(true);
		await expectReplay(trace, 1);
	});

	it("records reload and session replacement without closing the capture", async () => {
		const { harness, recorder, path } = await tracedHarness({
			extensionFactories: extension((pi) => {
				pi.on("turn_start", () => undefined);
			}),
		});
		harness.setResponses([fauxAssistantMessage("before reload"), fauxAssistantMessage("after reload")]);
		await harness.session.prompt("one");
		await harness.session.reload();
		await harness.session.prompt("two");

		const next = await newHarness();
		next.setResponses([fauxAssistantMessage("other session")]);
		recorder.attach(next.session);
		await next.session.prompt("three");
		const { trace } = readClosed(recorder, path);

		const hookEvents = ofType(trace, "hook").flatMap((record) => (record.phase === "start" ? [record.event] : []));
		expect(hookEvents.filter((event) => event === "turn_start")).toHaveLength(2);
		expect(trace.records.map((record) => record.type).filter((type) => type.startsWith("session_"))).toEqual([
			"session_attach",
			"session_detach",
			"session_attach",
			"session_detach",
		]);
		expect(harness.session.agent.streamFunction).toBe(streamSimple);
		await expectReplay(trace, 3);
	});

	it("keeps default-stream summarization auth failures unchanged", async () => {
		const failure = async (traced: boolean) => {
			const harness = await newHarness({ withConfiguredAuth: false });
			if (traced) TraceRecorder.open(tracePath(), { env: {} }).attach(harness.session);
			return harness.session.compact().then(
				() => "resolved",
				(error: Error) => error.message,
			);
		};
		const plain = await failure(false);
		expect(plain).not.toBe("resolved");
		expect(await failure(true)).toBe(plain);
	});
});

describe("trace redaction in sessions", () => {
	it("redacts a secret first learned from request auth that appeared in the preceding prompt", async () => {
		const { harness, recorder, path } = await tracedHarness({}, {}, (target) => {
			target.session.agent.getApiKey = () => "late-secret-4821";
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("my key is late-secret-4821, keep it safe");
		const { text, trace } = readClosed(recorder, path);

		expect(text).not.toContain("late-secret-4821");
		const prompt = ofType(trace, "message").find((record) => (record.message as AgentMessage).role === "user");
		expect(getMessageText(prompt?.message)).toBe("my key is <redacted>, keep it safe");
	});

	it("removes secrets split across model frames and tool updates, even when unrelated auth resolves mid-tool", async () => {
		const secret = "sk-SPLIT-SECRET-7";
		let midToolFile = "";
		const holder: { harness?: Harness; path?: string } = {};
		const splitter = textTool("split", async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "prefix sk-SPLIT-" }], details: {} });
			onUpdate?.({ content: [{ type: "text", text: "SECRET-7 suffix" }], details: {} });
			const harness = holder.harness!;
			// Unrelated request auth on the shared runtime is a flush opportunity, not permission to
			// write the open tool invocation.
			await harness.session.modelRuntime.completeSimple(harness.getModel(), { messages: [] });
			midToolFile = readFileSync(holder.path!, "utf-8");
			return { content: [{ type: "text", text: "done" }], details: {} };
		});
		const { harness, recorder, path } = await tracedHarness({ tools: [splitter] }, { secrets: [secret] });
		holder.harness = harness;
		holder.path = path;
		harness.setResponses([
			fauxAssistantMessage(`the key ${secret} again ${secret}`),
			toolTurn(["split", "x", "call-1"]),
			fauxAssistantMessage("unrelated"),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const { text, trace } = readClosed(recorder, path);

		expect(midToolFile).not.toContain("tool_update");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("sk-SPLIT-");
		expect(text).not.toContain("SECRET-7");
		const updates = ofType(trace, "tool_update").map((record) => getMessageText(record.partialResult));
		expect(updates).toEqual(["prefix <redacted>", "<redacted> suffix"]);

		const first = ofType(trace, "model_request")[0].requestId;
		const frames = ofType(trace, "model_frame")
			.filter((record) => record.requestId === first)
			.map((record) => record.frame as unknown as AssistantMessageFrame);
		const response = ofType(trace, "model_response")[0];
		const reduced = reduceAssistantMessageFrames(frames);
		expect(getMessageText(reduced)).toBe(getMessageText(response.terminal.message));
		expect(getMessageText(response.terminal.message)).toBe("the key <redacted> again <redacted>");
		await expectReplay(trace, 2);
	});
});

describe("trace identifiers", () => {
	it("keeps the session identity stable when a matching credential is learned after it was written", async () => {
		const sessionId = "00000000-0000-4000-8000-000000004821";
		let attachWritten = "";
		const holder: { path?: string } = {};
		const { harness, recorder, path } = await tracedHarness(
			{
				sessionManager: SessionManager.inMemory(undefined, { id: sessionId }),
				extensionFactories: extension((pi) => {
					// Completing a handler before the request resolves auth flushes session_attach early.
					pi.on("before_agent_start", () => {
						return undefined;
					});
					pi.on("turn_start", () => {
						attachWritten = holder.path ? readFileSync(holder.path, "utf-8") : "";
						return undefined;
					});
				}),
			},
			{},
			(target) => {
				// A short credential, first learned when the request resolves auth, matches the ID.
				target.session.agent.getApiKey = () => "4821";
			},
		);
		holder.path = path;
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");
		const { text, trace } = readClosed(recorder, path);

		expect(attachWritten).toContain('"type":"session_attach"');
		expect(text).not.toContain(sessionId);
		const ids = new Set(
			trace.records.flatMap((record) =>
				"sessionId" in record ? [(record as { sessionId: string }).sessionId] : [],
			),
		);
		expect([...ids]).toEqual(["session-1"]);
		expect(trace.complete).toBe(true);
		await expectReplay(trace, 1);
	});
});

describe("trace redaction of printed credentials", () => {
	it("leaves no suffix of a quoted credential that a tool prints across updates", async () => {
		const printer = textTool("print", async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: 'config {"password":"correct ' }], details: {} });
			onUpdate?.({ content: [{ type: "text", text: 'horse battery staple"} loaded' }], details: {} });
			// Regression: another named field before or around the assignment must not hide it.
			onUpdate?.({ content: [{ type: "text", text: 'log: password="correct ' }], details: {} });
			onUpdate?.({
				content: [{ type: "text", text: 'horse battery staple" note="password=\'correct ' }],
				details: {},
			});
			onUpdate?.({ content: [{ type: "text", text: "horse battery staple'\"" }], details: {} });
			return {
				content: [{ type: "text", text: 'log: password="correct horse battery staple"' }],
				details: {},
			};
		});
		const { harness, recorder, path } = await tracedHarness({ tools: [printer] });
		harness.setResponses([toolTurn(["print", "x", "call-1"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const { text, trace } = readClosed(recorder, path);

		for (const word of ["correct", "horse", "battery", "staple"]) expect(text).not.toContain(word);
		expect(ofType(trace, "tool_update").map((record) => getMessageText(record.partialResult))).toEqual([
			'config {"password":"<redacted>',
			'<redacted>"} loaded',
			'log: password="<redacted>',
			`<redacted>" note="password='<redacted>`,
			`<redacted>'"`,
		]);
		expect(getMessageText(ofType(trace, "tool_end")[0].result)).toBe('log: password="<redacted>"');
		await expectReplay(trace, 1);
	});
});

describe("trace replay mismatches", () => {
	async function recordedToolTrace(): Promise<Trace> {
		const { harness, recorder, path } = await tracedHarness({ tools: [echoTool(["working"])] });
		harness.setResponses([toolTurn(["echo", "hi", "call-1"]), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		return readClosed(recorder, path).trace;
	}

	it("reports changed prepared arguments, requested arguments, and tool names", async () => {
		const trace = await recordedToolTrace();

		const prepared = structuredClone(trace);
		ofType(prepared, "tool_executed")[0].preparedArgs = { text: "changed" };
		expect((await replayTrace(prepared)).mismatches.map((mismatch) => mismatch.kind)).toEqual(["tool_arguments"]);

		const requested = structuredClone(trace);
		ofType(requested, "tool_start")[0].args = { text: "changed" };
		const requestedResult = await replayTrace(requested);
		expect(requestedResult.mismatches[0]).toMatchObject({
			kind: "tool_arguments",
			seq: ofType(requested, "tool_start")[0].seq,
			runId: ofType(requested, "run_start")[0].runId,
		});

		const renamed = structuredClone(trace);
		ofType(renamed, "tool_start")[0].toolName = "other";
		expect((await replayTrace(renamed)).mismatches.map((mismatch) => mismatch.kind)).toEqual(["tool_name"]);
	});

	it("reports an unrecorded tool call ID without executing anything live", async () => {
		const trace = structuredClone(await recordedToolTrace());
		const [response] = ofType(trace, "model_response");
		const message = response.terminal.message as AssistantMessage;
		for (const block of message.content) if (block.type === "toolCall") block.id = "other-id";
		for (const record of ofType(trace, "model_frame")) {
			const frame = record.frame;
			if (frame.type === "toolcall_end") frame.id = "other-id";
			if (frame.type === "toolcall_start") (frame.toolCall as { id: string }).id = "other-id";
		}
		const result = await replayTrace(trace);
		expect(result.mismatches[0]).toMatchObject({ kind: "unexpected_tool_call", actual: "echo other-id" });
	});

	it("reports recorded boundaries the replay did not consume", async () => {
		const trace = structuredClone(await recordedToolTrace());
		const [response] = ofType(trace, "model_response");
		const message = response.terminal.message as AssistantMessage;
		message.content = [{ type: "text", text: "no tools" }];
		message.stopReason = "stop";
		response.terminal.reason = "stop";
		const requestId = response.requestId;
		trace.records = trace.records.filter(
			(record) =>
				!(record.type === "model_frame" && record.requestId === requestId && record.frame.type !== "start"),
		);
		const result = await replayTrace(trace);
		const kinds = result.mismatches.map((mismatch) => mismatch.kind);
		expect(kinds).toContain("missing_tool_call");
		expect(kinds).toContain("unconsumed_boundary");
	});

	it("reports changed tool-result transcript messages and model identity", async () => {
		const trace = await recordedToolTrace();

		const transcript = structuredClone(trace);
		const toolResult = ofType(transcript, "message").find(
			(record) => (record.message as AgentMessage).role === "toolResult",
		);
		(toolResult?.message as { content: unknown }).content = [{ type: "text", text: "different transcript result" }];
		const transcriptResult = await replayTrace(transcript);
		expect(transcriptResult.mismatches.map((mismatch) => mismatch.kind)).toEqual(["tool_result_message"]);
		expect(transcriptResult.mismatches[0].seq).toBe(toolResult?.seq);

		const identity = structuredClone(trace);
		const [response] = ofType(identity, "model_response");
		(response.terminal.message as AssistantMessage).model = "different-model";
		const identityResult = await replayTrace(identity);
		expect(identityResult.mismatches[0]).toMatchObject({ kind: "model_identity", seq: response.seq });
	});

	it("answers a model request beyond the recording with an error instead of a provider call", async () => {
		const trace = await recordedToolTrace();
		const replay = createTraceReplay(trace, ofType(trace, "run_start")[0].runId);
		const model = replay.model;
		const context = normalizeContext({ messages: [] });
		await (await replay.streamFn(model, context)).result();
		await (await replay.streamFn(model, context)).result();
		const extra = await (await replay.streamFn(model, context)).result();
		expect(extra.stopReason).toBe("error");
		expect(replay.mismatches.map((mismatch) => mismatch.kind)).toEqual(["extra_model_request"]);
	});
});
