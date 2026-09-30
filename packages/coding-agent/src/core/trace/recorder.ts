/**
 * Opt-in local capture of agent runs as a redacted JSONL trace. See docs/traces.md.
 *
 * Records are snapshotted when observed and redacted when flushed. A record is flushed only when
 * every record before it is safe to write: model streams and tool invocations are held until they
 * finish, so a secret split across fragments can be removed from all of them, and messages that
 * precede a model request are held until that request's credentials are known.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync, writeSync } from "node:fs";
import type {
	AfterToolCallContext,
	AgentRequestUpdate,
	AgentTool,
	BeforeToolCallContext,
	PrepareRequest,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	AssistantMessageFrameEncoder,
	EventStream,
	type Model,
	uuidv7,
} from "@earendil-works/pi-ai";
import { APP_NAME, VERSION } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import type { ExtensionHandlerObserver } from "../extensions/index.ts";
import type { RequestAuthNotification } from "../model-runtime.ts";
import {
	TRACE_FORMAT,
	TRACE_FORMAT_VERSION,
	type TraceFrame,
	type TraceModelRef,
	type TraceRecord,
	type TraceRecordBody,
	type TraceToolDefinition,
	toolKey,
} from "./format.ts";
import { TraceRedactor } from "./redact.ts";

const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

export interface TraceRecorderOptions {
	/** Additional values to redact, such as credentials held by a custom store. Any length. */
	secrets?: readonly string[];
	/** Environment scanned for credential-named variables. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Budget for observed but not yet written data, in bytes. Defaults to 64 MiB. */
	maxPendingBytes?: number;
}

interface PendingRecord {
	seq: number;
	json: string;
	/** UTF-8 size of `json`, the unit of the pending budget. */
	bytes: number;
	unit?: string;
}

interface RequestState {
	seq: number;
	kind: "session" | "auxiliary";
	open: boolean;
}

interface RunState {
	runId: string;
	turn: number;
	turnOpen: boolean;
	turnRequested: boolean;
	requestId?: string;
	toolsJson?: string;
	/** Executable tools chosen by the agent's prepareRequest for the next request. */
	preparedTools?: readonly AgentTool[];
	removeAbortListener?: () => void;
}

interface Attachment {
	session: AgentSession;
	sessionId: string;
	release: Array<() => void>;
}

/** Wrapper → wrapped stream function, used to see through tracing for identity checks. */
const tracedOriginals = new WeakMap<StreamFn, StreamFn>();
/** Wrapper → entry point that records calls as auxiliary requests. */
const auxiliaryEntryPoints = new WeakMap<StreamFn, StreamFn>();
/** Carries the request ID into ModelRuntime auth preparation for this request. */
const requestContext = new AsyncLocalStorage<string>();

/** The stream function beneath any trace wrappers. Returns `fn` itself when capture never wrapped it. */
export function unwrapTracedStreamFn(fn: StreamFn): StreamFn {
	let current = fn;
	for (let original = tracedOriginals.get(current); original; original = tracedOriginals.get(current)) {
		current = original;
	}
	return current;
}

/**
 * Entry point for built-in auxiliary requests (compaction, branch and bug-report summaries).
 * Returns `fn` itself when capture is disabled.
 */
export function traceAuxiliaryStreamFn(fn: StreamFn): StreamFn {
	return auxiliaryEntryPoints.get(fn) ?? fn;
}

function modelRef(model: Model<Api>): TraceModelRef {
	return { provider: model.provider, id: model.id, api: model.api };
}

function toolDefinitions(tools: readonly AgentTool[]): TraceToolDefinition[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
	return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

/**
 * Forwards a provider stream to its consumer. An iteration or `result()` failure of the source
 * reaches the consumer as it would without tracing, instead of leaving this stream unsettled.
 */
class ForwardedEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private failure: { error: unknown } | undefined;
	private readonly settled: Promise<AssistantMessage>;
	private resolveSettled: (message: AssistantMessage) => void = () => {};
	private rejectSettled: (error: unknown) => void = () => {};

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => (event.type === "done" ? event.message : (event as { error: AssistantMessage }).error),
		);
		this.settled = new Promise<AssistantMessage>((resolve, reject) => {
			this.resolveSettled = resolve;
			this.rejectSettled = reject;
		});
		// A consumer that only iterates receives the failure there; avoid an unhandled rejection.
		this.settled.catch(() => {});
	}

	succeed(message: AssistantMessage): void {
		this.end(message);
		this.resolveSettled(message);
	}

	fail(error: unknown): void {
		this.failure = { error };
		this.end();
		this.rejectSettled(error);
	}

	override result(): Promise<AssistantMessage> {
		return this.settled;
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const events = super[Symbol.asyncIterator]();
		for (let next = await events.next(); !next.done; next = await events.next()) yield next.value;
		if (this.failure) throw this.failure.error;
	}
}

/** Records one or more sessions into a local trace file. Capture never changes the agent result. */
export class TraceRecorder {
	readonly path: string;
	private readonly fd: number;
	private readonly redactor = new TraceRedactor();
	private readonly maxPendingBytes: number;
	private nextSeq = 0;
	private pending: PendingRecord[] = [];
	private pendingBytes = 0;
	private readonly openUnits = new Set<string>();
	private readonly openHooks = new Set<string>();
	private readonly requests = new Map<string, RequestState>();
	private readonly terminals = new WeakMap<object, { requestId: string; json: string }>();
	/** Records from this seq on wait until the next session request resolves its auth. */
	private gate: number | undefined;
	private run: RunState | undefined;
	private attachment: Attachment | undefined;
	private capturing = true;
	private incomplete = false;
	private closed = false;
	private failure: Error | undefined;

	private constructor(path: string, fd: number, options: TraceRecorderOptions) {
		this.path = path;
		this.fd = fd;
		this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
		for (const secret of options.secrets ?? []) this.redactor.addSecret(secret);
		this.redactor.addEnv(options.env ?? process.env);
	}

	/**
	 * Create a new trace file with mode 0600 and write its header. Fails if anything exists at
	 * `path`, including a symlink.
	 */
	static open(path: string, options: TraceRecorderOptions = {}): TraceRecorder {
		const fd = openSync(path, "wx", 0o600);
		const recorder = new TraceRecorder(path, fd, options);
		try {
			const ts = Date.now();
			recorder.write(
				`${JSON.stringify({
					type: "header",
					seq: recorder.nextSeq++,
					ts,
					format: TRACE_FORMAT,
					version: TRACE_FORMAT_VERSION,
					traceId: uuidv7(),
					createdAt: new Date(ts).toISOString(),
					harness: { name: APP_NAME, version: VERSION },
				})}\n`,
			);
		} catch (error) {
			closeSync(fd);
			throw error;
		}
		return recorder;
	}

	/** The failure that stopped capture, if any. The agent run is unaffected by it. */
	get error(): Error | undefined {
		return this.failure;
	}

	/** Start recording an idle session. A previously attached session is detached first. */
	attach(session: AgentSession): void {
		if (this.closed) throw new Error("Trace recorder is closed");
		if (this.attachment?.session === session) return;
		this.detach();
		if (!session.isIdle) throw new Error("Attach the trace recorder while the session is idle");
		if (!this.capturing) return;

		const attachment: Attachment = { session, sessionId: session.sessionId, release: [] };
		try {
			for (const secret of session.modelRuntime.collectSecretValues()) this.redactor.addSecret(secret);
			attachment.release.push(session.subscribe((event) => this.observe(() => this.onSessionEvent(event))));
			attachment.release.push(
				session.modelRuntime.onRequestAuth((notification) => this.observe(() => this.onRequestAuth(notification))),
			);
			session.setExtensionHandlerObserver(this.hookObserver);
			attachment.release.push(() => session.setExtensionHandlerObserver(undefined));
			this.wrapAgent(attachment);
			this.attachment = attachment;
			this.append({ type: "session_attach", sessionId: attachment.sessionId });
		} catch (error) {
			for (const release of attachment.release.reverse()) release();
			this.attachment = undefined;
			throw error;
		}
	}

	/** Stop recording the attached session and restore the agent functions this recorder still owns. */
	detach(): void {
		const attachment = this.attachment;
		if (!attachment) return;
		this.attachment = undefined;
		for (const release of attachment.release.reverse()) {
			try {
				release();
			} catch (error) {
				this.fail(error);
			}
		}
		const runOpen = this.run !== undefined;
		this.run?.removeAbortListener?.();
		this.run = undefined;
		this.observe(() => {
			const openOperations = this.openUnits.size + this.openHooks.size + (runOpen ? 1 : 0);
			if (openOperations > 0) this.incomplete = true;
			else this.gate = undefined;
			this.append({ type: "session_detach", sessionId: attachment.sessionId, openOperations });
			this.flush();
		});
	}

	/**
	 * Detach, write every record that is safe to write, append `trace_end` when the capture is
	 * complete, and close the file. Idempotent.
	 */
	close(): void {
		if (this.closed) return;
		this.detach();
		this.closed = true;
		try {
			this.observe(() => {
				this.flush();
				if (this.pending.length > 0 || this.incomplete) return;
				const seq = this.nextSeq++;
				this.write(`${JSON.stringify({ type: "trace_end", seq, ts: Date.now(), eventCount: seq })}\n`);
			});
		} finally {
			try {
				closeSync(this.fd);
			} catch (error) {
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			}
			this.capturing = false;
			this.pending = [];
		}
	}

	private fail(error: unknown): void {
		// The message can quote a payload, so it is redacted like one.
		this.failure ??= new Error(this.redactor.redactString(errorMessage(error)));
		this.capturing = false;
		this.pending = [];
		this.pendingBytes = 0;
	}

	/** Run capture work; any failure stops capture instead of reaching the agent. */
	private observe(work: () => void): void {
		if (!this.capturing) return;
		try {
			work();
		} catch (error) {
			this.fail(error);
		}
	}

	private append(body: TraceRecordBody, unit?: string): void {
		const seq = this.nextSeq;
		const { type, ...fields } = body;
		const json = JSON.stringify({ type, seq, ts: Date.now(), ...fields });
		this.nextSeq++;
		const bytes = Buffer.byteLength(json, "utf-8");
		this.pending.push({ seq, json, bytes, unit });
		this.pendingBytes += bytes;
		if (this.pendingBytes > this.maxPendingBytes) {
			throw new Error(`Trace capture stopped: unwritten trace data exceeded ${this.maxPendingBytes} bytes`);
		}
	}

	private write(text: string): void {
		const buffer = Buffer.from(text, "utf-8");
		let offset = 0;
		while (offset < buffer.length) {
			const written = writeSync(this.fd, buffer, offset, buffer.length - offset);
			if (written <= 0) throw new Error("Trace write made no progress");
			offset += written;
		}
	}

	/** Write the longest prefix of pending records whose units are finished and not held for auth. */
	private flush(): void {
		let count = 0;
		for (const record of this.pending) {
			if (record.unit !== undefined && this.openUnits.has(record.unit)) break;
			if (this.gate !== undefined && record.seq >= this.gate) break;
			count++;
		}
		if (count === 0) return;
		const batch = this.pending.slice(0, count);
		const text = this.redactBatch(batch);
		this.write(text);
		this.pending = this.pending.slice(count);
		this.pendingBytes -= batch.reduce((total, record) => total + record.bytes, 0);
	}

	private redactBatch(batch: PendingRecord[]): string {
		const records = batch.map((pending) => JSON.parse(pending.json) as TraceRecord);
		const frames = new Map<string, number[]>();
		const updates = new Map<string, number[]>();
		records.forEach((record, index) => {
			const [group, key] =
				record.type === "model_frame"
					? [frames, record.requestId]
					: record.type === "tool_update"
						? [updates, toolKey(record.requestId, record.toolCallId)]
						: [undefined, ""];
			if (!group) return;
			const list = group.get(key) ?? [];
			list.push(index);
			group.set(key, list);
		});
		const payloads = new Map<number, { key: "frame" | "partialResult"; value: unknown }>();
		for (const indexes of frames.values()) {
			const redacted = this.redactor.redactFrames(
				indexes.map((index) => (records[index] as Extract<TraceRecord, { type: "model_frame" }>).frame),
			);
			indexes.forEach((index, position) => {
				payloads.set(index, { key: "frame", value: redacted[position] });
			});
		}
		for (const indexes of updates.values()) {
			const redacted = this.redactor.redactToolUpdates(
				indexes.map((index) => (records[index] as Extract<TraceRecord, { type: "tool_update" }>).partialResult),
			);
			indexes.forEach((index, position) => {
				payloads.set(index, { key: "partialResult", value: redacted[position] });
			});
		}
		return records
			.map((record, index) => {
				const payload = payloads.get(index);
				if (!payload) return `${JSON.stringify(this.redactor.redactRecord(record))}\n`;
				const redacted = this.redactor.redactRecord({ ...record, [payload.key]: undefined } as TraceRecord);
				redacted[payload.key] = payload.value as never;
				return `${JSON.stringify(redacted)}\n`;
			})
			.join("");
	}

	private closeUnit(unit: string): void {
		this.openUnits.delete(unit);
		this.flush();
	}

	private wrapAgent(attachment: Attachment): void {
		const agent = attachment.session.agent;
		const originalStream = agent.streamFunction;
		const stream: StreamFn = (model, context, options) =>
			this.traceStream("detect", originalStream, model, context, options);
		const auxiliary: StreamFn = (model, context, options) =>
			this.traceStream("auxiliary", originalStream, model, context, options);
		tracedOriginals.set(stream, originalStream);
		auxiliaryEntryPoints.set(stream, auxiliary);

		const originalBefore = agent.beforeToolCall;
		const before = async (context: BeforeToolCallContext, signal?: AbortSignal) => {
			let result: Awaited<ReturnType<NonNullable<typeof originalBefore>>>;
			try {
				result = await originalBefore?.(context, signal);
			} catch (error) {
				this.observe(() => this.recordToolHook(context.toolCall.id, "before_tool_call", { error }));
				throw error;
			}
			this.observe(() => this.recordToolHook(context.toolCall.id, "before_tool_call", { result }));
			return result;
		};

		const originalAfter = agent.afterToolCall;
		const after = async (context: AfterToolCallContext, signal?: AbortSignal) => {
			this.observe(() => {
				const ids = this.toolIds(context.toolCall.id);
				if (!ids) return;
				this.append(
					{
						type: "tool_executed",
						...ids,
						preparedArgs: context.args,
						result: context.result,
						isError: context.isError,
					},
					toolKey(ids.requestId, ids.toolCallId),
				);
			});
			let result: Awaited<ReturnType<NonNullable<typeof originalAfter>>>;
			try {
				result = await originalAfter?.(context, signal);
			} catch (error) {
				this.observe(() => this.recordToolHook(context.toolCall.id, "after_tool_call", { error }));
				throw error;
			}
			this.observe(() => this.recordToolHook(context.toolCall.id, "after_tool_call", { result }));
			return result;
		};

		// The loop executes the tools of the context prepareRequest returns, which can differ from
		// agent.state.tools, so the recorded definitions are taken from here.
		const originalPrepare = agent.prepareRequest;
		const prepare: PrepareRequest = async (request, signal) => {
			const update = (await originalPrepare?.(request, signal)) as AgentRequestUpdate | undefined;
			this.observe(() => {
				if (this.run) this.run.preparedTools = (update?.context ?? request.context).tools ?? [];
			});
			return update;
		};

		agent.streamFunction = stream;
		agent.beforeToolCall = before;
		agent.afterToolCall = after;
		agent.prepareRequest = prepare;
		attachment.release.push(() => {
			if (agent.streamFunction === stream) agent.streamFunction = originalStream;
			if (agent.prepareRequest === prepare) agent.prepareRequest = originalPrepare;
			if (agent.beforeToolCall === before) agent.beforeToolCall = originalBefore;
			if (agent.afterToolCall === after) agent.afterToolCall = originalAfter;
		});
	}

	private toolIds(toolCallId: string): { runId: string; requestId: string; toolCallId: string } | undefined {
		const run = this.run;
		if (!run?.requestId) return undefined;
		return { runId: run.runId, requestId: run.requestId, toolCallId };
	}

	private recordToolHook(
		toolCallId: string,
		hook: "before_tool_call" | "after_tool_call",
		outcome: { result?: unknown; error?: unknown },
	): void {
		const ids = this.toolIds(toolCallId);
		if (!ids) return;
		const unit = toolKey(ids.requestId, ids.toolCallId);
		if ("error" in outcome) {
			const message = errorMessage(outcome.error);
			this.append({ type: "tool_hook", ...ids, hook, error: message }, unit);
			this.append({ type: "error", source: "tool", ...ids, message }, unit);
		} else {
			this.append({ type: "tool_hook", ...ids, hook, result: outcome.result }, unit);
		}
	}

	private traceStream(
		kind: "detect" | "auxiliary",
		original: StreamFn,
		...args: Parameters<StreamFn>
	): ReturnType<StreamFn> {
		const attachment = this.attachment;
		if (!this.capturing || !attachment) return original(...args);
		const [model, , options] = args;
		let requestId: string | undefined;
		this.observe(() => {
			requestId = this.startRequest(kind, model, options);
		});
		if (requestId === undefined) return original(...args);
		const id = requestId;
		const onSetupError = (error: unknown) => {
			this.observe(() => this.finishRequest(id, this.failureMessage(model, error), errorMessage(error)));
			throw error;
		};
		let result: ReturnType<StreamFn>;
		try {
			result = requestContext.run(id, () => original(...args));
		} catch (error) {
			return onSetupError(error);
		}
		return isPromiseLike(result)
			? Promise.resolve(result).then((stream) => this.forward(id, model, stream), onSetupError)
			: this.forward(id, model, result);
	}

	private startRequest(kind: "detect" | "auxiliary", model: Model<Api>, options: Parameters<StreamFn>[2]): string {
		const requestId = uuidv7();
		this.redactor.addSecret(options?.apiKey);
		this.redactor.addHeaders(options?.headers);
		this.redactor.addEnv(options?.env);
		const run = this.run;
		// A request is conversational only inside an open turn, once per turn, and never when a
		// built-in auxiliary caller identified itself.
		const isSession = kind === "detect" && run !== undefined && run.turnOpen && !run.turnRequested;
		let tools: TraceToolDefinition[] | undefined;
		if (isSession) {
			run.turnRequested = true;
			run.requestId = requestId;
			const definitions = toolDefinitions(run.preparedTools ?? this.attachment?.session.agent.state.tools ?? []);
			run.preparedTools = undefined;
			const toolsJson = JSON.stringify(definitions);
			if (toolsJson !== run.toolsJson) {
				run.toolsJson = toolsJson;
				tools = definitions;
			}
		}
		const unit = `request:${requestId}`;
		this.append(
			{
				type: "model_request",
				requestId,
				kind: isSession ? "session" : "auxiliary",
				...(run ? { runId: run.runId } : {}),
				...(isSession ? { turn: run.turn } : {}),
				model: modelRef(model),
				...(tools ? { tools } : {}),
			},
			unit,
		);
		this.requests.set(requestId, { seq: this.nextSeq - 1, kind: isSession ? "session" : "auxiliary", open: true });
		this.openUnits.add(unit);
		return requestId;
	}

	private failureMessage(
		model: Model<Api>,
		error: unknown,
		content: AssistantMessage["content"] = [],
	): AssistantMessage {
		return {
			role: "assistant",
			content,
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
			stopReason: "error",
			errorMessage: errorMessage(error),
			timestamp: Date.now(),
		};
	}

	private forward(
		requestId: string,
		model: Model<Api>,
		source: AssistantMessageEventStream,
	): AssistantMessageEventStream {
		const output = new ForwardedEventStream();
		const encoder = new AssistantMessageFrameEncoder();
		let settled = false;
		// Content the stream produced so far; a later failure is recorded with it, so the terminal
		// agrees with the frames already captured.
		let partial: AssistantMessage | undefined;
		void (async () => {
			try {
				for await (const event of source) {
					if ("partial" in event) partial = event.partial;
					this.observe(() => {
						if (event.type === "done" || event.type === "error") {
							settled = true;
							this.finishRequest(requestId, event.type === "done" ? event.message : event.error);
							return;
						}
						const frame = encoder.encode(event);
						if (frame) {
							this.append(
								{ type: "model_frame", requestId, frame: frame as unknown as TraceFrame },
								`request:${requestId}`,
							);
						}
					});
					output.push(event);
				}
				const message = await source.result();
				if (!settled) this.observe(() => this.finishRequest(requestId, message));
				output.succeed(message);
			} catch (error) {
				this.observe(() =>
					this.finishRequest(
						requestId,
						this.failureMessage(model, error, partial ? structuredClone(partial.content) : []),
						errorMessage(error),
					),
				);
				output.fail(error);
			}
		})();
		return output;
	}

	private finishRequest(requestId: string, message: AssistantMessage, setupError?: string): void {
		const request = this.requests.get(requestId);
		if (!request?.open) return;
		request.open = false;
		const unit = `request:${requestId}`;
		this.append(
			{
				type: "model_response",
				requestId,
				terminal: { reason: message.stopReason, message },
				...(setupError === undefined ? {} : { error: setupError }),
			},
			unit,
		);
		if (message.stopReason === "error") {
			this.append(
				{
					type: "error",
					source: "model",
					requestId,
					...(this.run ? { runId: this.run.runId } : {}),
					message: message.errorMessage ?? "Model request failed",
				},
				unit,
			);
		}
		this.terminals.set(message, { requestId, json: JSON.stringify(message) });
		if (request.kind === "session" && this.gate !== undefined && request.seq > this.gate) this.gate = undefined;
		this.closeUnit(unit);
	}

	private onRequestAuth(notification: RequestAuthNotification): void {
		this.redactor.addSecret(notification.apiKey);
		this.redactor.addHeaders(notification.headers);
		this.redactor.addEnv(notification.env);
		if (notification.phase !== "final") return;
		const requestId = requestContext.getStore();
		const request = requestId === undefined ? undefined : this.requests.get(requestId);
		if (request?.kind === "session" && request.open && this.gate !== undefined && request.seq > this.gate) {
			this.gate = undefined;
		}
		this.flush();
	}

	private readonly hookObserver: ExtensionHandlerObserver = (invocation) => {
		let hookId: string | undefined;
		this.observe(() => {
			const id = uuidv7();
			this.append({ type: "hook", hookId: id, phase: "start", ...invocation });
			this.openHooks.add(id);
			hookId = id;
		});
		return (outcome) => {
			const id = hookId;
			if (id === undefined) return;
			this.observe(() => {
				this.openHooks.delete(id);
				if (outcome.status === "ok") {
					this.append({ type: "hook", hookId: id, phase: "end", status: "ok", returned: outcome.returned });
				} else {
					const message = errorMessage(outcome.error);
					this.append({ type: "hook", hookId: id, phase: "end", status: "error", error: message });
					this.append({ type: "error", source: "hook", hookId: id, message });
				}
				this.flush();
			});
		};
	};

	private onSessionEvent(event: AgentSessionEvent): void {
		const attachment = this.attachment;
		if (!attachment) return;
		const sessionId = attachment.sessionId;
		const agent = attachment.session.agent;
		const run = this.run;
		switch (event.type) {
			case "agent_start": {
				const runId = uuidv7();
				const nextRun: RunState = { runId, turn: -1, turnOpen: false, turnRequested: false };
				const signal = agent.signal;
				if (signal) {
					const onAbort = () => this.observe(() => this.append({ type: "cancel", runId }));
					signal.addEventListener("abort", onAbort, { once: true });
					nextRun.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				}
				this.run = nextRun;
				this.append({
					type: "run_start",
					sessionId,
					runId,
					model: modelRef(agent.state.model),
					thinkingLevel: agent.state.thinkingLevel,
					toolExecution: agent.toolExecution,
				});
				return;
			}
			case "turn_start":
				if (!run) return;
				run.turn++;
				run.turnOpen = true;
				run.turnRequested = false;
				this.append({ type: "turn_start", runId: run.runId, turn: run.turn });
				return;
			case "turn_end":
				// A run that fails before its first turn still reports turn_end; there is no turn to close.
				if (!run?.turnOpen) return;
				run.turnOpen = false;
				this.append({ type: "turn_end", runId: run.runId, turn: run.turn });
				return;
			case "agent_end":
				if (!run) return;
				run.removeAbortListener?.();
				this.run = undefined;
				this.gate = undefined;
				this.append({ type: "run_end", runId: run.runId, willRetry: event.willRetry });
				this.flush();
				return;
			case "message_end": {
				const context = {
					sessionId,
					...(run ? { runId: run.runId, ...(run.turn >= 0 ? { turn: run.turn } : {}) } : {}),
				};
				if (event.message.role === "assistant") {
					// Extensions may replace the provider result in place; keep both versions.
					const terminal = this.terminals.get(event.message);
					if (terminal && JSON.stringify(event.message) === terminal.json) return;
					this.append({
						type: "message",
						...context,
						...(terminal ? { requestId: terminal.requestId } : {}),
						message: event.message,
					});
					return;
				}
				this.gate ??= this.nextSeq;
				this.append({ type: "message", ...context, message: event.message });
				return;
			}
			case "tool_execution_start": {
				const ids = this.toolIds(event.toolCallId);
				if (!ids) return;
				const unit = toolKey(ids.requestId, ids.toolCallId);
				this.openUnits.add(unit);
				this.append({ type: "tool_start", ...ids, toolName: event.toolName, args: event.args }, unit);
				return;
			}
			case "tool_execution_update": {
				const ids = this.toolIds(event.toolCallId);
				if (!ids) return;
				this.append(
					{ type: "tool_update", ...ids, partialResult: event.partialResult },
					toolKey(ids.requestId, ids.toolCallId),
				);
				return;
			}
			case "tool_execution_end": {
				const ids = this.toolIds(event.toolCallId);
				if (!ids) return;
				const unit = toolKey(ids.requestId, ids.toolCallId);
				this.append({ type: "tool_end", ...ids, result: event.result, isError: event.isError }, unit);
				this.closeUnit(unit);
				return;
			}
			case "message_start":
			case "message_update":
			case "entry_appended":
			case "bash_execution_update":
				return;
			default: {
				const { type, ...data } = event;
				this.append({ type: "session", sessionId, event: type, data });
			}
		}
	}
}
