import { describe, expect, it } from "vitest";
import { apply, track } from "../src/delta/index.ts";

describe("tracker ownership", () => {
	it("deeply detaches and freezes the imported revision", () => {
		const input = {
			point: { x: 3, y: 7, pressure: 0.1 },
			rows: [{ values: [0, false, null, "text", { n: 1 }] }],
		};
		const tracker = track(input);
		expect(tracker.value).toEqual(input);
		expect(tracker.value).not.toBe(input);
		expect(tracker.value.point).not.toBe(input.point);
		expect(tracker.value.rows[0]!.values[4]).not.toBe(input.rows[0]!.values[4]);
		expect(Object.isFrozen(tracker.value.rows[0]!.values)).toBe(true);
		input.point.x = 99;
		expect(tracker.value.point.x).toBe(3);
	});

	it("preserves null prototypes and expands aliases", () => {
		type Dictionary = { enabled: boolean; child: { n: number } };
		const dictionary = Object.assign(Object.create(null) as Dictionary, { enabled: true, child: { n: 1 } });
		const shared = { nested: [{ n: 1 }] };
		const tracker = track({ dictionary, left: shared, right: shared });
		expect(Object.getPrototypeOf(tracker.value.dictionary)).toBeNull();
		expect(tracker.value.dictionary).not.toBe(dictionary);
		expect(tracker.value.left).not.toBe(tracker.value.right);
		expect(tracker.value.left.nested[0]).not.toBe(tracker.value.right.nested[0]);
	});

	it("copies assigned and inserted values immediately", () => {
		const tracker = track({ rows: [] as { nested: { value: number } }[] });
		const assigned = { nested: { value: 1 } };
		const change = tracker.beginChange();
		change.state.rows.push(assigned);
		assigned.nested.value = 9;
		expect(change.state.rows[0]!.nested.value).toBe(1);
		const prepared = change.prepare();
		expect(prepared.value.rows[0]!.nested.value).toBe(1);
		const replica = apply(structuredClone(prepared.base), prepared.ops);
		expect(replica).toEqual(prepared.value);
	});

	it("rejects cycles, accessors, classes, and non-finite numbers", () => {
		const cyclic: { self?: object } = {};
		cyclic.self = cyclic;
		expect(() => track(cyclic)).toThrow(/cycles/);
		expect(() => track({ value: Number.NaN })).toThrow(/strict JSON/);
		expect(() => track({ value: new Date() })).toThrow(/plain objects/);
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		expect(() => track(accessor)).toThrow(/data properties/);
	});

	it("rejects indexed accessors and non-enumerable array entries without invoking getters", () => {
		let reads = 0;
		const accessor: number[] = [];
		Object.defineProperty(accessor, "0", {
			enumerable: true,
			configurable: true,
			get() {
				reads += 1;
				return 1;
			},
		});
		expect(() => track({ values: accessor })).toThrow(/data properties/);
		expect(reads).toBe(0);

		const hidden: number[] = [];
		Object.defineProperty(hidden, "0", { value: 1, enumerable: false, configurable: true, writable: true });
		expect(() => track({ values: hidden })).toThrow(/enumerable/);

		const tracker = track({ values: [] as number[] });
		const change = tracker.beginChange();
		expect(() => {
			change.state.values = accessor;
		}).toThrow(/data properties/);
		expect(reads).toBe(0);
		change.abort();
	});
});
