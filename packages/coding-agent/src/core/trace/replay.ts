/**
 * Offline replay of recorded agent runs.
 *
 * Each structurally complete run is replayed through a real agent-core `Agent` whose provider
 * stream, tools, and tool hooks are adapters over the recorded boundaries. No provider,
 * credential, extension, network access, or real tool is involved. Turn boundaries follow the
 * recording; everything inside a turn (stream consumption, argument validation, tool dispatch,
 * hook application, result construction) is the real loop. See docs/traces.md.
 */

import { isDeepStrictEqual } from "node:util";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type FinishTurn,
	type PrepareRequest,
	type StreamFn,
	type ThinkingLevel,
	type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	parseStreamingJson,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	type Trace,
	type TraceModelRef,
	type TraceRecord,
	type TraceRecordOf,
	type TraceToolDefinition,
	toolKey,
} from "./format.ts";

export interface TraceReplayMismatch {
	runId: string;
	/** Seq of the recorded record the replay disagreed with or did not consume. */
	seq: number;
	kind:
		| "extra_model_request"
		| "unconsumed_model_response"
		| "unexpected_tool_call"
		| "missing_tool_call"
		| "tool_name"
		| "tool_arguments"
		| "tool_result"
		| "tool_order"
		| "unexpected_boundary"
		| "unconsumed_boundary"
		| "stalled"
		| "turn_count"
		| "model_identity"
		| "tool_result_message";
	expected: string;
	actual: string;
}

/** Normalized replay observation: no timestamps or replay-generated IDs. */
export interface TraceReplayEvent {
	runId: string;
	type: string;
	toolCallId?: string;
	detail?: string;
}

export interface TraceReplayResult {
	/** The trace was complete and every recorded run was replayable. */
	complete: boolean;
	runs: number;
	modelResponses: number;
	toolCalls: number;
	events: TraceReplayEvent[];
	mismatches: TraceReplayMismatch[];
	/** Recorded data that replay could not reproduce exactly, such as omitted images. */
	fidelity: string[];
	/** Runs that were not replayed because the trace ends before they finish. */
	incompleteRuns: string[];
}

type SessionRequest = {
	request: TraceRecordOf<"model_request">;
	frames: TraceRecordOf<"model_frame">[];
	response: TraceRecordOf<"model_response">;
	replacement?: AssistantMessage;
};

type RecordedTool = {
	start: TraceRecordOf<"tool_start">;
	updates: TraceRecordOf<"tool_update">[];
	executed?: TraceRecordOf<"tool_executed">;
	before?: TraceRecordOf<"tool_hook">;
	after?: TraceRecordOf<"tool_hook">;
	end: TraceRecordOf<"tool_end">;
};

interface RecordedRun {
	start: TraceRecordOf<"run_start">;
	end: TraceRecordOf<"run_end">;
	requests: SessionRequest[];
	prompts: TraceRecordOf<"message">[];
	tools: Map<string, RecordedTool>;
	/**
	 * Seqs of tool updates, raw results, hook decisions, and completions in recorded order.
	 * Adapters release the first four; the observer consumes completions.
	 */
	boundaries: number[];
	/** Tool-result messages the session recorded, in transcript order. */
	toolResults: TraceRecordOf<"message">[];
	cancelSeq?: number;
	turns: number;
}

const IMAGE_PLACEHOLDER = "[image omitted from trace]";

/** Replace typed image omissions with a valid text block; never pass a marker as an image. */
function toLive<T>(value: T, onOmission?: () => void): T {
	if (Array.isArray(value)) return value.map((item) => toLive(item, onOmission)) as T;
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	if (record.type === "image" && record.omitted === true) {
		onOmission?.();
		return { type: "text", text: IMAGE_PLACEHOLDER } as T;
	}
	return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, toLive(child, onOmission)])) as T;
}

function normalize(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function describe(value: unknown): string {
	const text = JSON.stringify(value) ?? "undefined";
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function stubModel(ref: TraceModelRef): Model<Api> {
	return {
		id: ref.id,
		name: ref.id,
		api: ref.api,
		provider: ref.provider,
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	};
}

function textOf(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Collect every run whose own records are complete: run_end, all responses, and all tool ends. */
function collectRuns(trace: Trace): { runs: RecordedRun[]; incomplete: string[] } {
	const byRun = new Map<string, TraceRecord[]>();
	const runOfRequest = new Map<string, string>();
	const order: string[] = [];
	for (const record of trace.records) {
		let runId: string | undefined;
		if (record.type === "model_frame" || record.type === "model_response") runId = runOfRequest.get(record.requestId);
		else if (record.type === "model_request") {
			if (record.kind === "session" && record.runId) {
				runId = record.runId;
				runOfRequest.set(record.requestId, runId);
			}
		} else if ("runId" in record && typeof record.runId === "string" && record.type !== "error") runId = record.runId;
		if (!runId) continue;
		if (!byRun.has(runId)) {
			byRun.set(runId, []);
			order.push(runId);
		}
		byRun.get(runId)!.push(record);
	}

	const runs: RecordedRun[] = [];
	const incomplete: string[] = [];
	for (const runId of order) {
		const records = byRun.get(runId)!;
		const start = records.find((record) => record.type === "run_start");
		const end = records.find((record) => record.type === "run_end");
		const requests: SessionRequest[] = [];
		const tools = new Map<string, RecordedTool>();
		const partialTools = new Map<string, Partial<RecordedTool>>();
		const prompts: TraceRecordOf<"message">[] = [];
		const toolResults: TraceRecordOf<"message">[] = [];
		const boundaries: number[] = [];
		let cancelSeq: number | undefined;
		let turns = 0;
		let complete = start !== undefined && end !== undefined;
		for (const record of records) {
			switch (record.type) {
				case "model_request":
					requests.push({ request: record, frames: [], response: undefined as never });
					break;
				case "model_frame":
					requests.find((request) => request.request.requestId === record.requestId)?.frames.push(record);
					break;
				case "model_response": {
					const request = requests.find((candidate) => candidate.request.requestId === record.requestId);
					if (request) request.response = record;
					break;
				}
				case "message":
					if (record.requestId !== undefined) {
						const request = requests.find((candidate) => candidate.request.requestId === record.requestId);
						if (request) request.replacement = record.message as AssistantMessage;
					} else if ((record.message as { role?: string }).role === "toolResult") {
						toolResults.push(record);
					} else if (requests.length === 0 && (record.message as { role?: string }).role !== "assistant") {
						prompts.push(record);
					}
					break;
				case "turn_start":
					turns++;
					break;
				case "cancel":
					cancelSeq ??= record.seq;
					break;
				case "tool_start":
					partialTools.set(toolKey(record.requestId, record.toolCallId), { start: record, updates: [] });
					break;
				case "tool_update": {
					const key = toolKey(record.requestId, record.toolCallId);
					partialTools.get(key)?.updates?.push(record);
					boundaries.push(record.seq);
					break;
				}
				case "tool_executed":
				case "tool_hook": {
					const tool = partialTools.get(toolKey(record.requestId, record.toolCallId));
					if (tool && record.type === "tool_executed") tool.executed = record;
					else if (tool && record.type === "tool_hook") {
						if (record.hook === "before_tool_call") tool.before = record;
						else tool.after = record;
					}
					boundaries.push(record.seq);
					break;
				}
				case "tool_end": {
					const key = toolKey(record.requestId, record.toolCallId);
					const tool = partialTools.get(key);
					if (tool) tool.end = record;
					boundaries.push(record.seq);
					break;
				}
			}
		}
		if (requests.some((request) => request.response === undefined)) complete = false;
		for (const [key, tool] of partialTools) {
			if (!tool.end) complete = false;
			else tools.set(key, tool as RecordedTool);
		}
		if (!complete || !start || !end) {
			incomplete.push(runId);
			continue;
		}
		runs.push({
			start: start as TraceRecordOf<"run_start">,
			end: end as TraceRecordOf<"run_end">,
			requests,
			prompts,
			tools,
			boundaries,
			toolResults,
			cancelSeq,
			turns,
		});
	}
	return { runs, incomplete };
}

/** Rebuild provider stream events from recorded frames, applying each frame once. */
function streamFromFrames(recorded: SessionRequest): {
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
} {
	const stream = createAssistantMessageEventStream();
	let partial: AssistantMessage | undefined;
	const json = new Map<number, string>();
	// Each event carries a snapshot, so a consumer sees the recorded intermediate state even
	// though the whole stream is queued before it reads the first event.
	const push = (event: AssistantMessageEvent) => stream.push(event);
	const snapshot = () => structuredClone(partial) as AssistantMessage;
	for (const { frame } of recorded.frames) {
		if (frame.type === "start") {
			partial = structuredClone(frame.partial as AssistantMessage);
			push({ type: "start", partial: snapshot() });
			continue;
		}
		if (!partial || frame.contentIndex === undefined) continue;
		const contentIndex = frame.contentIndex;
		const block = partial.content[contentIndex];
		switch (frame.type) {
			case "text_start":
				partial.content.push(structuredClone(frame.content as TextContent));
				push({ type: "text_start", contentIndex, partial: snapshot() });
				break;
			case "text_delta":
				if (block?.type === "text") block.text += String(frame.delta);
				push({ type: "text_delta", contentIndex, delta: String(frame.delta), partial: snapshot() });
				break;
			case "text_end":
				if (block?.type === "text") {
					block.text = String(frame.content);
					if (typeof frame.textSignature === "string") block.textSignature = frame.textSignature;
				}
				push({ type: "text_end", contentIndex, content: String(frame.content), partial: snapshot() });
				break;
			case "thinking_start":
				partial.content.push(structuredClone(frame.content as ThinkingContent));
				push({ type: "thinking_start", contentIndex, partial: snapshot() });
				break;
			case "thinking_delta":
				if (block?.type === "thinking") block.thinking += String(frame.delta);
				push({ type: "thinking_delta", contentIndex, delta: String(frame.delta), partial: snapshot() });
				break;
			case "thinking_end":
				if (block?.type === "thinking") {
					block.thinking = String(frame.content);
					if (typeof frame.thinkingSignature === "string") block.thinkingSignature = frame.thinkingSignature;
					if (typeof frame.redacted === "boolean") block.redacted = frame.redacted;
				}
				push({ type: "thinking_end", contentIndex, content: String(frame.content), partial: snapshot() });
				break;
			case "toolcall_start":
				partial.content.push(structuredClone(frame.toolCall as ToolCall));
				json.set(contentIndex, "");
				push({ type: "toolcall_start", contentIndex, partial: snapshot() });
				break;
			case "toolcall_checkpoint":
			case "toolcall_delta": {
				const delta = String(frame.type === "toolcall_checkpoint" ? frame.json : frame.delta);
				const next = frame.type === "toolcall_checkpoint" ? delta : (json.get(contentIndex) ?? "") + delta;
				json.set(contentIndex, next);
				if (block?.type === "toolCall" && next.length > 0) block.arguments = parseStreamingJson(next);
				push({ type: "toolcall_delta", contentIndex, delta, partial: snapshot() });
				break;
			}
			case "toolcall_end":
				if (block?.type === "toolCall") {
					block.id = String(frame.id);
					block.name = String(frame.name);
					block.arguments = structuredClone(frame.arguments as ToolCall["arguments"]);
					if (typeof frame.thoughtSignature === "string") block.thoughtSignature = frame.thoughtSignature;
					if (typeof frame.namespace === "string") block.namespace = frame.namespace;
				}
				push({
					type: "toolcall_end",
					contentIndex,
					toolCall: structuredClone(block as ToolCall),
					partial: snapshot(),
				});
				break;
		}
	}
	const message = structuredClone(recorded.response.terminal.message as AssistantMessage);
	const failure = recorded.response.error;
	if (failure !== undefined) {
		// The recorded stream failed after these frames: deliver them, then fail as it did.
		const events = stream[Symbol.asyncIterator].bind(stream);
		stream.end();
		stream[Symbol.asyncIterator] = async function* () {
			const queued = events();
			for (let next = await queued.next(); !next.done; next = await queued.next()) yield next.value;
			throw new Error(failure);
		};
		stream.result = () => Promise.reject(new Error(failure));
	} else if (message.stopReason === "error" || message.stopReason === "aborted") {
		push({ type: "error", reason: message.stopReason, error: message });
	} else {
		push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred", message });
	}
	return { stream, message };
}

function errorStream(model: Model<Api>, reason: "error" | "aborted", message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason,
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: reason,
			errorMessage: message,
			timestamp: 0,
		},
	});
	return stream;
}

class ReplayFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReplayFailure";
	}
}

/** Adapters that drive one recorded run through a real Agent. */
export interface TraceRunReplay {
	runId: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	toolExecution: ToolExecutionMode;
	tools: AgentTool[];
	/** Messages recorded before the run's first model request. Empty for continuation runs. */
	prompts: AgentMessage[];
	streamFn: StreamFn;
	prepareRequest: PrepareRequest;
	finishTurn: FinishTurn;
	beforeToolCall: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall: (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
	/** Agent event listener that compares observations with the recording. */
	observe: (event: AgentEvent) => void;
	/** Connect the agent so a mismatch can abort it. */
	bind: (agent: Agent) => void;
	/** Report boundaries the run did not consume. Call after the run settles. */
	finish: () => void;
	readonly mismatches: TraceReplayMismatch[];
	readonly events: TraceReplayEvent[];
	readonly fidelity: string[];
}

class RunReplay implements TraceRunReplay {
	readonly runId: string;
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly toolExecution: ToolExecutionMode;
	readonly tools: AgentTool[];
	readonly prompts: AgentMessage[];
	readonly mismatches: TraceReplayMismatch[] = [];
	readonly events: TraceReplayEvent[] = [];
	readonly fidelity: string[] = [];
	private readonly run: RecordedRun;
	private readonly toolsByDefinition = new Map<string, AgentTool>();
	private agent: Agent | undefined;
	private served = 0;
	private turns = 0;
	private toolResultIndex = 0;
	private cursor = 0;
	private cancelled = false;
	private failure: ReplayFailure | undefined;
	private readonly waiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
	private stallCheck: { position: number; ticks: number } | undefined;
	private readonly servedMessages = new WeakMap<object, SessionRequest>();
	private readonly started = new Set<string>();

	constructor(run: RecordedRun) {
		this.run = run;
		this.runId = run.start.runId;
		this.model = stubModel(run.start.model);
		this.thinkingLevel = run.start.thinkingLevel as ThinkingLevel;
		this.toolExecution = run.start.toolExecution;
		this.tools = this.toolsForRequest(0);
		this.prompts = run.prompts.map((record) => this.live(record.message) as AgentMessage);
	}

	private live<T>(value: T): T {
		return toLive(value, () => {
			const note = `run ${this.runId}: an omitted image was replaced with a text placeholder`;
			if (!this.fidelity.includes(note)) this.fidelity.push(note);
		});
	}

	private toolsForRequest(index: number): AgentTool[] {
		let definitions: TraceToolDefinition[] = [];
		for (let position = 0; position <= Math.min(index, this.run.requests.length - 1); position++) {
			definitions = this.run.requests[position].request.tools ?? definitions;
		}
		return definitions.map((definition) => {
			const key = JSON.stringify(definition);
			let tool = this.toolsByDefinition.get(key);
			if (!tool) {
				tool = {
					name: definition.name,
					label: definition.name,
					description: definition.description,
					parameters: definition.parameters as AgentTool["parameters"],
					...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
					execute: (toolCallId, params, _signal, onUpdate) =>
						this.execute(definition.name, toolCallId, params, onUpdate),
				};
				this.toolsByDefinition.set(key, tool);
			}
			return tool;
		});
	}

	bind = (agent: Agent): void => {
		this.agent = agent;
	};

	private get currentRequest(): SessionRequest | undefined {
		return this.run.requests[this.served - 1];
	}

	private mismatch(mismatch: Omit<TraceReplayMismatch, "runId">): ReplayFailure {
		const failure = new ReplayFailure(`Replay mismatch (${mismatch.kind}) at seq ${mismatch.seq}`);
		if (this.failure) return this.failure;
		this.failure = failure;
		this.mismatches.push({ runId: this.runId, ...mismatch });
		for (const waiter of this.waiters.values()) waiter.reject(failure);
		this.waiters.clear();
		this.agent?.abort();
		return failure;
	}

	/** Abort before serving the first boundary recorded after cancellation. */
	private beforeBoundary(seq: number): void {
		if (this.run.cancelSeq !== undefined && !this.cancelled && seq > this.run.cancelSeq) {
			this.cancelled = true;
			this.agent?.abort();
		}
	}

	/**
	 * Wait until `seq` is the next recorded boundary. The caller acts on it, then calls
	 * `advance()`, so an observable effect happens before any later boundary is released.
	 */
	private async reach(seq: number): Promise<void> {
		if (this.failure) throw this.failure;
		const position = this.run.boundaries.indexOf(seq);
		if (position < this.cursor) {
			throw this.mismatch({
				kind: "unexpected_boundary",
				seq,
				expected: `boundary seq ${this.run.boundaries[this.cursor] ?? "none"}`,
				actual: `boundary seq ${seq}`,
			});
		}
		if (position !== this.cursor) {
			await new Promise<void>((resolve, reject) => {
				this.waiters.set(seq, { resolve, reject });
				this.scheduleStallCheck();
			});
		}
		this.beforeBoundary(seq);
	}

	private advance(): void {
		this.cursor++;
		const next = this.run.boundaries[this.cursor];
		const waiter = next === undefined ? undefined : this.waiters.get(next);
		if (waiter && next !== undefined) {
			this.waiters.delete(next);
			waiter.resolve();
		}
	}

	/**
	 * Replay does no I/O, so once microtasks drain with every adapter blocked on a later boundary,
	 * the loop cannot reach the next recorded one. Blocked waiters are not progress.
	 */
	private scheduleStallCheck(): void {
		if (this.stallCheck) return;
		this.stallCheck = { position: this.cursor, ticks: 0 };
		const check = () => {
			const state = this.stallCheck;
			if (!state || this.failure) {
				this.stallCheck = undefined;
				return;
			}
			const next = this.run.boundaries[this.cursor];
			if (this.waiters.size === 0 || (next !== undefined && this.waiters.has(next))) {
				this.stallCheck = undefined;
				return;
			}
			if (state.position !== this.cursor) {
				state.position = this.cursor;
				state.ticks = 0;
			} else if (++state.ticks >= 2) {
				this.stallCheck = undefined;
				this.mismatch({
					kind: "stalled",
					seq: next ?? this.run.end.seq,
					expected: `boundary seq ${next ?? "none"}`,
					actual: `adapters waiting for seq ${[...this.waiters.keys()].join(", ")}`,
				});
				return;
			}
			setImmediate(check);
		};
		setImmediate(check);
	}

	private recordedTool(toolCallId: string, name: string, seq: number): RecordedTool {
		const request = this.currentRequest;
		const tool = request ? this.run.tools.get(toolKey(request.request.requestId, toolCallId)) : undefined;
		if (!tool) {
			throw this.mismatch({
				kind: "unexpected_tool_call",
				seq,
				expected: "no tool call",
				actual: `${name} ${toolCallId}`,
			});
		}
		if (tool.start.toolName !== name) {
			throw this.mismatch({ kind: "tool_name", seq: tool.start.seq, expected: tool.start.toolName, actual: name });
		}
		return tool;
	}

	private async execute(
		name: string,
		toolCallId: string,
		params: unknown,
		onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
	): Promise<AgentToolResult<unknown>> {
		const seq = this.currentRequest?.response.seq ?? this.run.end.seq;
		const tool = this.recordedTool(toolCallId, name, seq);
		const executed = tool.executed;
		if (!executed) {
			throw this.mismatch({
				kind: "unexpected_boundary",
				seq: tool.end.seq,
				expected: "not executed",
				actual: "executed",
			});
		}
		if (!isDeepStrictEqual(normalize(params), normalize(executed.preparedArgs))) {
			throw this.mismatch({
				kind: "tool_arguments",
				seq: executed.seq,
				expected: describe(executed.preparedArgs),
				actual: describe(params),
			});
		}
		for (const update of tool.updates) {
			await this.reach(update.seq);
			onUpdate?.(this.live(update.partialResult) as AgentToolResult<unknown>);
			this.advance();
		}
		await this.reach(executed.seq);
		this.advance();
		if (executed.isError) throw new Error(textOf(executed.result));
		return this.live(structuredClone(executed.result)) as AgentToolResult<unknown>;
	}

	beforeToolCall = async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const seq = this.currentRequest?.response.seq ?? this.run.end.seq;
		const tool = this.recordedTool(context.toolCall.id, context.toolCall.name, seq);
		if (!tool.before) {
			throw this.mismatch({
				kind: "unexpected_boundary",
				seq: tool.end.seq,
				expected: "no before_tool_call",
				actual: "before_tool_call",
			});
		}
		await this.reach(tool.before.seq);
		this.advance();
		if (tool.before.error !== undefined) throw new Error(tool.before.error);
		return structuredClone(tool.before.result) as BeforeToolCallResult | undefined;
	};

	afterToolCall = async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
		const seq = this.currentRequest?.response.seq ?? this.run.end.seq;
		const tool = this.recordedTool(context.toolCall.id, context.toolCall.name, seq);
		if (!tool.after) {
			throw this.mismatch({
				kind: "unexpected_boundary",
				seq: tool.end.seq,
				expected: "no after_tool_call",
				actual: "after_tool_call",
			});
		}
		await this.reach(tool.after.seq);
		this.advance();
		if (tool.after.error !== undefined) throw new Error(tool.after.error);
		return this.live(structuredClone(tool.after.result)) as AfterToolCallResult | undefined;
	};

	prepareRequest: PrepareRequest = (request) => {
		const recorded = this.run.requests[this.served];
		if (!recorded) return undefined;
		return {
			model: stubModel(recorded.request.model),
			context: { ...request.context, tools: this.toolsForRequest(this.served) },
		};
	};

	finishTurn: FinishTurn = () => ({
		action: !this.failure && this.served < this.run.requests.length ? "continue" : "end",
	});

	streamFn: StreamFn = (model) => {
		if (this.failure) return errorStream(model, "aborted", this.failure.message);
		const recorded = this.run.requests[this.served];
		if (!recorded) {
			const failure = this.mismatch({
				kind: "extra_model_request",
				seq: this.run.end.seq,
				expected: `${this.run.requests.length} model requests`,
				actual: `request ${this.served + 1}`,
			});
			return errorStream(model, "error", failure.message);
		}
		this.served++;
		this.beforeBoundary(recorded.request.seq);
		const terminal = recorded.response.terminal.message as AssistantMessage;
		const requested = recorded.request.model;
		if (
			terminal.provider !== requested.provider ||
			terminal.api !== requested.api ||
			terminal.model !== requested.id
		) {
			const failure = this.mismatch({
				kind: "model_identity",
				seq: recorded.response.seq,
				expected: `${requested.provider}/${requested.id} (${requested.api})`,
				actual: `${terminal.provider}/${terminal.model} (${terminal.api})`,
			});
			return errorStream(model, "error", failure.message);
		}
		// A stream function that threw before producing anything is replayed as a throw.
		if (recorded.response.error !== undefined && recorded.frames.length === 0) {
			throw new Error(recorded.response.error);
		}
		const { stream, message } = streamFromFrames(recorded);
		this.servedMessages.set(message, recorded);
		return stream;
	};

	observe = (event: AgentEvent): void => {
		switch (event.type) {
			case "turn_start":
				this.turns++;
				this.events.push({ runId: this.runId, type: "turn_start" });
				break;
			case "message_end": {
				if (event.message.role === "toolResult") {
					this.compareToolResultMessage(event.message);
					break;
				}
				if (event.message.role !== "assistant") break;
				const recorded = this.servedMessages.get(event.message);
				// A recorded message_end replacement is applied in place, as AgentSession does.
				if (recorded?.replacement) {
					const target = event.message as unknown as Record<string, unknown>;
					for (const key of Object.keys(target)) delete target[key];
					Object.assign(target, this.live(structuredClone(recorded.replacement)));
				}
				this.events.push({ runId: this.runId, type: "model_response", detail: event.message.stopReason });
				break;
			}
			case "tool_execution_start": {
				this.events.push({
					runId: this.runId,
					type: "tool_start",
					toolCallId: event.toolCallId,
					detail: event.toolName,
				});
				if (this.failure) break;
				const request = this.currentRequest;
				const key = request ? toolKey(request.request.requestId, event.toolCallId) : "";
				const tool = this.run.tools.get(key);
				if (!tool) {
					this.mismatch({
						kind: "unexpected_tool_call",
						seq: request?.response.seq ?? this.run.end.seq,
						expected: "no tool call",
						actual: `${event.toolName} ${event.toolCallId}`,
					});
					break;
				}
				this.started.add(key);
				if (!isDeepStrictEqual(normalize(event.args), normalize(this.live(tool.start.args)))) {
					this.mismatch({
						kind: "tool_arguments",
						seq: tool.start.seq,
						expected: describe(tool.start.args),
						actual: describe(event.args),
					});
				}
				break;
			}
			case "tool_execution_update":
				this.events.push({ runId: this.runId, type: "tool_update", toolCallId: event.toolCallId });
				break;
			case "tool_execution_end": {
				this.events.push({ runId: this.runId, type: "tool_end", toolCallId: event.toolCallId });
				if (this.failure) break;
				const request = this.currentRequest;
				const tool = request ? this.run.tools.get(toolKey(request.request.requestId, event.toolCallId)) : undefined;
				const expected = this.run.boundaries[this.cursor];
				if (!tool || expected !== tool.end.seq) {
					this.mismatch({
						kind: "tool_order",
						seq: expected ?? this.run.end.seq,
						expected: `boundary seq ${expected ?? "none"}`,
						actual: `completion of ${event.toolCallId}`,
					});
					break;
				}
				this.beforeBoundary(tool.end.seq);
				this.advance();
				const recorded = normalize({ result: this.live(tool.end.result), isError: tool.end.isError });
				const actual = normalize({ result: event.result, isError: event.isError });
				if (!isDeepStrictEqual(actual, recorded)) {
					this.mismatch({
						kind: "tool_result",
						seq: tool.end.seq,
						expected: describe(recorded),
						actual: describe(actual),
					});
				}
				break;
			}
			case "agent_end":
				this.events.push({ runId: this.runId, type: "run_end" });
				break;
		}
	};

	private compareToolResultMessage(message: AgentMessage): void {
		if (this.failure) return;
		const recorded = this.run.toolResults[this.toolResultIndex++];
		const comparable = (value: unknown) => {
			const { role, toolCallId, toolName, content, details, isError, usage } = value as Record<string, unknown>;
			return normalize({ role, toolCallId, toolName, content, details, isError, usage });
		};
		if (!recorded) {
			this.mismatch({
				kind: "tool_result_message",
				seq: this.run.end.seq,
				expected: "no tool result message",
				actual: describe(comparable(message)),
			});
			return;
		}
		const expected = comparable(this.live(recorded.message));
		const actual = comparable(message);
		if (!isDeepStrictEqual(actual, expected)) {
			this.mismatch({
				kind: "tool_result_message",
				seq: recorded.seq,
				expected: describe(expected),
				actual: describe(actual),
			});
		}
	}

	finish = (): void => {
		if (this.failure) return;
		for (const recorded of this.run.toolResults.slice(this.toolResultIndex)) {
			this.mismatches.push({
				runId: this.runId,
				seq: recorded.seq,
				kind: "tool_result_message",
				expected: "tool result message",
				actual: "none",
			});
		}
		for (const recorded of this.run.requests.slice(this.served)) {
			this.mismatches.push({
				runId: this.runId,
				seq: recorded.response.seq,
				kind: "unconsumed_model_response",
				expected: "model request",
				actual: "none",
			});
		}
		for (const [key, tool] of this.run.tools) {
			if (this.started.has(key)) continue;
			this.mismatches.push({
				runId: this.runId,
				seq: tool.start.seq,
				kind: "missing_tool_call",
				expected: `${tool.start.toolName} ${tool.start.toolCallId}`,
				actual: "none",
			});
		}
		for (const seq of this.run.boundaries.slice(this.cursor)) {
			this.mismatches.push({
				runId: this.runId,
				seq,
				kind: "unconsumed_boundary",
				expected: `seq ${seq}`,
				actual: "none",
			});
		}
		if (this.turns !== this.run.turns) {
			this.mismatches.push({
				runId: this.runId,
				seq: this.run.end.seq,
				kind: "turn_count",
				expected: String(this.run.turns),
				actual: String(this.turns),
			});
		}
	};
}

/** Build replay adapters for one recorded run. Throws if the run is not complete in the trace. */
export function createTraceReplay(trace: Trace, runId: string): TraceRunReplay {
	const run = collectRuns(trace).runs.find((candidate) => candidate.start.runId === runId);
	if (!run) throw new Error(`Run ${runId} is not complete in this trace`);
	return new RunReplay(run);
}

async function replayRun(replay: TraceRunReplay): Promise<void> {
	const agent = new Agent({
		initialState: { model: replay.model, thinkingLevel: replay.thinkingLevel, tools: replay.tools },
		streamFn: replay.streamFn,
		prepareRequest: replay.prepareRequest,
		finishTurn: replay.finishTurn,
		beforeToolCall: replay.beforeToolCall,
		afterToolCall: replay.afterToolCall,
		toolExecution: replay.toolExecution,
	});
	replay.bind(agent);
	agent.subscribe((event) => replay.observe(event));
	await agent.prompt(replay.prompts);
	replay.finish();
}

/**
 * Replay every structurally complete run in the trace, in order. Never calls a provider, tool,
 * or extension; a deviation from the recording is reported as a mismatch.
 */
export async function replayTrace(trace: Trace): Promise<TraceReplayResult> {
	const { runs, incomplete } = collectRuns(trace);
	const result: TraceReplayResult = {
		complete: trace.complete && incomplete.length === 0,
		runs: runs.length,
		modelResponses: 0,
		toolCalls: 0,
		events: [],
		mismatches: [],
		fidelity: [],
		incompleteRuns: incomplete,
	};
	for (const run of runs) {
		const replay = new RunReplay(run);
		await replayRun(replay);
		result.modelResponses += run.requests.length;
		result.toolCalls += run.tools.size;
		result.events.push(...replay.events);
		result.mismatches.push(...replay.mismatches);
		result.fidelity.push(...replay.fidelity);
	}
	return result;
}
