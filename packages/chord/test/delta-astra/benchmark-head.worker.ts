import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { diffRevisions } from "../../src/delta/diff.ts";
import { type Draft, produceWithMetadata } from "../../src/delta/draft.ts";
import type { Op } from "../../src/delta/index.ts";
import { JsonRevisionStore } from "../../src/delta/value.ts";
import type { JsonValue } from "../../src/types.ts";

type Scenario = "import" | "committed-read" | "draft-read" | "sparse" | "queue" | "sort" | "dense" | "unshift";
type Row = { id: number; value: number; payload: string };
type Document = { rows: Row[] };

const MiB = 1024 * 1024;
const scenario = process.argv[2] as Scenario;
const size = Number(process.argv[3] ?? 100_000);
const trial = Number(process.argv[4] ?? 0);

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
const store = new JsonRevisionStore();
const importStart = performance.now();
let value = store.import(input);
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
	checksum = sum(value);
	mutateMs = performance.now() - start;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
} else if (scenario !== "import") {
	const draftStart = performance.now();
	const produced = produceWithMetadata(value, (draft) => {
		const start = performance.now();
		switch (scenario) {
			case "draft-read":
				checksum = sum(draft);
				break;
			case "sparse":
				for (let index = 0; index < size; index += 1_000) draft.rows[index]!.value = -index;
				checksum = draft.rows.at(-1)!.value;
				break;
			case "queue":
				for (let index = 0; index < queueOperations; index++) {
					draft.rows.shift();
					draft.rows.push({ id: size + index, value: index, payload: "queue" });
				}
				checksum = draft.rows.length;
				break;
			case "sort":
				draft.rows.sort((left, right) => left.id - right.id);
				checksum = draft.rows[0]!.id;
				break;
			case "dense":
				for (let index = 0; index < size; index++) draft.rows[index]!.value = -index;
				checksum = draft.rows.at(-1)!.value;
				break;
			case "unshift": {
				const inserted = Array.from({ length: 100_000 }, (_, id) => ({ id: -id, value: id, payload: "inserted" }));
				Reflect.apply(draft.rows.unshift, draft.rows, inserted);
				checksum = draft.rows.length;
				break;
			}
		}
		mutateMs = performance.now() - start;
		peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	});
	const draftFinalizeMs = performance.now() - draftStart - mutateMs;
	const prepareStart = performance.now();
	const next = produced.value === value ? value : store.commit(produced.value, produced.owned);
	const operations: readonly Op[] =
		next === value ? [] : diffRevisions(value as unknown as JsonValue, next as unknown as JsonValue);
	prepareMs = draftFinalizeMs + performance.now() - prepareStart;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	const serializeStart = performance.now();
	const serialized = JSON.stringify(operations);
	serializeMs = performance.now() - serializeStart;
	opBytes = Buffer.byteLength(serialized);
	operationCount = operations.length;
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	const adoptStart = performance.now();
	value = next;
	adoptMs = performance.now() - adoptStart;
}

await gc();
const retainedHeap = process.memoryUsage().heapUsed;
console.log(
	JSON.stringify({
		mode: "head",
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
