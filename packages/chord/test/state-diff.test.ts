import { describe, expect, it } from "vitest";
import { applyImmutable, assertValidOp, assertValidWireOp, decoder, encoder, type Op } from "../src/delta/index.ts";
import { diffRevisions } from "../src/state/diff.ts";
import type { JsonValue } from "../src/types.ts";

const expectDiff = (before: JsonValue, after: JsonValue, expected: JsonValue): void => {
	const operations = diffRevisions(before, after);
	expect(operations).toEqual(expected);
	expect(applyImmutable(before, operations)).toEqual(after);
};

describe("immutable revision diff", () => {
	it("emits sets and deletes", () => {
		expectDiff({ keep: 1, change: 1, remove: true }, { keep: 1, change: 2, add: 3 }, [
			["s", ["change"], 2],
			["s", ["add"], 3],
			["d", ["remove"]],
		]);
	});

	it("emits string append and front truncation", () => {
		expectDiff({ text: "hello" }, { text: "hello world" }, [["a", ["text"], " world"]]);
		expectDiff({ text: "hello world" }, { text: "world" }, [["t", ["text"], 6]]);
		expectDiff({ text: "abcdefgh" }, { text: "defghxyz" }, [
			["t", ["text"], 3],
			["a", ["text"], "xyz"],
		]);
	});

	it("represents array insertion, removal, and shift with splices", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		expectDiff({ values: [a, b] }, { values: [a, c, b] }, [["p", ["values"], 1, 0, [c]]]);
		expectDiff({ values: [a, b, c] }, { values: [b, c] }, [["p", ["values"], 0, 1, []]]);
	});

	it("collapses a same-length queue update to two splices", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const d = { id: "d" };
		expectDiff({ values: [a, b, c] }, { values: [b, c, d] }, [
			["p", ["values"], 0, 1, []],
			["p", ["values"], 2, 0, [d]],
		]);
	});

	it("emits a permutation for a pure reorder", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		expectDiff({ values: [a, b, c] }, { values: [c, a, b] }, [["m", ["values"], [2, 0, 1]]]);
	});

	it("validates and encodes permutations", () => {
		const operations: Op[] = [
			["m", ["values"], [2, 0, 1]],
			["m", ["values"], [1, 2, 0]],
		];
		for (const operation of operations) assertValidOp(operation);
		const wire = encoder().encode(operations);
		expect(wire).toEqual([
			["m", ["values"], [2, 0, 1]],
			["m", [1, 2, 0]],
		]);
		for (const operation of wire) assertValidWireOp(operation);
		expect(decoder().decode(wire)).toEqual(operations);
		expect(() => assertValidOp(["m", ["values"], [0, 0]])).toThrow(/bijection/);
	});

	it("emits nothing for deeply equal reconstructed values", () => {
		expect(diffRevisions({ value: { nested: [1, 2] } }, { value: { nested: [1, 2] } })).toEqual([]);
		expect(diffRevisions({ values: [{ id: 1 }, { id: 2 }] }, { values: [{ id: 1 }, { id: 2 }] })).toEqual([]);
		expect(diffRevisions({ values: [true, true, true] }, { values: [true, true, true] })).toEqual([]);
	});

	it("keeps a leaf edit inside a reconstructed array narrow", () => {
		expectDiff(
			{
				values: [
					{ id: 1, label: "one" },
					{ id: 2, label: "two" },
				],
			},
			{
				values: [
					{ id: 1, label: "one" },
					{ id: 2, label: "changed" },
				],
			},
			[["s", ["values", 1, "label"], "changed"]],
		);
	});

	it("falls back to a base operation when leaf operations are larger", () => {
		const before = { values: Array.from({ length: 40_000 }, () => 0) };
		const after = { values: Array.from({ length: 40_000 }, () => 1) };
		const operations = diffRevisions(before, after);
		expect(operations).toEqual([["r", after]]);
	});
});
