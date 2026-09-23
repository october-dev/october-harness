import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { track as trackAstra } from "../../src/delta/astra/index.ts";
import { track as trackCow } from "../../src/delta/cow/index.ts";
import type { Draft } from "../../src/delta/draft.ts";
import type { Op } from "../../src/delta/index.ts";
import { track as trackDelta } from "../../src/delta/tracker.ts";

type Mode = "cow" | "astra" | "delta";
type Scenario = "import" | "committed-read" | "draft-read" | "sparse" | "queue" | "sort" | "dense" | "unshift";
type Row = { id: number; value: number; payload: string };
type Document = { rows: Row[] };
type PreparedLike = { readonly value: Readonly<Document>; readonly ops: readonly Op[] };
type ChangeLike = { readonly state: Draft<Document>; prepare(): PreparedLike };
type TrackerLike = { readonly value: Document; beginChange(): ChangeLike; adopt(prepared: PreparedLike): void };

const MiB = 1024 * 1024;
const mode = process.argv[2] as Mode;
const scenario = process.argv[3] as Scenario;
const size = Number(process.argv[4] ?? 100_000);
const trial = Number(process.argv[5] ?? 0);

function fixture(count: number): Document {
	return {
		rows: Array.from({ length: count }, (_, id) => ({ id, value: id, payload: `row-${id}` })),
	};
}

function sum(document: Document | Draft<Document>): number {
	let checksum = 0;
	for (let index = 0; index < document.rows.length; index++) checksum += document.rows[index]!.value;
	return checksum;
}

async function gc(): Promise<void> {
	assert.ok(global.gc, "benchmark worker requires --expose-gc");
	for (let index = 0; index < 3; index++) {
		await setImmediate();
		global.gc();
	}
}

await gc();
const baselineHeap = process.memoryUsage().heapUsed;
let input: Document | undefined = fixture(size);
if (scenario === "sort") input.rows.reverse();
const importStart = performance.now();
const tracker = (
	mode === "cow" ? trackCow(input) : mode === "astra" ? trackAstra(input) : trackDelta(input)
) as TrackerLike;
const importMs = performance.now() - importStart;
input = undefined;
await gc();
const readyHeap = process.memoryUsage().heapUsed;
let peakHeap = readyHeap;
let mutateMs = 0;
let prepareMs = 0;
let serializeMs = 0;
let adoptMs = 0;
let opBytes = 0;
let operationCount = 0;
let checksum = 0;
const queueOperations = Math.min(size, 1_000);

if (scenario === "committed-read") {
	const start = performance.now();
	checksum = sum(tracker.value);
	mutateMs = performance.now() - start;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
} else if (scenario !== "import") {
	let change: ChangeLike | undefined = tracker.beginChange();
	const start = performance.now();
	switch (scenario) {
		case "draft-read":
			checksum = sum(change.state);
			break;
		case "sparse":
			for (let index = 0; index < size; index += 1_000) change.state.rows[index]!.value = -index;
			checksum = change.state.rows.at(-1)!.value;
			break;
		case "queue":
			for (let index = 0; index < queueOperations; index++) {
				change.state.rows.shift();
				change.state.rows.push({ id: size + index, value: index, payload: "queue" });
			}
			checksum = change.state.rows.length;
			break;
		case "sort":
			change.state.rows.sort((left, right) => left.id - right.id);
			checksum = change.state.rows[0]!.id;
			break;
		case "dense":
			for (let index = 0; index < size; index++) change.state.rows[index]!.value = -index;
			checksum = change.state.rows.at(-1)!.value;
			break;
		case "unshift": {
			const inserted = Array.from({ length: 100_000 }, (_, id) => ({ id: -id, value: id, payload: "inserted" }));
			Reflect.apply(change.state.rows.unshift, change.state.rows, inserted);
			checksum = change.state.rows.length;
			break;
		}
	}
	mutateMs = performance.now() - start;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	const prepareStart = performance.now();
	let prepared: PreparedLike | undefined = change.prepare();
	prepareMs = performance.now() - prepareStart;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	const serializeStart = performance.now();
	const serialized = JSON.stringify(prepared.ops);
	serializeMs = performance.now() - serializeStart;
	opBytes = Buffer.byteLength(serialized);
	operationCount = prepared.ops.length;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	const adoptStart = performance.now();
	tracker.adopt(prepared);
	adoptMs = performance.now() - adoptStart;
	change = undefined;
	prepared = undefined;
}

await gc();
const retainedHeap = process.memoryUsage().heapUsed;
console.log(
	JSON.stringify({
		mode,
		scenario,
		size,
		trial,
		queueOperations,
		importMs,
		mutateMs,
		prepareMs,
		serializeMs,
		adoptMs,
		opBytes,
		operationCount,
		checksum,
		readyMiB: (readyHeap - baselineHeap) / MiB,
		transientMiB: (peakHeap - readyHeap) / MiB,
		retainedMiB: (retainedHeap - baselineHeap) / MiB,
		maxRssMiB: process.resourceUsage().maxRSS / 1024,
	}),
);
