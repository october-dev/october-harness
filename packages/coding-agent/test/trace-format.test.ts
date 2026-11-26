import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatTraceTimeline,
	parseTrace,
	TraceFormatError,
	UnsupportedTraceVersionError,
} from "../src/core/trace/format.ts";

// Regression: october-dev/october-harness#9

const fixture = readFileSync(resolve(__dirname, "fixtures/trace/synthetic.trace.jsonl"), "utf-8");
const lines = fixture.trim().split("\n");
const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const SECRET_CONTENT = "do-not-echo-this-content";

function text(items: Array<Record<string, unknown>>): string {
	return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

/** Records with contiguous seq values after edits. */
function renumbered(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return items.map((item, seq) => ({ ...item, seq }));
}

function indexOf(predicate: (record: Record<string, unknown>) => boolean): number {
	const index = records.findIndex(predicate);
	if (index < 0) throw new Error("fixture record not found");
	return index;
}

function expectFormatError(input: string, pattern: RegExp): TraceFormatError {
	let caught: unknown;
	try {
		parseTrace(input);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(TraceFormatError);
	const error = caught as TraceFormatError;
	expect(error.message).toMatch(pattern);
	expect(error.message).not.toContain(SECRET_CONTENT);
	return error;
}

describe("trace format validation", () => {
	it("parses the synthetic fixture as a complete trace", () => {
		const trace = parseTrace(fixture);
		expect(trace.complete).toBe(true);
		expect(trace.incomplete).toEqual([]);
		expect(trace.records).toHaveLength(lines.length);
		expect(trace.header.version).toBe(1);
	});

	it("rejects a missing header and names unsupported versions", () => {
		expectFormatError(text(records.slice(1)), /line 1.*missing trace header/);
		expectFormatError("", /missing trace header/);
		const future = { ...records[0], version: 2 };
		expect(() => parseTrace(text([future, ...records.slice(1)]))).toThrow(UnsupportedTraceVersionError);
		expect(() => parseTrace(text([future, ...records.slice(1)]))).toThrow(/unsupported trace version 2/);
	});

	it("rejects malformed payloads with line and seq context and no content echo", () => {
		const index = indexOf((record) => record.type === "model_request");
		const broken = records.map((record, position) =>
			position === index ? { ...record, model: SECRET_CONTENT } : record,
		);
		const error = expectFormatError(text(broken), new RegExp(`line ${index + 1}, seq ${index}\\)`));
		expect(error.line).toBe(index + 1);
		expectFormatError(`${lines[0]}\n{"type":"session","seq":1,"text":"${SECRET_CONTENT}"\n${lines[1]}\n`, /line 2/);
		expectFormatError(`${lines[0]}\n{"type":"mystery","seq":1,"ts":1}\n`, /unknown record type/);
	});

	it("reports a truncated final line as incomplete", () => {
		const trace = parseTrace(`${lines.slice(0, 5).join("\n")}\n${lines[5].slice(0, 30)}`);
		expect(trace.complete).toBe(false);
		expect(trace.incomplete).toContain("truncated final line 6");
		expect(trace.records).toHaveLength(5);
	});

	it("reports sequence gaps as incomplete and rejects duplicate seq values", () => {
		const gap = parseTrace(text([...records.slice(0, 5), ...records.slice(6)]));
		expect(gap.complete).toBe(false);
		expect(gap.incomplete[0]).toBe("sequence gap at line 6: expected seq 5, found 6");
		expect(gap.records).toHaveLength(5);

		expectFormatError(text([...records.slice(0, 5), records[4], ...records.slice(5)]), /line 6, seq 4.*duplicate/);
	});

	it("rejects broken correlations, duplicate terminals, and records after trace_end", () => {
		const toolStart = indexOf((record) => record.type === "tool_start");
		const unknownParent = records.map((record, position) =>
			position === toolStart ? { ...record, requestId: SECRET_CONTENT } : record,
		);
		expectFormatError(
			text(unknownParent),
			new RegExp(`line ${toolStart + 1}, seq ${toolStart}\\): unknown requestId$`),
		);

		const response = indexOf((record) => record.type === "model_response");
		const duplicate = renumbered([
			...records.slice(0, response + 1),
			records[response],
			...records.slice(response + 1),
		]);
		expectFormatError(text(duplicate), /duplicate response/);

		const after = renumbered([...records, records[1]]);
		expectFormatError(text(after), /record after trace_end/);

		const wrongCount = records.map((record) => (record.type === "trace_end" ? { ...record, eventCount: 3 } : record));
		expectFormatError(text(wrongCount), /eventCount/);
	});

	it("reports a missing trace_end and unfinished operations as incomplete", () => {
		const detach = indexOf((record) => record.type === "session_detach");
		const missingFooter = parseTrace(text(records.slice(0, detach + 1)));
		expect(missingFooter.complete).toBe(false);
		expect(missingFooter.incomplete).toEqual([`missing trace_end after line ${detach + 1} (seq ${detach})`]);

		const toolEnd = indexOf((record) => record.type === "tool_end");
		const toolStart = indexOf((record) => record.type === "tool_start");
		const lastBefore = (type: string) =>
			records.slice(0, toolEnd).reduce((found, record, index) => (record.type === type ? index : found), -1);
		const runStart = lastBefore("run_start");
		const turnStart = lastBefore("turn_start");
		const unfinished = parseTrace(text(records.slice(0, toolEnd)));
		expect(unfinished.complete).toBe(false);
		expect(unfinished.incomplete).toEqual([
			`unfinished turn started at line ${turnStart + 1} (seq ${turnStart})`,
			`unfinished run started at line ${runStart + 1} (seq ${runStart})`,
			`unfinished tool call started at line ${toolStart + 1} (seq ${toolStart})`,
			"session attached at line 2 (seq 1) was not detached",
			`missing trace_end after line ${toolEnd} (seq ${toolEnd - 1})`,
		]);
	});

	it("validates turn lifetimes and every record's run and session", () => {
		const firstTurnEnd = indexOf((record) => record.type === "turn_end");
		const wrongTurn = records.map((record, position) =>
			position === firstTurnEnd ? { ...record, turn: 999 } : record,
		);
		expectFormatError(text(wrongTurn), /turn_end without a matching turn_start/);

		const toolEnd = indexOf((record) => record.type === "tool_end");
		const wrongRun = records.map((record, position) =>
			position === toolEnd ? { ...record, runId: SECRET_CONTENT } : record,
		);
		expectFormatError(text(wrongRun), /tool record does not belong to the tool call's run$/);

		const missingTurnEnd = renumbered(records.filter((_record, position) => position !== firstTurnEnd));
		expectFormatError(text(missingTurnEnd), /run_end while a turn is open/);

		// Regression: a session response moved after its run ended must not validate.
		const response = indexOf((record) => record.type === "model_response");
		const runEnd = indexOf((record) => record.type === "run_end");
		const lateResponse = renumbered([
			...records.slice(0, response),
			...records.slice(response + 1, runEnd + 1),
			records[response],
			...records.slice(runEnd + 1),
		]);
		expectFormatError(text(lateResponse), /turn_end while its model request is open$/);

		const toolStart = indexOf((record) => record.type === "tool_start");
		const turnAfterTool = records.findIndex((record, index) => index > toolStart && record.type === "turn_end");
		// The tool's end and its transcript message move together past turn_end.
		const toolEndAndResult = records
			.slice(toolEnd, turnAfterTool)
			.filter(
				(record, index) =>
					index === 0 || (record.type === "message" && (record.message as { role: string }).role === "toolResult"),
			);
		const lateToolEnd = renumbered([
			...records.slice(0, turnAfterTool + 1).filter((record) => !toolEndAndResult.includes(record)),
			...toolEndAndResult,
			...records.slice(turnAfterTool + 1),
		]);
		expectFormatError(text(lateToolEnd), /turn_end while a tool call is open$/);

		// Regression: request-linked replacements and tool-result messages must appear inside their
		// open turn, not merely carry its number. A correctly placed replacement is the control.
		const echoRequest0 = records[indexOf((record) => record.type === "tool_start")].requestId as string;
		const echoResponse = indexOf((record) => record.type === "model_response" && record.requestId === echoRequest0);
		const echoRequestRecord =
			records[indexOf((record) => record.type === "model_request" && record.requestId === echoRequest0)];
		const replacementMessage = structuredClone(
			(records[echoResponse].terminal as { message: { usage: { output: number } } }).message,
		);
		replacementMessage.usage.output++;
		const replacement = {
			type: "message",
			seq: 0,
			ts: records[echoResponse].ts,
			sessionId: records[1].sessionId,
			runId: echoRequestRecord.runId,
			turn: echoRequestRecord.turn,
			requestId: echoRequest0,
			message: replacementMessage,
		};
		const insertAfter = (items: Array<Record<string, unknown>>, index: number, record: Record<string, unknown>) => {
			const copy = [...items];
			copy.splice(index + 1, 0, record);
			const numbered = renumbered(copy);
			const footer = numbered[numbered.length - 1];
			numbered[numbered.length - 1] = { ...footer, eventCount: footer.seq };
			return numbered;
		};
		const echoRun = echoRequestRecord.runId;
		const secondTurn = indexOf(
			(record) => record.type === "turn_start" && record.runId === echoRun && record.turn === 1,
		);
		const echoRunEnd = indexOf((record) => record.type === "run_end" && record.runId === echoRun);
		expect(parseTrace(text(insertAfter(records, echoResponse, replacement))).complete).toBe(true);
		expectFormatError(text(insertAfter(records, secondTurn, replacement)), /turn message outside its open turn$/);
		expectFormatError(text(insertAfter(records, echoRunEnd, replacement)), /run has already ended$/);

		const echoToolResult = indexOf(
			(record) => record.type === "message" && (record.message as { role: string }).role === "toolResult",
		);
		const withoutResult = records.filter((_record, index) => index !== echoToolResult);
		const secondTurnWithout = withoutResult.findIndex(
			(record) => record.type === "turn_start" && record.runId === echoRun && record.turn === 1,
		);
		const withoutResultEnd = withoutResult.findIndex(
			(record) => record.type === "run_end" && record.runId === echoRun,
		);
		expectFormatError(
			text(insertAfter(withoutResult, secondTurnWithout, records[echoToolResult])),
			/turn message outside its open turn$/,
		);
		expectFormatError(
			text(insertAfter(withoutResult, withoutResultEnd, records[echoToolResult])),
			/run has already ended$/,
		);

		const message = indexOf((record) => record.type === "message");
		// Regression: a whole tool invocation moved into the next turn keeps its old request.
		const echoStart = indexOf((record) => record.type === "tool_start" && record.toolCallId === "call-1");
		const echoResult = indexOf(
			(record) => record.type === "message" && (record.message as { toolCallId?: string }).toolCallId === "call-1",
		);
		const nextTurn = records.findIndex((record, index) => index > echoResult && record.type === "turn_start");
		const movedInvocation = renumbered([
			...records.slice(0, echoStart),
			...records.slice(echoResult + 1, nextTurn + 1),
			...records.slice(echoStart, echoResult + 1),
			...records.slice(nextTurn + 1),
		]);
		expectFormatError(text(movedInvocation), /tool call started outside its request's turn$/);

		const slowResult = indexOf(
			(record) => record.type === "message" && (record.message as { toolCallId?: string }).toolCallId === "call-2",
		);
		const echoRequest = records[echoStart].requestId;
		const replacementTurn = records.map((record, position) =>
			position === slowResult ? { ...record, requestId: echoRequest } : record,
		);
		expectFormatError(text(replacementTurn), /message replacement outside its request's turn$/);

		const otherSession = records.map((record, position) =>
			position === message ? { ...record, sessionId: SECRET_CONTENT } : record,
		);
		expectFormatError(text(otherSession), /record for a session that is not attached$/);
	});

	it("validates message payloads, frame lifecycles, and terminal consistency", () => {
		const response = indexOf((record) => record.type === "model_response");
		const withTerminal = (edit: (terminal: { reason: string; message: Record<string, unknown> }) => void) =>
			records.map((record, position) => {
				if (position !== response) return record;
				const copy = structuredClone(record) as { terminal: { reason: string; message: Record<string, unknown> } };
				edit(copy.terminal);
				return copy;
			});
		expectFormatError(
			text(
				withTerminal((terminal) => {
					terminal.message.content = [{ type: "text" }];
				}),
			),
			/\/terminal\/message\/content\/0.* fails the \w+ check/,
		);
		expectFormatError(
			text(
				withTerminal((terminal) => {
					terminal.reason = "length";
				}),
			),
			/terminal reason differs from the message stop reason/,
		);
		expectFormatError(
			text(
				withTerminal((terminal) => {
					terminal.message.content = [{ type: "text", text: "different" }];
				}),
			),
			/model frames differ from the terminal message/,
		);

		const textEnd = indexOf(
			(record) => record.type === "model_frame" && (record.frame as { type: string }).type === "text_end",
		);
		const orphanEnd = records.map((record, position) =>
			position === textEnd ? { ...record, frame: { ...(record.frame as object), contentIndex: 999 } } : record,
		);
		expectFormatError(text(orphanEnd), /invalid model frame sequence/);

		const user = indexOf(
			(record) => record.type === "message" && (record.message as { role: string }).role === "user",
		);
		const badUser = records.map((record, position) =>
			position === user
				? { ...record, message: { role: "user", content: [{ type: "text" }], timestamp: 1 } }
				: record,
		);
		expectFormatError(text(badUser), /line \d+, seq \d+\): \/message\/content/);
	});

	it("accepts orderly failed and cancelled runs as complete", () => {
		const response = indexOf((record) => record.type === "model_response");
		const failed = records.map((record, position) => {
			if (position !== response) return record;
			const terminal = record.terminal as { reason: string; message: Record<string, unknown> };
			return {
				...record,
				terminal: { reason: "aborted", message: { ...terminal.message, stopReason: "aborted" } },
			};
		});
		const run = records.find((record) => record.type === "run_start")?.runId;
		const cancelled = renumbered([
			...failed.slice(0, response),
			{ type: "cancel", seq: 0, ts: 1, runId: run },
			...failed.slice(response),
		]);
		cancelled[cancelled.length - 1] = { ...cancelled[cancelled.length - 1], eventCount: cancelled.length - 1 };
		expect(parseTrace(text(cancelled)).complete).toBe(true);
	});

	it("formats one timeline line per record without payload content", () => {
		const timeline = formatTraceTimeline(parseTrace(fixture));
		expect(timeline).toHaveLength(lines.length);
		expect(timeline[0]).toMatch(/^#0 \+0ms header pi-trace v1/);
		expect(timeline.find((line) => line.includes(" tool_start "))).toMatch(/run2 req2 tool=call-1 echo$/);
		expect(timeline.join("\n")).not.toContain("Hello! How can I help?");
	});
});
