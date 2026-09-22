import { describe, expect, it } from "vitest";
import { produceWithMetadata } from "../src/state/draft.ts";
import { JsonRevisionStore } from "../src/state/value.ts";

describe("JSON revision ownership", () => {
	it("imports detached frozen JSON and expands aliases", () => {
		const shared = { value: 1 };
		const input = { left: shared, right: shared };
		const store = new JsonRevisionStore();
		const value = store.import(input);
		expect(value).toEqual(input);
		expect(value).not.toBe(input);
		expect(value.left).not.toBe(value.right);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.left)).toBe(true);
	});

	it("commits transaction copies in place while sharing unchanged branches", () => {
		const store = new JsonRevisionStore();
		const base = store.import({ changed: { value: 1 }, retained: { value: 2 } });
		const produced = produceWithMetadata(base, (draft) => {
			draft.changed.value = 3;
		});
		const next = store.commit(produced.value, produced.owned);
		expect(next).toBe(produced.value);
		expect(next.changed).toBe(produced.value.changed);
		expect(next.retained).toBe(base.retained);
		expect(Object.isFrozen(next)).toBe(true);
		expect(Object.isFrozen(next.changed)).toBe(true);
	});

	it("rejects non-JSON values and cycles", () => {
		const store = new JsonRevisionStore();
		expect(() => store.import({ value: Number.NaN })).toThrow(/strict JSON/);
		expect(() => store.import({ value: new Date() })).toThrow(/plain objects/);
		const cyclic: { self?: object } = {};
		cyclic.self = cyclic;
		expect(() => store.import(cyclic)).toThrow(/cycles/);
	});
});
