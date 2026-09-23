import type { JsonValue } from "../../types.ts";
import { type NonEmptyPath, type Op, overlap, type Path, RESERVED_SEGMENTS } from "../index.ts";
import type { DiffHints } from "./draft.ts";

const DEFAULT_OVERLAP_SCAN = 65_536;
const MAX_DELTA_OPERATIONS = 4_096;
const overflowedBatches = new WeakSet<Op[]>();

const emitOperation = (operations: Op[], operation: Op): void => {
	if (overflowedBatches.has(operations)) return;
	if (operations.length >= MAX_DELTA_OPERATIONS) {
		overflowedBatches.add(operations);
		return;
	}
	operations.push(operation);
};

const isContainer = (value: JsonValue): value is JsonValue[] | Record<string, JsonValue> =>
	value !== null && typeof value === "object";

const emitSet = (path: Path, value: JsonValue, operations: Op[]): void => {
	if (path.length === 0) emitOperation(operations, ["r", value]);
	else emitOperation(operations, ["s", path as NonEmptyPath, value]);
};

const equalJson = (left: JsonValue, right: JsonValue): boolean => {
	if (left === right) return true;
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const other = right as JsonValue[];
		if (left.length !== other.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!equalJson(left[index]!, other[index]!)) return false;
		}
		return true;
	}
	const other = right as Record<string, JsonValue>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(other).length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(other, key) || !equalJson(left[key]!, other[key]!)) return false;
	}
	return true;
};

const permutation = (before: readonly JsonValue[], after: readonly JsonValue[]): number[] | undefined => {
	if (before.length !== after.length) return undefined;
	// Cheap native probes before building a map: shifted/appended arrays fail here.
	if (before.indexOf(after[after.length - 1]!) === -1 || before.indexOf(after[0]!) === -1) return undefined;
	// A single index per value; duplicates upgrade to an index list.
	const positions = new Map<JsonValue, number | number[]>();
	for (let index = 0; index < before.length; index++) {
		const value = before[index]!;
		const entry = positions.get(value);
		if (entry === undefined) positions.set(value, index);
		else if (typeof entry === "number") positions.set(value, [entry, index]);
		else entry.push(index);
	}
	const used = new Map<JsonValue, number>();
	const result = new Array<number>(after.length);
	for (let index = 0; index < after.length; index++) {
		const value = after[index]!;
		const entry = positions.get(value);
		if (entry === undefined) return undefined;
		if (typeof entry === "number") {
			if (used.has(value)) return undefined;
			used.set(value, 1);
			result[index] = entry;
			continue;
		}
		const taken = used.get(value) ?? 0;
		if (taken === entry.length) return undefined;
		used.set(value, taken + 1);
		result[index] = entry[taken]!;
	}
	return result;
};

const emitString = (before: string, after: string, path: NonEmptyPath, operations: Op[]): void => {
	if (before === after) return;
	if (after.length > before.length && after.slice(0, before.length) === before) {
		emitOperation(operations, ["a", path, after.slice(before.length)]);
		return;
	}
	const shared = overlap(before, after, DEFAULT_OVERLAP_SCAN);
	if (shared === 0) {
		emitOperation(operations, ["s", path, after]);
		return;
	}
	emitOperation(operations, ["t", path, before.length - shared]);
	if (after.length > shared) emitOperation(operations, ["a", path, after.slice(shared)]);
};

type ArrayMatch = readonly [before: number, after: number];

type MatchCandidate = {
	before: number;
	after: number;
	previous: number;
};

const MAX_IDENTITY_CANDIDATES = 200_000;
const MAX_SEMANTIC_CELLS = 65_536;

const sameValue = (left: JsonValue, right: JsonValue): boolean => left === right || equalJson(left, right);

const lcsMatches = (
	before: readonly JsonValue[],
	after: readonly JsonValue[],
	equal: (left: JsonValue, right: JsonValue) => boolean,
	maxCells: number,
): ArrayMatch[] | undefined => {
	if (before.length === 0 || after.length === 0) return [];
	if (before.length * after.length > maxCells) return undefined;
	const width = after.length + 1;
	const lengths = new Uint32Array((before.length + 1) * width);
	for (let left = before.length - 1; left >= 0; left--) {
		for (let right = after.length - 1; right >= 0; right--) {
			const at = left * width + right;
			lengths[at] = equal(before[left]!, after[right]!)
				? lengths[(left + 1) * width + right + 1]! + 1
				: Math.max(lengths[(left + 1) * width + right]!, lengths[left * width + right + 1]!);
		}
	}
	const matches: ArrayMatch[] = [];
	let left = 0;
	let right = 0;
	while (left < before.length && right < after.length) {
		if (
			equal(before[left]!, after[right]!) &&
			lengths[left * width + right] === lengths[(left + 1) * width + right + 1]! + 1
		) {
			matches.push([left++, right++]);
		} else if (lengths[(left + 1) * width + right]! >= lengths[left * width + right + 1]!) left += 1;
		else right += 1;
	}
	return matches;
};

const semanticallyAligned = (left: JsonValue, right: JsonValue): boolean => {
	if (sameValue(left, right)) return true;
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		return left.some((value, index) => isContainer(value) && value === right[index]);
	}
	const leftObject = left as Record<string, JsonValue>;
	const rightObject = right as Record<string, JsonValue>;
	for (const key of Object.keys(leftObject)) {
		const value = leftObject[key];
		if (isContainer(value) && Object.hasOwn(rightObject, key) && value === rightObject[key]) return true;
	}
	return false;
};

const indexOfIdentity = (values: readonly JsonValue[], value: JsonValue, start: number, end: number): number => {
	if (!isContainer(value)) return -1; // primitives are not identity anchors
	const at = values.indexOf(value, start);
	return at === -1 || at >= end ? -1 : at;
};

const lowerBound = (values: readonly number[], value: number): number => {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! < value) low = middle + 1;
		else high = middle;
	}
	return low;
};

const identitySubsequence = (
	before: readonly JsonValue[],
	beforeStart: number,
	beforeEnd: number,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] | undefined => {
	const beforeCount = beforeEnd - beforeStart;
	const afterCount = afterEnd - afterStart;
	const matches: ArrayMatch[] = [];
	if (afterCount < beforeCount) {
		let beforeIndex = beforeStart;
		for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
			while (beforeIndex < beforeEnd && before[beforeIndex] !== after[afterIndex]) beforeIndex += 1;
			if (beforeIndex === beforeEnd) return undefined;
			matches.push([beforeIndex++, afterIndex]);
		}
		return matches;
	}
	if (beforeCount < afterCount) {
		let afterIndex = afterStart;
		for (let beforeIndex = beforeStart; beforeIndex < beforeEnd; beforeIndex++) {
			while (afterIndex < afterEnd && before[beforeIndex] !== after[afterIndex]) afterIndex += 1;
			if (afterIndex === afterEnd) return undefined;
			matches.push([beforeIndex, afterIndex++]);
		}
		return matches;
	}
	return undefined;
};

const greedyIdentityAnchors = (
	positions: ReadonlyMap<JsonValue, readonly number[]>,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] => {
	const matches: ArrayMatch[] = [];
	let previous = -1;
	for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
		const candidates = positions.get(after[afterIndex]!);
		if (candidates === undefined) continue;
		const at = lowerBound(candidates, previous + 1);
		const beforeIndex = candidates[at];
		if (beforeIndex === undefined) continue;
		matches.push([beforeIndex, afterIndex]);
		previous = beforeIndex;
	}
	return matches;
};

const identityAnchors = (
	before: readonly JsonValue[],
	beforeStart: number,
	beforeEnd: number,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] => {
	const positions = new Map<JsonValue, number[]>();
	for (let index = beforeStart; index < beforeEnd; index++) {
		const value = before[index]!;
		const existing = positions.get(value);
		if (existing === undefined) positions.set(value, [index]);
		else existing.push(index);
	}
	let candidateCount = 0;
	for (let index = afterStart; index < afterEnd; index++) {
		candidateCount += positions.get(after[index]!)?.length ?? 0;
		if (candidateCount > MAX_IDENTITY_CANDIDATES) {
			return greedyIdentityAnchors(positions, after, afterStart, afterEnd);
		}
	}
	if (candidateCount === 0) return [];

	const candidates: MatchCandidate[] = [];
	const tails: number[] = [];
	const tailValues: number[] = [];
	for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
		const beforePositions = positions.get(after[afterIndex]!);
		if (beforePositions === undefined) continue;
		for (let index = beforePositions.length - 1; index >= 0; index--) {
			const beforeIndex = beforePositions[index]!;
			const at = lowerBound(tailValues, beforeIndex);
			const candidateIndex = candidates.length;
			candidates.push({ before: beforeIndex, after: afterIndex, previous: at === 0 ? -1 : tails[at - 1]! });
			tails[at] = candidateIndex;
			tailValues[at] = beforeIndex;
		}
	}
	const matches: ArrayMatch[] = [];
	let candidateIndex = tails[tails.length - 1] ?? -1;
	while (candidateIndex >= 0) {
		const candidate = candidates[candidateIndex]!;
		matches.push([candidate.before, candidate.after]);
		candidateIndex = candidate.previous;
	}
	matches.reverse();
	return matches;
};

const processArrayMatches = (
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	hints: DiffHints,
	beforeStart: number,
	beforeEnd: number,
	afterStart: number,
	afterEnd: number,
	outputStart: number,
	matches: readonly ArrayMatch[],
): void => {
	let beforeAt = beforeStart;
	let afterAt = afterStart;
	let outputAt = outputStart;
	for (const [beforeMatch, afterMatch] of matches) {
		if (overflowedBatches.has(operations)) return;
		diffArrayRegion(before, after, path, operations, hints, beforeAt, beforeMatch, afterAt, afterMatch, outputAt);
		outputAt += afterMatch - afterAt;
		if (!sameValue(before[beforeMatch]!, after[afterMatch]!)) {
			diffValue(before[beforeMatch]!, after[afterMatch]!, [...path, outputAt], operations, hints);
		}
		outputAt += 1;
		beforeAt = beforeMatch + 1;
		afterAt = afterMatch + 1;
	}
	if (!overflowedBatches.has(operations)) {
		diffArrayRegion(before, after, path, operations, hints, beforeAt, beforeEnd, afterAt, afterEnd, outputAt);
	}
};

function diffArrayRegion(
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	hints: DiffHints,
	beforeStart: number,
	beforeEnd: number,
	afterStart: number,
	afterEnd: number,
	outputStart: number,
): void {
	if (overflowedBatches.has(operations)) return;
	while (beforeStart < beforeEnd && afterStart < afterEnd && sameValue(before[beforeStart]!, after[afterStart]!)) {
		beforeStart += 1;
		afterStart += 1;
		outputStart += 1;
	}
	while (beforeStart < beforeEnd && afterStart < afterEnd && sameValue(before[beforeEnd - 1]!, after[afterEnd - 1]!)) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	const beforeCount = beforeEnd - beforeStart;
	const afterCount = afterEnd - afterStart;
	if (beforeCount === 0 && afterCount === 0) return;
	if (beforeCount === 0 || afterCount === 0) {
		emitOperation(operations, ["p", path, outputStart, beforeCount, after.slice(afterStart, afterEnd)]);
		return;
	}

	if (beforeCount === afterCount) {
		// Streaming positional alignment: equivalent to collecting positional
		// matches and diffing the gaps between them, without a tuple per match.
		let matched = false;
		let gapStart = -1;
		for (let offset = 0; offset <= beforeCount; offset++) {
			const same = offset < beforeCount && sameValue(before[beforeStart + offset]!, after[afterStart + offset]!);
			if (same) {
				matched = true;
				if (gapStart !== -1) {
					if (overflowedBatches.has(operations)) return;
					diffArrayRegion(
						before,
						after,
						path,
						operations,
						hints,
						beforeStart + gapStart,
						beforeStart + offset,
						afterStart + gapStart,
						afterStart + offset,
						outputStart + gapStart,
					);
					gapStart = -1;
				}
			} else if (gapStart === -1) gapStart = offset;
		}
		if (matched) {
			if (gapStart !== -1 && !overflowedBatches.has(operations)) {
				diffArrayRegion(
					before,
					after,
					path,
					operations,
					hints,
					beforeStart + gapStart,
					beforeEnd,
					afterStart + gapStart,
					afterEnd,
					outputStart + gapStart,
				);
			}
			return;
		}
	}

	// Identity run fast paths (queue shift+push, unshift+pop). The run must be
	// longer than both remainders so it is the unique longest anchor chain; the
	// output then equals the LIS alignment below without a map or match list.
	{
		const k = indexOfIdentity(before, after[afterStart]!, beforeStart, beforeEnd);
		if (k !== -1) {
			let run = 0;
			const limit = Math.min(beforeEnd - k, afterCount);
			// Container-only runs: object identity is unique, so this run is the unique longest anchor chain.
			while (run < limit && before[k + run] === after[afterStart + run] && isContainer(before[k + run]!)) run += 1;
			if (k + run === beforeEnd && run > k - beforeStart && run > afterCount - run) {
				if (k > beforeStart) emitOperation(operations, ["p", path, outputStart, k - beforeStart, []]);
				if (run < afterCount) {
					emitOperation(operations, ["p", path, outputStart + run, 0, after.slice(afterStart + run, afterEnd)]);
				}
				return;
			}
		}
		const j = indexOfIdentity(after, before[beforeStart]!, afterStart, afterEnd);
		if (j !== -1) {
			let run = 0;
			const limit = Math.min(afterEnd - j, beforeCount);
			while (run < limit && before[beforeStart + run] === after[j + run] && isContainer(after[j + run]!)) run += 1;
			if (j + run === afterEnd && run > j - afterStart && run > beforeCount - run) {
				const inserted = j - afterStart;
				if (inserted > 0) emitOperation(operations, ["p", path, outputStart, 0, after.slice(afterStart, j)]);
				if (run < beforeCount) {
					emitOperation(operations, ["p", path, outputStart + inserted + run, beforeCount - run, []]);
				}
				return;
			}
		}
	}

	if (beforeCount === 1 && afterCount === 1) {
		// Every alignment strategy below ends in diffValue for a 1x1 region.
		diffValue(before[beforeStart]!, after[afterStart]!, [...path, outputStart], operations, hints);
		return;
	}

	const subsequence = identitySubsequence(before, beforeStart, beforeEnd, after, afterStart, afterEnd);
	if (subsequence !== undefined && subsequence.length > 0) {
		processArrayMatches(
			before,
			after,
			path,
			operations,
			hints,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			subsequence,
		);
		return;
	}

	const identity = identityAnchors(before, beforeStart, beforeEnd, after, afterStart, afterEnd);
	if (identity.length > 0) {
		processArrayMatches(
			before,
			after,
			path,
			operations,
			hints,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			identity,
		);
		return;
	}

	const semantic = lcsMatches(
		before.slice(beforeStart, beforeEnd),
		after.slice(afterStart, afterEnd),
		semanticallyAligned,
		MAX_SEMANTIC_CELLS,
	);
	if (semantic !== undefined && semantic.length > 0) {
		const absolute = semantic.map(
			([beforeIndex, afterIndex]) => [beforeStart + beforeIndex, afterStart + afterIndex] as const,
		);
		processArrayMatches(
			before,
			after,
			path,
			operations,
			hints,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			absolute,
		);
		return;
	}

	if (beforeCount === 1 && afterCount === 1) {
		diffValue(before[beforeStart]!, after[afterStart]!, [...path, outputStart], operations, hints);
		return;
	}
	emitOperation(operations, ["p", path, outputStart, beforeCount, after.slice(afterStart, afterEnd)]);
}

const diffArray = (before: JsonValue[], after: JsonValue[], path: Path, operations: Op[], hints: DiffHints): void => {
	if (before === after) return;
	const hint = hints.get(after);
	if (hint?.base === before && hint.keys.length < 2_048) {
		for (const index of hint.keys) diffValue(before[index]!, after[index]!, [...path, index], operations, hints);
		return;
	}
	if (equalJson(before, after)) return;
	if (
		before.length === after.length &&
		before.length > 1 &&
		!sameValue(before[0]!, after[0]!) &&
		!sameValue(before[before.length - 1]!, after[after.length - 1]!)
	) {
		const order = permutation(before, after);
		if (order !== undefined) {
			emitOperation(operations, ["m", path, order]);
			return;
		}
	}
	diffArrayRegion(before, after, path, operations, hints, 0, before.length, 0, after.length, 0);
};

const diffObject = (
	before: Record<string, JsonValue>,
	after: Record<string, JsonValue>,
	path: Path,
	operations: Op[],
	hints: DiffHints,
): void => {
	const beforeKeys = Object.keys(before);
	const afterKeys = Object.keys(after);
	if ([...beforeKeys, ...afterKeys].some((key) => RESERVED_SEGMENTS.has(key))) {
		if (!equalJson(before, after)) emitSet(path, after, operations);
		return;
	}
	for (const key of afterKeys) {
		if (overflowedBatches.has(operations)) return;
		if (Object.hasOwn(before, key)) diffValue(before[key]!, after[key]!, [...path, key], operations, hints);
		else emitSet([...path, key], after[key]!, operations);
	}
	for (const key of beforeKeys) {
		if (overflowedBatches.has(operations)) return;
		if (!Object.hasOwn(after, key)) emitOperation(operations, ["d", [...path, key] as unknown as NonEmptyPath]);
	}
};

const diffValue = (before: JsonValue, after: JsonValue, path: Path, operations: Op[], hints: DiffHints): void => {
	if (before === after || overflowedBatches.has(operations)) return;
	if (typeof before === "string" && typeof after === "string" && path.length > 0) {
		emitString(before, after, path as NonEmptyPath, operations);
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		diffArray(before, after, path, operations, hints);
		return;
	}
	if (isContainer(before) && isContainer(after) && !Array.isArray(before) && !Array.isArray(after)) {
		diffObject(before, after, path, operations, hints);
		return;
	}
	emitSet(path, after, operations);
};

/** Compute a normalized batch, with deterministic operation-count safety folding only. */
export function diffRevisions(before: JsonValue, after: JsonValue, hints: DiffHints = new WeakMap()): Op[] {
	const operations: Op[] = [];
	diffValue(before, after, [], operations, hints);
	if (overflowedBatches.has(operations)) return [["r", after]];
	return operations;
}
