import { describe, expect, it } from "vitest";
import { apply, applyImmutable, type Draft, type Op, track } from "../../src/delta/cow/index.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("optimized COW transaction invariants", () => {
	it("matches candidate, detached replay, and adopted value", () => {
		const tracker = track({ rows: [{ value: 1 }], text: "a" });
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		change.state.rows[0]!.value = 2;
		change.state.rows.push({ value: 3 });
		change.state.text += "b";
		const prepared = change.prepare();
		const candidate = clone(prepared.value);
		const operations = clone(prepared.ops);
		expect(apply(base, operations)).toEqual(candidate);
		tracker.adopt(prepared);
		expect(tracker.value).toEqual(candidate);
	});

	it("clones external and draft placements independently", () => {
		const tracker = track({
			source: { value: 1 },
			left: null as { value: number } | null,
			right: null as { value: number } | null,
			rows: [] as { value: number }[],
		});
		const external = { value: 2 };
		const change = tracker.beginChange();
		change.state.left = external;
		change.state.right = change.state.source;
		change.state.rows.push(external, external, change.state.source);
		external.value = 9;
		change.state.source.value = 7;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({
			source: { value: 7 },
			left: { value: 2 },
			right: { value: 1 },
			rows: [{ value: 2 }, { value: 2 }, { value: 1 }],
		});
		expect(prepared.value.rows[0]).not.toBe(prepared.value.rows[1]);
	});

	it("distinguishes raw committed and draft-subtree assignments", () => {
		const tracker = track({
			source: { value: 1 },
			rawCopy: null as { value: number } | null,
			draftCopy: null as { value: number } | null,
		});
		const raw = tracker.value.source;
		const change = tracker.beginChange();
		change.state.source.value = 5;
		change.state.rawCopy = raw;
		change.state.draftCopy = change.state.source;
		expect(change.prepare().value).toEqual({ source: { value: 5 }, rawCopy: { value: 1 }, draftCopy: { value: 5 } });
	});

	it("keeps Prepared.value authoritative and independent from public operations", () => {
		const tracker = track({ rows: [] as { value: number }[] });
		const change = tracker.beginChange();
		change.state.rows.push({ value: 1 });
		const prepared = change.prepare();
		const splice = prepared.ops[0];
		if (splice?.[0] !== "p") throw new Error("expected splice");
		expect(splice[4][0]).not.toBe(prepared.value.rows[0]);
		(splice[4][0] as { value: number }).value = 99;
		expect(prepared.value.rows[0]!.value).toBe(1);
		tracker.adopt(prepared);
		expect(tracker.value).toBe(prepared.value);
		expect(tracker.value.rows[0]!.value).toBe(1);
	});

	it("supports a MemoryStorage-style recursive clone", () => {
		const storageClone = <T>(value: T): T => {
			if (value === null || typeof value !== "object") return value;
			if (Array.isArray(value)) return value.map(storageClone) as T;
			const output: Record<string, unknown> = {};
			for (const key of Object.keys(value)) output[key] = storageClone((value as Record<string, unknown>)[key]);
			return output as T;
		};
		const tracker = track({ rows: [{ value: 1 }] });
		const change = tracker.beginChange();
		change.state.rows[0]!.value = 2;
		change.state.rows.push({ value: 3 });
		expect(storageClone(change.prepare().value)).toEqual({ rows: [{ value: 2 }, { value: 3 }] });
	});

	it("folds reserved-key changes without prototype pollution", () => {
		const initial = JSON.parse('{"safe":{"__proto__":{"value":1}}}') as {
			safe: { __proto__: { value: number } };
		};
		const tracker = track(initial);
		const change = tracker.beginChange();
		change.state.safe.__proto__.value = 2;
		const prepared = change.prepare();
		expect(applyImmutable(tracker.value, prepared.ops)).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(({} as Record<string, unknown>).value).toBeUndefined();
	});
});

describe("logical placement cloning", () => {
	it("does not let a detached dirty object handle overwrite its replacement", () => {
		const tracker = track({ child: { value: 1 }, stable: { value: 9 } });
		const change = tracker.beginChange();
		const held = change.state.child;
		held.value = 2;
		change.state.child = { value: 3 };
		held.value = 4;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ child: { value: 3 }, stable: { value: 9 } });
		expect(apply(clone(tracker.value), clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(tracker.value.child.value).toBe(3);
	});

	it("does not let a detached dirty array handle overwrite its replacement", () => {
		const tracker = track({ rows: [{ value: 1 }, { value: 9 }] });
		const change = tracker.beginChange();
		const held = change.state.rows[0]!;
		held.value = 2;
		change.state.rows[0] = { value: 3 };
		held.value = 4;
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ rows: [{ value: 3 }, { value: 9 }] });
		expect(apply(clone(tracker.value), clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);
		expect(tracker.value.rows[0]!.value).toBe(3);
	});

	it("copyWithin clones pending dirty descendants with primitive indices", () => {
		const tracker = track({ rows: [{ nested: { value: 1 } }, { nested: { value: 2 } }] });
		const change = tracker.beginChange();
		change.state.rows[0]!.nested.value = 9;
		change.state.rows.copyWithin(1, 0, 1);
		const prepared = change.prepare();
		expect(prepared.value).toEqual({ rows: [{ nested: { value: 9 } }, { nested: { value: 9 } }] });
		expect(prepared.value.rows[0]).not.toBe(prepared.value.rows[1]);
		expect(apply(clone(tracker.value), clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("keeps diff-aligned moved placements independent in the authoritative candidate", () => {
		const tracker = track({
			rows: [
				{ id: 0, score: 0, label: "r-0" },
				{ id: 1, score: 1 },
				{ id: 2, score: 2 },
				{ id: 2, score: 2 },
				{ id: 200106, score: 16, label: "r-200106" },
				{ id: 4, score: 200103 },
				{ id: 5, score: 200002 },
				{ id: 6, score: 6, label: "r-6" },
				{ id: 7, score: 7 },
				{ id: 200001, score: 13, label: "r-200001" },
			],
			text: "start-200100-200107",
			meta: { count: 0 },
		});
		const base = clone(tracker.value);
		const change = tracker.beginChange();
		let held = change.state.rows[5]!;
		change.state.rows.unshift({ id: 200200, score: 13 });
		held.score += 1_000;
		change.state.meta.count -= 2;
		held = change.state.rows[3]!;
		change.state.rows.unshift({ id: 200202, score: 15, label: "r-200202" });
		held.score += 1_000;
		change.state.text += "-200203";
		change.state.rows[0] = { id: 200204, score: 12 };
		change.state.rows[1] = change.state.rows[2]!;
		change.state.text += "-200206";
		change.state.rows.sort((left, right) => left.id - right.id || left.score - right.score);
		const prepared = change.prepare();
		expect(prepared.value.rows[0]!.id).toBe(0);
		expect(prepared.value.rows[1]!.id).toBe(0);
		expect(prepared.value.rows[0]).not.toBe(prepared.value.rows[1]);
		expect(apply(base, clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);

		const next = tracker.beginChange();
		const secondScore = next.state.rows[1]!.score;
		next.state.rows[0]!.score = 99;
		const nextPrepared = next.prepare();
		expect(nextPrepared.value.rows[0]!.score).toBe(99);
		expect(nextPrepared.value.rows[1]!.score).toBe(secondScore);
		expect(nextPrepared.value.rows[0]).not.toBe(nextPrepared.value.rows[1]);
		nextPrepared.abort();
	});

	it("fuzzes deeply-equal duplicate placements through movement and stable sort", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const initial = {
				rows: Array.from({ length: 20 }, (_, index) => ({
					id: Math.floor(index / 2),
					score: Math.floor(index / 2),
					label: `row-${Math.floor(index / 2)}`,
				})),
			};
			const tracker = track(initial);
			const expected = clone(initial);
			const change = tracker.beginChange();
			const heldIndex = seed % expected.rows.length;
			const expectedHeld = expected.rows[heldIndex]!;
			const draftHeld = change.state.rows[heldIndex]!;
			expected.rows.unshift({ id: 100 + seed, score: seed, label: `front-${seed}` });
			change.state.rows.unshift({ id: 100 + seed, score: seed, label: `front-${seed}` });
			expectedHeld.score += 1_000;
			draftHeld.score += 1_000;
			expected.rows.unshift({ id: 200 + seed, score: seed, label: `front2-${seed}` });
			change.state.rows.unshift({ id: 200 + seed, score: seed, label: `front2-${seed}` });
			const source = (seed * 7) % expected.rows.length;
			let target = (seed * 11 + 3) % expected.rows.length;
			if (target === source) target = (target + 1) % expected.rows.length;
			expected.rows[target] = clone(expected.rows[source]!);
			change.state.rows[target] = change.state.rows[source]!;
			expected.rows.sort((left, right) => left.id - right.id || left.score - right.score);
			change.state.rows.sort((left, right) => left.id - right.id || left.score - right.score);
			const prepared = change.prepare();
			expect(prepared.value, `candidate seed ${seed}`).toEqual(expected);
			expect(new Set(prepared.value.rows).size, `identity seed ${seed}`).toBe(prepared.value.rows.length);
			expect(apply(clone(initial), clone(prepared.ops)), `replay seed ${seed}`).toEqual(expected);
			prepared.abort();
		}
	});

	it("clones a dirty draft subtree from its source tracker context", () => {
		const source = track({ subtree: { nested: { value: 1 }, rows: [{ value: 2 }] } });
		const destination = track({ copy: null as { nested: { value: number }; rows: { value: number }[] } | null });
		const sourceChange = source.beginChange();
		sourceChange.state.subtree.nested.value = 7;
		sourceChange.state.subtree.rows[0]!.value = 8;
		const destinationChange = destination.beginChange();
		destinationChange.state.copy = sourceChange.state.subtree;
		const prepared = destinationChange.prepare();
		expect(prepared.value.copy).toEqual({ nested: { value: 7 }, rows: [{ value: 8 }] });
		expect(apply(clone(destination.value), clone(prepared.ops))).toEqual(prepared.value);
		destination.adopt(prepared);
		sourceChange.abort();
	});
});

describe("native mutator parity", () => {
	const compareNumbers = (
		nativeMutation: (values: number[]) => void,
		draftMutation: (values: number[]) => void,
	): void => {
		const native = [1, 2, 3];
		nativeMutation(native);
		const tracker = track({ values: [1, 2, 3] });
		const change = tracker.beginChange();
		draftMutation(change.state.values);
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual(native);
		tracker.adopt(prepared);
	};

	it("matches captured-length splice coercion when coercion mutates the array", () => {
		compareNumbers(
			(values) => {
				values.splice(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					1,
					9,
				);
			},
			(values) => {
				values.splice(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					1,
					9,
				);
			},
		);
	});

	it("keeps reentrant splice shrink results dense strict JSON", () => {
		const tracker = track({ values: [1, 2, 3] as Array<number | null> });
		const change = tracker.beginChange();
		change.state.values.splice(
			{
				valueOf() {
					change.state.values.length = 1;
					return 0;
				},
			} as unknown as number,
			0,
			9,
		);
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual([9, 1, null, null]);
		expect(Object.keys(prepared.value.values)).toEqual(["0", "1", "2", "3"]);
		expect(prepared.value.values.every((value) => value !== undefined)).toBe(true);
		expect(apply(clone(tracker.value), clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("matches fill and copyWithin coercion side effects", () => {
		compareNumbers(
			(values) => {
				values.fill(7, {
					valueOf() {
						values.push(4);
						return 1;
					},
				} as unknown as number);
			},
			(values) => {
				values.fill(7, {
					valueOf() {
						values.push(4);
						return 1;
					},
				} as unknown as number);
			},
		);
		compareNumbers(
			(values) => {
				values.copyWithin(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					0,
					2,
				);
			},
			(values) => {
				values.copyWithin(
					{
						valueOf() {
							values.push(4);
							return 1;
						},
					} as unknown as number,
					0,
					2,
				);
			},
		);
	});

	it("matches comparator direct-index and structural writes", () => {
		type Row = { rank: number; touches: number };
		const mutate = (values: Row[]): void => {
			let changed = false;
			values.sort((left, right) => {
				left.touches += 1;
				right.touches += 1;
				if (!changed) {
					changed = true;
					values[0] = { rank: 9, touches: 0 };
					values.push({ rank: 3, touches: 0 });
				}
				return left.rank - right.rank;
			});
		};
		const native: Row[] = [
			{ rank: 2, touches: 0 },
			{ rank: 1, touches: 0 },
		];
		mutate(native);
		const tracker = track({
			values: [
				{ rank: 2, touches: 0 },
				{ rank: 1, touches: 0 },
			],
		});
		const change = tracker.beginChange();
		mutate(change.state.values);
		const prepared = change.prepare();
		expect(prepared.value.values).toEqual(native);
		expect(apply(clone(tracker.value), clone(prepared.ops))).toEqual(prepared.value);
		tracker.adopt(prepared);
	});

	it("rejects bigint comparator results like native sort", () => {
		expect(() => [2, 1].sort(() => 1n as unknown as number)).toThrow(TypeError);
		const tracker = track({ values: [2, 1] });
		const change = tracker.beginChange();
		expect(() => change.state.values.sort(() => 1n as unknown as number)).toThrow(TypeError);
		change.abort();
		expect(tracker.value.values).toEqual([2, 1]);
	});

	it("forwards borrowed mutators to ordinary generic array receivers", () => {
		const tracker = track({ values: [1, 2, 3] });
		const change = tracker.beginChange();
		const receiver = [3, 1, 2];
		expect(Reflect.apply(change.state.values.push, receiver, [4])).toBe(4);
		expect(Reflect.apply(change.state.values.splice, receiver, [1, 1, 5])).toEqual([1]);
		expect(Reflect.apply(change.state.values.sort, receiver, [(left: number, right: number) => left - right])).toBe(
			receiver,
		);
		expect(Reflect.apply(change.state.values.fill, receiver, [7, 1, 2])).toBe(receiver);
		expect(Reflect.apply(change.state.values.copyWithin, receiver, [2, 0, 1])).toBe(receiver);
		expect(receiver).toEqual([2, 7, 2, 5]);
		expect(change.state.values).toEqual([1, 2, 3]);
		change.abort();
	});
});

describe("batched immutable application", () => {
	it("copies shared ancestors once while preserving untouched subtrees", () => {
		const base = {
			rows: [
				{ a: 1, b: 2 },
				{ a: 3, b: 4 },
			],
			stable: { value: 9 },
		};
		const operations: Op[] = [
			["s", ["rows", 0, "a"], 10],
			["s", ["rows", 0, "b"], 20],
			["s", ["rows", 1, "a"], 30],
		];
		const result = applyImmutable(base, operations);
		expect(result).toEqual({
			rows: [
				{ a: 10, b: 20 },
				{ a: 30, b: 4 },
			],
			stable: { value: 9 },
		});
		expect(base).toEqual({
			rows: [
				{ a: 1, b: 2 },
				{ a: 3, b: 4 },
			],
			stable: { value: 9 },
		});
		expect(result.stable).toBe(base.stable);
	});

	it("does not mutate replacement or insertion payloads targeted later in the batch", () => {
		const replacement = { rows: [{ value: 1 }] };
		const result = applyImmutable<typeof replacement>(undefined, [
			["r", replacement],
			["s", ["rows", 0, "value"], 2],
		]);
		expect(result.rows[0]!.value).toBe(2);
		expect(replacement.rows[0]!.value).toBe(1);
	});
});

type Item = { id: number; score: number };
type Document = { rows: Item[]; text: string; meta: { revision: number; label?: string } };
type MutableDocument = Document | Draft<Document>;

function mutate(document: MutableDocument, choice: number, value: number): void {
	const item = (): Item => ({ id: value, score: value % 7 });
	switch (choice) {
		case 0:
			document.text += `-${value}`;
			break;
		case 1:
			document.rows.push(item());
			break;
		case 2:
			document.rows.unshift(item());
			break;
		case 3:
			if (document.rows.length > 0) document.rows.shift();
			break;
		case 4:
			if (document.rows.length > 0) document.rows.pop();
			break;
		case 5: {
			const index = document.rows.length === 0 ? 0 : value % (document.rows.length + 1);
			document.rows.splice(index, document.rows.length === 0 ? 0 : value % 2, item());
			break;
		}
		case 6:
			document.rows.reverse();
			break;
		case 7:
			document.rows.sort((left, right) => left.id - right.id);
			break;
		case 8:
			if (document.rows.length > 0) document.rows[value % document.rows.length]!.score = value;
			break;
		case 9:
			document.meta.revision += 1;
			document.meta.label = `r-${value}`;
			break;
		default:
			delete document.meta.label;
	}
}

it("converges through randomized multi-operation transactions", () => {
	for (let seed = 1; seed <= 30; seed++) {
		let randomState = seed;
		const random = (): number => {
			randomState = (randomState + 0x6d2b79f5) | 0;
			let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
			value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
		const initial: Document = {
			rows: Array.from({ length: 4 }, (_, id) => ({ id, score: 0 })),
			text: "start",
			meta: { revision: 0 },
		};
		const tracker = track(initial);
		const expected = clone(initial);
		for (let transaction = 0; transaction < 20; transaction++) {
			const base = clone(tracker.value);
			const change = tracker.beginChange();
			for (let operation = 0; operation < 5; operation++) {
				const choice = Math.floor(random() * 11);
				const value = seed * 10_000 + transaction * 10 + operation;
				mutate(expected, choice, value);
				mutate(change.state, choice, value);
			}
			const prepared = change.prepare();
			const candidate = clone(prepared.value);
			expect(candidate, `candidate seed ${seed} transaction ${transaction}`).toEqual(expected);
			expect(apply(base, clone(prepared.ops)), `replay seed ${seed} transaction ${transaction}`).toEqual(expected);
			tracker.adopt(prepared);
			expect(tracker.value, `adopt seed ${seed} transaction ${transaction}`).toEqual(expected);
		}
	}
}, 30_000);
