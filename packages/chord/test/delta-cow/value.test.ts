import { describe, expect, it } from "vitest";
import { track } from "../../src/delta/cow/index.ts";

describe("trusted immutable revision ownership", () => {
	it("takes O(1) ownership of an alias-free strict-JSON root", () => {
		const input = { left: { value: 1 }, right: { value: 2 } };
		const tracker = track(input);
		expect(tracker.value).toBe(input);
		expect(tracker.value.left).toBe(input.left);
	});

	it("copies changed branches while sharing untouched branches", () => {
		const tracker = track({ changed: { value: 1 }, retained: { value: 2 } });
		const base = tracker.value;
		const change = tracker.beginChange();
		change.state.changed.value = 3;
		const prepared = change.prepare();
		expect(prepared.value).not.toBe(base);
		expect(prepared.value.changed).not.toBe(base.changed);
		expect(prepared.value.retained).toBe(base.retained);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(prepared.value);
	});

	it("makes repeated placements independent", () => {
		const tracker = track({ values: [] as { value: number }[] });
		const change = tracker.beginChange();
		const shared = { value: 1 };
		change.state.values.push(shared, shared);
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual([{ value: 1 }, { value: 1 }]);
		expect(prepared.value.values[0]).not.toBe(prepared.value.values[1]);
	});
});
