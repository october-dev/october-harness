/**
 * Versioned JSONL execution trace format.
 *
 * A trace is one header record followed by one record per observation, each with a contiguous
 * `seq`. Payload fields (messages, frames, tool arguments and results) hold redacted snapshots,
 * so they are typed as trace payloads rather than live agent types. See docs/traces.md.
 */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type AssistantMessageFrame, reduceAssistantMessageFrames } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const TRACE_FORMAT = "pi-trace";
export const TRACE_FORMAT_VERSION = 1;

export interface TraceModelRef {
	provider: string;
	id: string;
	api: string;
}

export interface TraceToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
	executionMode?: "sequential" | "parallel";
}

/** Assistant stream frame as stored in a trace. Content fields may be redacted or omitted. */
export interface TraceFrame {
	type: string;
	contentIndex?: number;
	[key: string]: unknown;
}

interface RecordBase {
	seq: number;
	/** Observation time in milliseconds since the Unix epoch. */
	ts: number;
}

export type TraceHeaderRecord = RecordBase & {
	type: "header";
	format: typeof TRACE_FORMAT;
	version: number;
	traceId: string;
	createdAt: string;
	harness: { name: string; version: string };
};

export type TraceRecordBody =
	| { type: "session_attach"; sessionId: string }
	| { type: "session_detach"; sessionId: string; openOperations: number }
	| { type: "session"; sessionId: string; event: string; data: unknown }
	| { type: "message"; sessionId: string; runId?: string; turn?: number; requestId?: string; message: unknown }
	| {
			type: "run_start";
			sessionId: string;
			runId: string;
			model: TraceModelRef;
			thinkingLevel: string;
			toolExecution: "sequential" | "parallel";
	  }
	| { type: "run_end"; runId: string; willRetry: boolean }
	| { type: "turn_start"; runId: string; turn: number }
	| { type: "turn_end"; runId: string; turn: number }
	| {
			type: "model_request";
			requestId: string;
			kind: "session" | "auxiliary";
			runId?: string;
			turn?: number;
			model: TraceModelRef;
			/** Active tool definitions, present on a session request when they changed within the run. */
			tools?: TraceToolDefinition[];
	  }
	| { type: "model_frame"; requestId: string; frame: TraceFrame }
	| {
			type: "model_response";
			requestId: string;
			terminal: { reason: string; message: unknown };
			/** Set when the stream function threw or rejected instead of returning a stream. */
			error?: string;
	  }
	| { type: "tool_start"; runId: string; requestId: string; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_update"; runId: string; requestId: string; toolCallId: string; partialResult: unknown }
	| {
			type: "tool_executed";
			runId: string;
			requestId: string;
			toolCallId: string;
			preparedArgs: unknown;
			result: unknown;
			isError: boolean;
	  }
	| {
			type: "tool_hook";
			runId: string;
			requestId: string;
			toolCallId: string;
			hook: "before_tool_call" | "after_tool_call";
			result?: unknown;
			error?: string;
	  }
	| { type: "tool_end"; runId: string; requestId: string; toolCallId: string; result: unknown; isError: boolean }
	| { type: "hook"; hookId: string; phase: "start"; event: string; extensionPath: string; handlerIndex: number }
	| { type: "hook"; hookId: string; phase: "end"; status: "ok" | "error"; returned?: boolean; error?: string }
	| { type: "cancel"; runId: string }
	| {
			type: "error";
			source: "model" | "tool" | "hook";
			message: string;
			runId?: string;
			requestId?: string;
			toolCallId?: string;
			hookId?: string;
	  }
	| { type: "trace_end"; eventCount: number };

export type TraceRecord = TraceHeaderRecord | (RecordBase & TraceRecordBody);
export type TraceRecordOf<TType extends TraceRecord["type"]> = Extract<TraceRecord, { type: TType }>;

export interface Trace {
	header: TraceHeaderRecord;
	/** All records including the header, in file order. */
	records: TraceRecord[];
	/** True when the trace ends with a valid `trace_end` and nothing is unfinished. */
	complete: boolean;
	/** Why the trace is incomplete. Empty for a complete trace. */
	incomplete: string[];
}

/** The file does not follow the trace format. Messages carry line/seq context, never record content. */
export class TraceFormatError extends Error {
	readonly line?: number;
	readonly seq?: number;

	constructor(message: string, location: { line?: number; seq?: number } = {}) {
		const where = [
			location.line === undefined ? undefined : `line ${location.line}`,
			location.seq === undefined ? undefined : `seq ${location.seq}`,
		].filter((part) => part !== undefined);
		super(where.length > 0 ? `Invalid trace (${where.join(", ")}): ${message}` : `Invalid trace: ${message}`);
		this.name = "TraceFormatError";
		this.line = location.line;
		this.seq = location.seq;
	}
}

export class UnsupportedTraceVersionError extends TraceFormatError {
	readonly version: unknown;

	constructor(version: unknown) {
		super(
			`unsupported trace version ${typeof version === "number" ? version : `(${typeof version})`}; this build reads version ${TRACE_FORMAT_VERSION}`,
			{ line: 1, seq: 0 },
		);
		this.name = "UnsupportedTraceVersionError";
		this.version = version;
	}
}

const Str = Type.String();
const Int = Type.Integer({ minimum: 0 });
const Opt = <T extends TSchema>(schema: T) => Type.Optional(schema);
const Obj = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties);

const Num = Type.Number();
const Bool = Type.Boolean();
const ModelRef = Obj({ provider: Str, id: Str, api: Str });
const ToolDefinition = Obj({
	name: Str,
	description: Str,
	parameters: Type.Unknown(),
	executionMode: Opt(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")])),
});
const TextBlock = Obj({ type: Type.Literal("text"), text: Str, textSignature: Opt(Str) });
const ThinkingBlock = Obj({
	type: Type.Literal("thinking"),
	thinking: Str,
	thinkingSignature: Opt(Str),
	redacted: Opt(Bool),
});
const ToolCallBlock = Obj({
	type: Type.Literal("toolCall"),
	id: Str,
	name: Str,
	arguments: Type.Record(Str, Type.Unknown()),
	thoughtSignature: Opt(Str),
	namespace: Opt(Str),
});
/** Image data, or the typed omission written by redaction. */
const ImageBlock = Type.Union([
	Obj({ type: Type.Literal("image"), data: Str, mimeType: Str }),
	Obj({ type: Type.Literal("image"), omitted: Type.Literal(true), mimeType: Opt(Str), bytes: Int }),
]);
const UserContent = Type.Union([Str, Type.Array(Type.Union([TextBlock, ImageBlock]))]);
const Usage = Obj({
	input: Num,
	output: Num,
	cacheRead: Num,
	cacheWrite: Num,
	totalTokens: Num,
	cost: Obj({ input: Num, output: Num, cacheRead: Num, cacheWrite: Num, total: Num }),
});
const SETTLED_STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted", "deferred"] as const;
const assistantMessage = (stopReason: TSchema) =>
	Obj({
		role: Type.Literal("assistant"),
		content: Type.Array(Type.Union([TextBlock, ThinkingBlock, ToolCallBlock])),
		api: Str,
		provider: Str,
		model: Str,
		usage: Usage,
		stopReason,
		errorMessage: Opt(Str),
		timestamp: Num,
	});
const AssistantMessage = assistantMessage(Type.Union(SETTLED_STOP_REASONS.map((reason) => Type.Literal(reason))));
const PartialAssistantMessage = assistantMessage(Type.Literal("pending"));
/** Message schemas by role. Roles not listed here (extension message types) need only a role. */
const MESSAGE_SCHEMAS: Record<string, TSchema> = {
	assistant: AssistantMessage,
	user: Obj({ role: Type.Literal("user"), content: UserContent, timestamp: Num }),
	system: Obj({ role: Type.Literal("system"), content: Str }),
	custom: Obj({ role: Type.Literal("custom"), customType: Str, content: UserContent, timestamp: Num }),
	toolResult: Obj({
		role: Type.Literal("toolResult"),
		toolCallId: Str,
		toolName: Str,
		content: Type.Array(Type.Union([TextBlock, ImageBlock])),
		isError: Bool,
		timestamp: Num,
	}),
};
const Message = Obj({ role: Str });
const ToolResult = Obj({ content: Opt(Type.Array(Type.Union([TextBlock, ImageBlock]))) });
const Index = { contentIndex: Int };
const Frame = Type.Union([
	Obj({ type: Type.Literal("start"), partial: PartialAssistantMessage }),
	Obj({ type: Type.Literal("text_start"), ...Index, content: TextBlock }),
	Obj({ type: Type.Literal("text_delta"), ...Index, delta: Str }),
	Obj({ type: Type.Literal("text_end"), ...Index, content: Str, textSignature: Opt(Str) }),
	Obj({ type: Type.Literal("thinking_start"), ...Index, content: ThinkingBlock }),
	Obj({ type: Type.Literal("thinking_delta"), ...Index, delta: Str }),
	Obj({
		type: Type.Literal("thinking_end"),
		...Index,
		content: Str,
		thinkingSignature: Opt(Str),
		redacted: Opt(Bool),
	}),
	Obj({ type: Type.Literal("toolcall_start"), ...Index, toolCall: ToolCallBlock }),
	Obj({ type: Type.Literal("toolcall_checkpoint"), ...Index, json: Str }),
	Obj({ type: Type.Literal("toolcall_delta"), ...Index, delta: Str }),
	Obj({
		type: Type.Literal("toolcall_end"),
		...Index,
		id: Str,
		name: Str,
		arguments: Type.Record(Str, Type.Unknown()),
		thoughtSignature: Opt(Str),
		namespace: Opt(Str),
	}),
]);
const RunRef = { runId: Str, requestId: Str, toolCallId: Str };

const RECORD_SCHEMAS: Record<TraceRecord["type"], TSchema> = {
	header: Obj({
		format: Type.Literal(TRACE_FORMAT),
		version: Type.Literal(TRACE_FORMAT_VERSION),
		traceId: Str,
		createdAt: Str,
		harness: Obj({ name: Str, version: Str }),
	}),
	session_attach: Obj({ sessionId: Str }),
	session_detach: Obj({ sessionId: Str, openOperations: Int }),
	session: Obj({ sessionId: Str, event: Str, data: Type.Unknown() }),
	message: Obj({ sessionId: Str, runId: Opt(Str), turn: Opt(Int), requestId: Opt(Str), message: Message }),
	run_start: Obj({
		sessionId: Str,
		runId: Str,
		model: ModelRef,
		thinkingLevel: Str,
		toolExecution: Type.Union([Type.Literal("sequential"), Type.Literal("parallel")]),
	}),
	run_end: Obj({ runId: Str, willRetry: Type.Boolean() }),
	turn_start: Obj({ runId: Str, turn: Int }),
	turn_end: Obj({ runId: Str, turn: Int }),
	model_request: Obj({
		requestId: Str,
		kind: Type.Union([Type.Literal("session"), Type.Literal("auxiliary")]),
		runId: Opt(Str),
		turn: Opt(Int),
		model: ModelRef,
		tools: Opt(Type.Array(ToolDefinition)),
	}),
	model_frame: Obj({ requestId: Str, frame: Frame }),
	model_response: Obj({ requestId: Str, terminal: Obj({ reason: Str, message: AssistantMessage }), error: Opt(Str) }),
	tool_start: Obj({ ...RunRef, toolName: Str, args: Type.Unknown() }),
	tool_update: Obj({ ...RunRef, partialResult: Type.Unknown() }),
	tool_executed: Obj({ ...RunRef, preparedArgs: Type.Unknown(), result: ToolResult, isError: Bool }),
	tool_hook: Obj({
		...RunRef,
		hook: Type.Union([Type.Literal("before_tool_call"), Type.Literal("after_tool_call")]),
		result: Opt(Type.Unknown()),
		error: Opt(Str),
	}),
	tool_end: Obj({ ...RunRef, result: ToolResult, isError: Bool }),
	hook: Type.Union([
		Obj({ hookId: Str, phase: Type.Literal("start"), event: Str, extensionPath: Str, handlerIndex: Int }),
		Obj({
			hookId: Str,
			phase: Type.Literal("end"),
			status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
			returned: Opt(Type.Boolean()),
			error: Opt(Str),
		}),
	]),
	cancel: Obj({ runId: Str }),
	error: Obj({
		source: Type.Union([Type.Literal("model"), Type.Literal("tool"), Type.Literal("hook")]),
		message: Str,
		runId: Opt(Str),
		requestId: Opt(Str),
		toolCallId: Opt(Str),
		hookId: Opt(Str),
	}),
	trace_end: Obj({ eventCount: Int }),
};

function isRecordType(value: unknown): value is TraceRecord["type"] {
	return typeof value === "string" && Object.hasOwn(RECORD_SCHEMAS, value);
}

/** Tool invocations are scoped by request because providers may reuse tool-call IDs. */
export function toolKey(requestId: string, toolCallId: string): string {
	return `${requestId}\u0000${toolCallId}`;
}

interface Location {
	line: number;
	seq: number;
}

function at(location: Location): string {
	return `line ${location.line} (seq ${location.seq})`;
}

interface RunState extends Location {
	open: boolean;
	sessionId: string;
	/** Last started turn, -1 before the first. */
	turn: number;
	turnOpen: boolean;
	turnStart?: Location;
	turnRequested: boolean;
	/** The open turn's session request, until its response. */
	openRequest?: string;
	/** The open turn's session request, kept after its response for the turn's tool results. */
	turnRequest?: string;
	openTools: number;
}

interface RequestState extends Location {
	open: boolean;
	kind: "session" | "auxiliary";
	runId?: string;
	/** The turn a session request belongs to; its tool calls and replacement stay in it. */
	turn?: number;
	frames: TraceFrame[];
}

/**
 * Tracks open operations so the graph can be checked record by record. Diagnostics describe the
 * problem and its location only; identifiers and payloads from the file are never echoed.
 */
class TraceGraph {
	private readonly runs = new Map<string, RunState>();
	private readonly requests = new Map<string, RequestState>();
	private readonly tools = new Map<string, Location & { open: boolean; runId: string }>();
	private readonly hooks = new Map<string, Location & { open: boolean }>();
	private attached: (Location & { sessionId: string }) | undefined;

	apply(record: TraceRecord, location: Location, fail: (message: string) => never): void {
		const requireSession = (sessionId: string) => {
			if (this.attached?.sessionId !== sessionId) fail("record for a session that is not attached");
		};
		const requireRun = (runId: string, open = true): RunState => {
			const run = this.runs.get(runId);
			if (!run) fail("unknown runId");
			if (open && !run.open) fail("run has already ended");
			return run;
		};
		const requireRequest = (requestId: string): RequestState => {
			const request = this.requests.get(requestId);
			if (!request) fail("unknown requestId");
			return request;
		};
		const requireOpenTool = (record: { runId: string; requestId: string; toolCallId: string }) => {
			const tool = this.tools.get(toolKey(record.requestId, record.toolCallId));
			if (!tool) fail("unknown tool call");
			if (!tool.open) fail("tool call has already ended");
			if (tool.runId !== record.runId) fail("tool record does not belong to the tool call's run");
			return tool;
		};

		switch (record.type) {
			case "header":
				fail("duplicate header");
				break;
			case "session_attach":
				if (this.attached !== undefined) fail("session_attach while another session is attached");
				this.attached = { ...location, sessionId: record.sessionId };
				break;
			case "session_detach":
				requireSession(record.sessionId);
				this.attached = undefined;
				break;
			case "session":
				requireSession(record.sessionId);
				break;
			case "run_start":
				requireSession(record.sessionId);
				if (this.runs.has(record.runId)) fail("duplicate runId");
				this.runs.set(record.runId, {
					...location,
					open: true,
					sessionId: record.sessionId,
					turn: -1,
					turnOpen: false,
					turnRequested: false,
					openTools: 0,
				});
				break;
			case "run_end": {
				const run = requireRun(record.runId);
				if (run.turnOpen) fail("run_end while a turn is open");
				run.open = false;
				break;
			}
			case "turn_start": {
				const run = requireRun(record.runId);
				if (run.turnOpen) fail("turn_start while a turn is open");
				if (record.turn !== run.turn + 1) fail(`turn_start out of order (expected turn ${run.turn + 1})`);
				run.turn = record.turn;
				run.turnOpen = true;
				run.turnStart = location;
				run.turnRequested = false;
				run.turnRequest = undefined;
				break;
			}
			case "turn_end": {
				const run = requireRun(record.runId);
				if (!run.turnOpen || record.turn !== run.turn) fail("turn_end without a matching turn_start");
				// A turn's session request and tool calls finish inside it.
				if (run.openRequest !== undefined) fail("turn_end while its model request is open");
				if (run.openTools > 0) fail("turn_end while a tool call is open");
				run.turnOpen = false;
				break;
			}
			case "cancel":
				requireRun(record.runId);
				break;
			case "message": {
				requireSession(record.sessionId);
				if (record.runId !== undefined) {
					const run = requireRun(record.runId, false);
					if (run.sessionId !== record.sessionId) fail("message does not belong to its run's session");
					if (record.turn !== undefined && record.turn > run.turn)
						fail("message refers to a turn that has not started");
				} else if (record.turn !== undefined) {
					fail("message has a turn without a runId");
				}
				// A replacement of a model result and a tool-result transcript message are produced inside
				// their turn, so they must appear while that turn is the run's open turn.
				const role = (record.message as { role: string }).role;
				if (record.requestId !== undefined || role === "toolResult") {
					if (record.runId === undefined || record.turn === undefined) fail("turn message without runId/turn");
					const run = requireRun(record.runId);
					if (!run.turnOpen || record.turn !== run.turn) fail("turn message outside its open turn");
				}
				if (record.requestId !== undefined) {
					const request = requireRequest(record.requestId);
					if (request.kind !== "session" || request.runId !== record.runId) {
						fail("message replacement does not belong to a session request of its run");
					}
					if (record.turn !== request.turn) fail("message replacement outside its request's turn");
					if (request.open) fail("message replacement before its request's response");
				} else if (role === "toolResult") {
					const run = requireRun(record.runId as string);
					const toolCallId = (record.message as { toolCallId: string }).toolCallId;
					const tool =
						run.turnRequest === undefined ? undefined : this.tools.get(toolKey(run.turnRequest, toolCallId));
					if (!tool || tool.open) fail("tool result message without a finished tool call in its turn");
				}
				break;
			}
			case "model_request": {
				if (this.requests.has(record.requestId)) fail("duplicate requestId");
				if (record.kind === "session") {
					if (record.runId === undefined || record.turn === undefined) fail("session request without runId/turn");
					const run = requireRun(record.runId);
					if (!run.turnOpen || record.turn !== run.turn) fail("session request outside its turn");
					if (run.turnRequested) fail("second session request in one turn");
					run.turnRequested = true;
					run.openRequest = record.requestId;
					run.turnRequest = record.requestId;
				} else if (record.runId !== undefined) {
					requireRun(record.runId, false);
				}
				this.requests.set(record.requestId, {
					...location,
					open: true,
					kind: record.kind,
					runId: record.runId,
					turn: record.kind === "session" ? record.turn : undefined,
					frames: [],
				});
				break;
			}
			case "model_frame": {
				const request = requireRequest(record.requestId);
				if (!request.open) fail("frame after the request's response");
				request.frames.push(record.frame);
				break;
			}
			case "model_response": {
				const request = requireRequest(record.requestId);
				if (!request.open) fail("duplicate response for a request");
				request.open = false;
				if (request.kind === "session" && request.runId !== undefined) {
					const run = this.runs.get(request.runId);
					if (run?.openRequest === record.requestId) run.openRequest = undefined;
				}
				const message = record.terminal.message as { stopReason: string; content: unknown[] };
				if (record.terminal.reason !== message.stopReason)
					fail("terminal reason differs from the message stop reason");
				const problem = frameProblem(request.frames, message.content);
				if (problem) fail(problem);
				request.frames = [];
				break;
			}
			case "tool_start": {
				const run = requireRun(record.runId);
				if (!run.turnOpen) fail("tool_start outside a turn");
				const request = requireRequest(record.requestId);
				if (request.kind !== "session" || request.runId !== record.runId) {
					fail("tool call does not belong to a session request of its run");
				}
				if (request.open) fail("tool_start before its request's response");
				if (request.turn !== run.turn) fail("tool call started outside its request's turn");
				const key = toolKey(record.requestId, record.toolCallId);
				if (this.tools.has(key)) fail("duplicate tool call in one request");
				this.tools.set(key, { ...location, open: true, runId: record.runId });
				run.openTools++;
				break;
			}
			case "tool_update":
			case "tool_executed":
			case "tool_hook":
				requireOpenTool(record);
				break;
			case "tool_end": {
				requireOpenTool(record).open = false;
				const run = this.runs.get(record.runId);
				if (run) run.openTools--;
				break;
			}
			case "hook":
				if (record.phase === "start") {
					if (this.hooks.has(record.hookId)) fail("duplicate hookId");
					this.hooks.set(record.hookId, { ...location, open: true });
				} else {
					const hook = this.hooks.get(record.hookId);
					if (!hook?.open) fail("hook end without an open hook");
					hook.open = false;
				}
				break;
			case "error":
				if (record.runId !== undefined) requireRun(record.runId, false);
				if (record.requestId !== undefined) requireRequest(record.requestId);
				if (record.toolCallId !== undefined) {
					if (record.requestId === undefined || !this.tools.has(toolKey(record.requestId, record.toolCallId))) {
						fail("error refers to an unknown tool call");
					}
				}
				if (record.hookId !== undefined && !this.hooks.has(record.hookId)) fail("unknown hookId");
				break;
			case "trace_end":
				if (record.eventCount !== record.seq) fail("trace_end eventCount does not match its seq");
				if (this.unfinished().length > 0) fail("trace_end while operations are unfinished");
				break;
		}
	}

	/** Operations that were started but never finished, with the location that started them. */
	unfinished(): string[] {
		const reasons: string[] = [];
		for (const run of this.runs.values()) {
			if (run.turnOpen && run.turnStart) reasons.push(`unfinished turn started at ${at(run.turnStart)}`);
			if (run.open) reasons.push(`unfinished run started at ${at(run)}`);
		}
		for (const request of this.requests.values()) {
			if (request.open) reasons.push(`unfinished model request started at ${at(request)}`);
		}
		for (const tool of this.tools.values()) {
			if (tool.open) reasons.push(`unfinished tool call started at ${at(tool)}`);
		}
		for (const hook of this.hooks.values()) {
			if (hook.open) reasons.push(`unfinished extension hook started at ${at(hook)}`);
		}
		if (this.attached !== undefined) reasons.push(`session attached at ${at(this.attached)} was not detached`);
		return reasons;
	}
}

/**
 * A request's frames must form a valid stream, and every block the stream ended must equal the
 * corresponding block of the terminal message.
 */
function frameProblem(frames: TraceFrame[], terminalContent: unknown[]): string | undefined {
	if (frames.length === 0) return undefined;
	let reduced: { content: unknown[] } | undefined;
	try {
		reduced = reduceAssistantMessageFrames(frames as unknown as AssistantMessageFrame[]);
	} catch {
		return "invalid model frame sequence";
	}
	if (!reduced) return "model frames without a start frame";
	const ended = new Set(frames.filter((frame) => frame.type.endsWith("_end")).map((frame) => frame.contentIndex));
	for (const index of ended) {
		if (index === undefined) continue;
		if (!isDeepStrictEqual(reduced.content[index], terminalContent[index])) {
			return "model frames differ from the terminal message";
		}
	}
	return undefined;
}

/** Where a record breaks its schema. The TypeBox message is replaced by the keyword so no value is echoed. */
function schemaError(schema: TSchema, value: unknown, prefix = ""): string {
	const error = Errors(schema, value)[0];
	if (!error) return "record does not match the trace format";
	return `${prefix}${error.instancePath || ""} fails the ${error.keyword} check`.trimStart();
}

/**
 * Parse and validate trace text. Throws `TraceFormatError` for malformed input and
 * `UnsupportedTraceVersionError` for other versions. A trace cut short (truncated final line,
 * sequence gap, unfinished operation, missing `trace_end`) is returned with `complete: false`;
 * records after a gap are not returned.
 */
export function parseTrace(text: string): Trace {
	const lines = text.split("\n");
	const endsWithNewline = text.endsWith("\n");
	if (endsWithNewline) lines.pop();
	const records: TraceRecord[] = [];
	const incomplete: string[] = [];
	const graph = new TraceGraph();
	let ended = false;

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		const line = lines[index];
		const isLastLine = index === lines.length - 1;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			if (isLastLine && !endsWithNewline) {
				incomplete.push(`truncated final line ${lineNumber}`);
				break;
			}
			throw new TraceFormatError(line.trim() === "" ? "empty line" : "line is not valid JSON", {
				line: lineNumber,
			});
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TraceFormatError("record is not a JSON object", { line: lineNumber });
		}
		const candidate = value as Record<string, unknown>;
		const seq = Number.isSafeInteger(candidate.seq) ? (candidate.seq as number) : undefined;

		if (index === 0) {
			if (candidate.type !== "header" || candidate.format !== TRACE_FORMAT) {
				throw new TraceFormatError("missing trace header", { line: lineNumber });
			}
			if (candidate.version !== TRACE_FORMAT_VERSION) throw new UnsupportedTraceVersionError(candidate.version);
		}
		const fail: (message: string) => never = (message) => {
			throw new TraceFormatError(message, { line: lineNumber, seq });
		};
		if (ended) fail("record after trace_end");
		if (!isRecordType(candidate.type)) fail("unknown record type");
		if (seq === undefined || seq < 0) fail("seq must be a non-negative integer");
		if (typeof candidate.ts !== "number" || !Number.isFinite(candidate.ts)) fail("ts must be a number");
		const expectedSeq = records.length;
		if (seq < expectedSeq) fail(`duplicate or out-of-order seq (expected ${expectedSeq})`);
		if (seq > expectedSeq) {
			incomplete.push(`sequence gap at line ${lineNumber}: expected seq ${expectedSeq}, found ${seq}`);
			break;
		}
		const { seq: _seq, ts: _ts, type: _type, ...body } = candidate;
		const schema = RECORD_SCHEMAS[candidate.type as TraceRecord["type"]];
		if (!Check(schema, body)) fail(schemaError(schema, body));
		const record = value as TraceRecord;
		if (record.type === "message") {
			const messageSchema = MESSAGE_SCHEMAS[(record.message as { role: string }).role];
			if (messageSchema && !Check(messageSchema, record.message))
				fail(schemaError(messageSchema, record.message, "/message"));
		}
		if (index > 0) graph.apply(record, { line: lineNumber, seq }, fail);
		records.push(record);
		if (record.type === "trace_end") ended = true;
	}

	if (records.length === 0) throw new TraceFormatError("missing trace header", { line: 1 });
	if (!ended) {
		const stopped = incomplete.length > 0;
		if (!stopped) incomplete.push(...graph.unfinished());
		const last = records.length;
		incomplete.push(`missing trace_end after line ${last} (seq ${last - 1})`);
	}
	return {
		header: records[0] as TraceHeaderRecord,
		records,
		complete: incomplete.length === 0,
		incomplete,
	};
}

/** Read and validate a trace file. */
export function readTrace(path: string): Trace {
	return parseTrace(readFileSync(path, "utf-8"));
}

function summarize(record: TraceRecord): string {
	switch (record.type) {
		case "header":
			return `${record.format} v${record.version} ${record.harness.name} ${record.harness.version}`;
		case "session_attach":
		case "session_detach":
			return "";
		case "session":
			return record.event;
		case "message": {
			const role = (record.message as { role?: unknown }).role;
			return `${typeof role === "string" ? role : "?"}${record.requestId ? " (post-hook replacement)" : ""}`;
		}
		case "run_start":
			return `${record.model.provider}/${record.model.id} ${record.toolExecution}`;
		case "run_end":
			return record.willRetry ? "will retry" : "";
		case "turn_start":
		case "turn_end":
			return `turn ${record.turn}`;
		case "model_request":
			return `${record.kind} ${record.model.provider}/${record.model.id}${record.tools ? ` tools=${record.tools.length}` : ""}`;
		case "model_frame":
			return `${record.frame.type}${record.frame.contentIndex === undefined ? "" : `[${record.frame.contentIndex}]`}`;
		case "model_response":
			return record.error === undefined ? record.terminal.reason : `${record.terminal.reason} (stream setup failed)`;
		case "tool_start":
			return record.toolName;
		case "tool_executed":
		case "tool_end":
			return record.isError ? "error" : "ok";
		case "tool_hook":
			return `${record.hook}${record.error === undefined ? "" : " threw"}`;
		case "hook":
			return record.phase === "start"
				? `${record.event} start`
				: `end ${record.status}${record.status === "ok" ? (record.returned ? " returned" : " undefined") : ""}`;
		case "error":
			return record.source;
		default:
			return "";
	}
}

/** One line per record: `#seq +ms type ids summary`. Payload content is never printed. */
export function formatTraceTimeline(trace: Trace): string[] {
	const labels = new Map<string, string>();
	const counts = new Map<string, number>();
	const label = (prefix: string, id: string | undefined) => {
		if (id === undefined) return undefined;
		const key = `${prefix}:${id}`;
		let value = labels.get(key);
		if (!value) {
			const count = (counts.get(prefix) ?? 0) + 1;
			counts.set(prefix, count);
			value = `${prefix}${count}`;
			labels.set(key, value);
		}
		return value;
	};
	const start = trace.header.ts;
	return trace.records.map((record) => {
		const fields = record as Partial<Record<"runId" | "requestId" | "toolCallId" | "hookId", string>>;
		const ids = [
			label("run", fields.runId),
			label("req", fields.requestId),
			fields.toolCallId === undefined ? undefined : `tool=${fields.toolCallId}`,
			label("hook", fields.hookId),
		]
			.filter((part) => part !== undefined)
			.join(" ");
		const summary = summarize(record);
		return [`#${record.seq}`, `+${record.ts - start}ms`, record.type, ids, summary]
			.filter((part) => part !== "")
			.join(" ");
	});
}
