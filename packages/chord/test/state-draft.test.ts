import { describe, expect, it } from "vitest";
import { type Draft, produce, produceWithMetadata } from "../src/state/draft.ts";

describe("produce", () => {
	it("returns the base when the recipe makes no semantic write", () => {
		const base = { count: 1, nested: { value: "same" }, values: [1, 2, 3] };
		const result = produce(base, (draft) => {
			draft.count = 1;
			draft.nested.value = "same";
			delete (draft as { missing?: boolean }).missing;
			draft.values.sort((left, right) => left - right);
		});
		expect(result).toBe(base);
	});

	it("copies only changed branches and keeps stable draft identities", () => {
		const base = {
			changed: { count: 1, sibling: { value: "kept" } },
			untouched: { value: 2 },
		};
		let first: Draft<typeof base.changed> | undefined;
		const { value, owned } = produceWithMetadata(base, (draft) => {
			first = draft.changed;
			expect(draft.changed).toBe(first);
			draft.changed.count = 2;
			draft.changed.count = 3;
		});

		expect(value).not.toBe(base);
		expect(value.changed).not.toBe(base.changed);
		expect(value.changed.sibling).toBe(base.changed.sibling);
		expect(value.untouched).toBe(base.untouched);
		expect(value.changed.count).toBe(3);
		expect(owned.has(value)).toBe(true);
		expect(owned.has(value.changed)).toBe(true);
		expect(owned.has(value.changed.sibling)).toBe(false);
		expect(owned.has(value.untouched)).toBe(false);
		expect(owned.has(base)).toBe(false);
	});

	it("supports property assignment and deletion without mutating a frozen base", () => {
		const nested: Readonly<{ old: boolean }> = Object.freeze({ old: true });
		const base: Readonly<{
			name: string;
			nested: Readonly<{ old: boolean }>;
			optional?: string;
		}> = Object.freeze({ name: "before", nested, optional: "remove" });
		const result = produce(base, (draft) => {
			draft.name = "after";
			delete draft.optional;
			draft.nested.old = false;
		});

		expect(result).toEqual({ name: "after", nested: { old: false } });
		expect(base).toEqual({ name: "before", nested: { old: true }, optional: "remove" });
		expect(nested.old).toBe(true);
	});

	it("assigns base containers by value instead of creating aliases", () => {
		const shared = { value: 1 };
		const base: { source: { value: number }; alias: { value: number } | null } = { source: shared, alias: null };
		const { value, owned } = produceWithMetadata(base, (draft) => {
			draft.alias = base.source;
			draft.alias.value = 2;
		});

		expect(base.source.value).toBe(1);
		expect(value.source).toBe(base.source);
		expect(value.source.value).toBe(1);
		expect(value.alias).toEqual({ value: 2 });
		expect(value.alias).not.toBe(value.source);
		expect(owned.has(value)).toBe(true);
		expect(owned.has(value.alias!)).toBe(true);
		expect(owned.has(value.source)).toBe(false);
	});

	it("preserves tuple positions in draft types", () => {
		const base = { tuple: ["value", 1] as readonly [string, number] };
		produce(base, (draft) => {
			const text: string = draft.tuple[0];
			const count: number = draft.tuple[1];
			draft.tuple = [text, count + 1];
		});
	});

	it("rejects asynchronous recipes without changing the base", () => {
		const base = { value: 1 };
		expect(() =>
			produce(base, async (draft) => {
				draft.value = 2;
				await Promise.resolve();
			}),
		).toThrow(/synchronous/);
		expect(base).toEqual({ value: 1 });
	});

	it("rolls back and revokes every created draft when the recipe throws", () => {
		const base = { child: { count: 1 }, values: [1, 2] };
		const failure = new Error("stop");
		let escapedChild: Draft<typeof base.child> | undefined;
		let escapedArray: Draft<typeof base.values> | undefined;

		expect(() =>
			produce(base, (draft) => {
				escapedChild = draft.child;
				escapedArray = draft.values;
				draft.child.count = 9;
				draft.values.push(3);
				throw failure;
			}),
		).toThrow(failure);
		expect(base).toEqual({ child: { count: 1 }, values: [1, 2] });
		expect(() => escapedChild?.count).toThrow(TypeError);
		expect(() => escapedArray?.length).toThrow(TypeError);
	});

	it("revokes escaped drafts after a successful recipe", () => {
		const base = { child: { count: 1 } };
		let escapedRoot: Draft<typeof base> | undefined;
		let escapedChild: Draft<typeof base.child> | undefined;
		const result = produce(base, (draft) => {
			escapedRoot = draft;
			escapedChild = draft.child;
			draft.child.count = 2;
		});

		expect(result.child.count).toBe(2);
		expect(() => escapedRoot?.child).toThrow(TypeError);
		expect(() => escapedChild?.count).toThrow(TypeError);
	});

	it("supports native mutating array methods", () => {
		const base = { values: [3, 1, 2] };
		const result = produce(base, (draft) => {
			draft.values.push(4);
			expect(draft.values.pop()).toBe(4);
			draft.values.unshift(0);
			expect(draft.values.shift()).toBe(0);
			expect(draft.values.splice(1, 1, 5, 4)).toEqual([1]);
			draft.values.sort((left, right) => left - right);
			draft.values.reverse();
			draft.values.fill(9, 1, 3);
			draft.values.copyWithin(1, 0, 2);
		});

		expect(result.values).toEqual([5, 5, 9, 2]);
		expect(base.values).toEqual([3, 1, 2]);
	});

	it("copies inserted draft values without detaching their original handle", () => {
		const base = { values: [{ value: 1 }, { value: 2 }] };
		const result = produce(base, (draft) => {
			const held = draft.values[0]!;
			draft.values.unshift(held);
			held.value = 9;
		});
		expect(result.values).toEqual([{ value: 1 }, { value: 9 }, { value: 2 }]);
		expect(result.values[0]).not.toBe(result.values[1]);
	});

	it("fill reads its value after coercing its range", () => {
		const base = { values: [{ value: 0 }], other: { value: 1 } };
		const result = produce(base, (draft) => {
			draft.values.fill(draft.other, {
				valueOf() {
					draft.other.value = 2;
					return 0;
				},
			} as unknown as number);
		});
		expect(result.values).toEqual([{ value: 2 }]);
		expect(
			produce(base, (draft) => {
				draft.values.fill(undefined as unknown as { value: number }, 0, 0);
			}),
		).toBe(base);
	});

	it("copies object values for fill and copyWithin", () => {
		const base = { values: [{ value: 1 }, { value: 2 }, { value: 3 }] };
		const result = produce(base, (draft) => {
			draft.values.copyWithin(1, 0, 1);
			draft.values[0]!.value = 9;
		});
		expect(result.values).toEqual([{ value: 9 }, { value: 1 }, { value: 3 }]);
		expect(result.values[0]).not.toBe(result.values[1]);
		const filled = produce({ ...base, other: { value: 4 } }, (draft) => {
			draft.values.fill(draft.other);
			draft.values[0]!.value = 5;
		});
		expect(filled.values).toEqual([{ value: 5 }, { value: 4 }, { value: 4 }]);
		expect(new Set([...filled.values, filled.other]).size).toBe(4);
	});

	it("uses the actual receiver for borrowed array mutators", () => {
		const base = { left: [{ value: 1 }, { value: 2 }], right: [{ value: 3 }] };
		const external = [{ value: 0 }];
		const result = produce(base, (draft) => {
			const held = draft.left[0]!;
			draft.right.reverse.call(draft.left);
			held.value = 9;
			draft.right.push.call(external, { value: 2 });
			expect(() => {
				const push = draft.right.push;
				push({ value: 4 });
			}).toThrow(TypeError);
		});
		expect(result.left).toEqual([{ value: 2 }, { value: 9 }]);
		expect(external).toEqual([{ value: 0 }, { value: 2 }]);
	});

	it("copies user assignments made while an array mutator coerces arguments", () => {
		const base = { values: [{ value: 1 }], other: { value: 2 } };
		const result = produce(base, (draft) => {
			draft.values.splice(
				{
					valueOf() {
						draft.values[0] = draft.other;
						return 0;
					},
				} as unknown as number,
				0,
			);
			draft.values[0]!.value = 3;
		});
		expect(result).toEqual({ values: [{ value: 3 }], other: { value: 2 } });
		expect(result.values[0]).not.toBe(result.other);

		const sameArray = produce({ values: [{ value: 1 }, { value: 2 }] }, (draft) => {
			draft.values.splice(
				{
					valueOf() {
						draft.values[1] = draft.values[0]!;
						return 0;
					},
				} as unknown as number,
				0,
			);
			draft.values[0]!.value = 9;
		});
		expect(sameArray.values).toEqual([{ value: 9 }, { value: 1 }]);
		expect(sameArray.values[0]).not.toBe(sameArray.values[1]);
	});

	it("copyWithin preserves handles across coercion side effects", () => {
		const base = { values: [{ value: 1 }, { value: 2 }, { value: 3 }] };
		const result = produce(base, (draft) => {
			const held = draft.values[2]!;
			draft.values.copyWithin(
				0,
				{
					valueOf() {
						draft.values.reverse();
						return 0;
					},
				} as unknown as number,
				0,
			);
			held.value = 9;
		});
		expect(result.values).toEqual([{ value: 9 }, { value: 2 }, { value: 1 }]);
	});

	it("preserves native coercion semantics in array arguments", () => {
		const spliced = produce({ values: [1, 2, 3] }, (draft) => {
			draft.values.splice(Number.POSITIVE_INFINITY, 0, 4);
		});
		expect(spliced.values).toEqual([1, 2, 3, 4]);
		const filled = produce({ values: [1, 2, 3] }, (draft) => {
			draft.values.fill(9, Number.POSITIVE_INFINITY);
			draft.values.copyWithin(Number.POSITIVE_INFINITY, 0);
		});
		expect(filled.values).toEqual([1, 2, 3]);
		const explicitUndefined = produce({ values: [1, 2, 3], copied: [1, 2, 3] }, (draft) => {
			draft.values.fill(9, 0, undefined as unknown as number);
			draft.copied.copyWithin(1, 0, undefined as unknown as number);
		});
		expect(explicitUndefined.values).toEqual([9, 9, 9]);
		expect(explicitUndefined.copied).toEqual([1, 1, 2]);
		const capturedLength = produce({ values: [1, 2] }, (draft) => {
			draft.values.splice(
				{
					valueOf() {
						draft.values.push(3);
						return 1;
					},
				} as unknown as number,
				0,
			);
		});
		expect(capturedLength.values).toEqual([1, 2]);
		const removedLength = produce({ values: [1, 2, 3], removed: 0 }, (draft) => {
			const removed = draft.values.splice(
				{
					valueOf() {
						draft.values.length = 0;
						return 0;
					},
				} as unknown as number,
				3,
			);
			draft.removed = removed.length;
		});
		expect(removedLength).toEqual({ values: [], removed: 3 });
	});

	it("default sort observes pending nested edits", () => {
		const base = { values: [[2], [1]] };
		const result = produce(base, (draft) => {
			draft.values[0]![0] = 0;
			draft.values.sort();
		});
		expect(result.values).toEqual([[0], [1]]);
	});

	it("keeps comparator edits when sorting object drafts", () => {
		const base = {
			rows: [
				{ rank: 2, comparisons: 0 },
				{ rank: 1, comparisons: 0 },
			],
		};
		const result = produce(base, (draft) => {
			draft.rows.sort((left, right) => {
				left.comparisons++;
				right.comparisons++;
				return left.rank - right.rank;
			});
		});

		expect(result.rows.map((row) => row.rank)).toEqual([1, 2]);
		expect(result.rows.map((row) => row.comparisons)).toEqual([1, 1]);
		expect(result.rows[0]).not.toBe(base.rows[1]);
		expect(result.rows[1]).not.toBe(base.rows[0]);
		expect(base.rows).toEqual([
			{ rank: 2, comparisons: 0 },
			{ rank: 1, comparisons: 0 },
		]);
	});

	it("drops writes through detached child handles", () => {
		const kept = { value: "kept" };
		const removed = { value: "removed" };
		const base = { child: removed, items: [removed, kept] };
		const result = produce(base, (draft) => {
			const child = draft.child;
			const shifted = draft.items.shift();
			delete (draft as { child?: Draft<typeof removed>; items: Draft<typeof base.items> }).child;
			child.value = "detached child";
			if (shifted !== undefined) shifted.value = "detached item";
		});

		expect(result).toEqual({ items: [kept] });
		expect(result.items[0]).toBe(kept);
		expect(removed.value).toBe("removed");
	});

	it("deep-clones assigned values, expands aliases, and reports every clone as owned", () => {
		const shared = { value: 2 };
		const external = { left: shared, right: shared };
		const base: { payload: typeof external | null; untouched: { value: number } } = {
			payload: null,
			untouched: { value: 1 },
		};
		const { value, owned } = produceWithMetadata(base, (draft) => {
			draft.payload = external;
			draft.payload.left.value = 3;
		});

		expect(external.left.value).toBe(2);
		expect(value.payload).not.toBe(external);
		expect(value.payload?.left).not.toBe(shared);
		expect(value.payload?.right).not.toBe(shared);
		expect(value.payload?.left).not.toBe(value.payload?.right);
		expect(value.payload).toEqual({ left: { value: 3 }, right: { value: 2 } });
		expect(value.untouched).toBe(base.untouched);
		expect(owned.has(value)).toBe(true);
		expect(owned.has(value.payload!)).toBe(true);
		expect(owned.has(value.payload!.left)).toBe(true);
		expect(owned.has(value.payload!.right)).toBe(true);
		expect(owned.has(external)).toBe(false);
		expect(owned.has(shared)).toBe(false);
	});

	it("rejects cycles in assigned values without changing the base", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const base: { payload: object | null } = { payload: null };
		expect(() =>
			produce(base, (draft) => {
				draft.payload = cyclic;
			}),
		).toThrow(/cycles/);
		expect(base.payload).toBeNull();
	});

	it("rejects sparse or undefined array results", () => {
		const base = { values: [1, 2] };
		expect(() =>
			produce(base, (draft) => {
				delete draft.values[0];
			}),
		).toThrow(/dense|holes/);
		expect(() =>
			produce(base, (draft) => {
				draft.values[0] = undefined as unknown as number;
			}),
		).toThrow(/undefined/);
		expect(() =>
			produce(base, (draft) => {
				draft.values.length = 4;
			}),
		).toThrow(/dense|holes/);
		expect(base.values).toEqual([1, 2]);
	});

	it("writes own properties without invoking inherited setters", () => {
		Object.defineProperty(Object.prototype, "trap", {
			set() {
				throw new Error("inherited setter ran");
			},
			configurable: true,
		});
		try {
			const result = produce({ nested: {} as Record<string, number> }, (draft) => {
				draft.nested.trap = 1;
			});
			expect(result).toEqual({ nested: { trap: 1 } });
		} finally {
			delete (Object.prototype as Record<string, unknown>).trap;
		}

		let pushed: { values: number[] } | undefined;
		let unshifted: { values: number[] } | undefined;
		Object.defineProperty(Array.prototype, "3", {
			set() {
				throw new Error("inherited array setter ran");
			},
			configurable: true,
		});
		try {
			pushed = produce({ values: [1, 2, 3] }, (draft) => {
				draft.values.push(4);
			});
			unshifted = produce({ values: [1, 2, 3] }, (draft) => {
				draft.values.unshift(0);
			});
		} finally {
			delete (Array.prototype as unknown as Record<string, unknown>)["3"];
		}
		expect(pushed).toEqual({ values: [1, 2, 3, 4] });
		expect(unshifted).toEqual({ values: [0, 1, 2, 3] });
	});

	it("rejects reflective mutations and symbol writes", () => {
		const base = { value: 1 };
		expect(() => produce(base, (draft) => Object.defineProperty(draft, "other", { value: 2 }))).toThrow(TypeError);
		expect(() => produce(base, (draft) => Object.setPrototypeOf(draft, null))).toThrow(TypeError);
		expect(() => produce(base, (draft) => Object.preventExtensions(draft))).toThrow(TypeError);
		expect(() => produce(base, (draft) => Reflect.set(draft, Symbol("key"), 2))).toThrow(/Symbol/);
		expect(base).toEqual({ value: 1 });
	});
});
