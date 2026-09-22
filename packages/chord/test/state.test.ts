import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { replicatedState } from "../src/index.ts";
import { ReplicatedStateReplica } from "../src/services/state.ts";
import { getReplicatedStateInternals } from "../src/services/state-internals.ts";
import type { Draft } from "../src/state/draft.ts";
import type { JsonValue } from "../src/types.ts";

describe("transactional replicated state", () => {
	it("publishes one immutable structurally shared revision", () => {
		const initial = { changed: { value: 1 }, retained: { value: 2 } };
		const state = replicatedState(initial);
		const previous = state.value;
		const deliveries: number[] = [];
		state.subscribe((_value, _context, delivery) => deliveries.push(delivery.sequence));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.changed.value = 3;
			draft.changed.value = 4;
		});
		expect(state.value).toEqual({ changed: { value: 4 }, retained: { value: 2 } });
		expect(state.value).not.toBe(previous);
		expect(state.value.changed).not.toBe(previous.changed);
		expect(state.value.retained).toBe(previous.retained);
		expect(Object.isFrozen(state.value)).toBe(true);
		expect(deliveries).toEqual([0, 1]);
	});

	it("rolls back callback failures and revokes escaped drafts", () => {
		const state = replicatedState({ nested: { value: 1 } });
		const previous = state.value;
		let escaped: Draft<{ value: number }> | undefined;
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				escaped = draft.nested;
				draft.nested.value = 2;
				throw new Error("stop");
			}),
		).toThrow("stop");
		expect(state.value).toBe(previous);
		expect(() => escaped?.value).toThrow(TypeError);
	});

	it("rejects nested changes and replacements without losing the outer rollback", () => {
		const state = replicatedState({ left: 0, right: 0 });
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.left = 1;
				state.change(BACKGROUND_CONTEXT, (nested) => {
					nested.right = 2;
				});
			}),
		).toThrow(/reentrantly/);
		expect(state.value).toEqual({ left: 0, right: 0 });
		expect(() =>
			state.change(BACKGROUND_CONTEXT, () => {
				state.replace(BACKGROUND_CONTEXT, { left: 1, right: 2 });
			}),
		).toThrow(/change callback/);
		expect(state.value).toEqual({ left: 0, right: 0 });
	});

	it("queues listener-triggered changes in sequence order", () => {
		const state = replicatedState({ value: 0 });
		const sourceSequences: number[] = [];
		const deliveries: Array<{ value: number; sequence: number }> = [];
		const lateDeliveries: Array<{ kind: string; sequence: number }> = [];
		let nested = false;
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => {
			if (!nested) {
				nested = true;
				state.change(BACKGROUND_CONTEXT, (draft) => {
					draft.value = 2;
				});
				state.subscribe((_value, _context, delivery) => lateDeliveries.push(delivery));
			}
			void sequence;
		});
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => sourceSequences.push(sequence));
		state.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") deliveries.push({ value: value.value, sequence: delivery.sequence });
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.value = 1;
		});
		expect(sourceSequences).toEqual([1, 2]);
		expect(deliveries).toEqual([
			{ value: 1, sequence: 1 },
			{ value: 2, sequence: 2 },
		]);
		expect(lateDeliveries).toEqual([{ kind: "hydrate", sequence: 2 }]);
	});

	it("isolates listener failures after committing the revision", () => {
		const state = replicatedState({ value: 0 });
		const received: number[] = [];
		getReplicatedStateInternals(state)!.subscribe(() => {
			throw new Error("listener failed");
		});
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => received.push(sequence));
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.value = 1;
			}),
		).toThrow("listener failed");
		expect(state.value).toEqual({ value: 1 });
		expect(received).toEqual([1]);
	});

	it("copies assigned values by value", () => {
		const external = { value: 1 };
		const state = replicatedState<{ left: { value: number } | null; right: { value: number } | null }>({
			left: null,
			right: null,
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.left = external;
			draft.right = external;
			draft.left.value = 2;
		});
		expect(external.value).toBe(1);
		expect(state.value).toEqual({ left: { value: 2 }, right: { value: 1 } });
		expect(state.value.left).not.toBe(state.value.right);
	});

	it("expands reused owned subtrees into independent placements", () => {
		const state = replicatedState({ left: { value: 1 }, right: { value: 2 } });
		state.replace(BACKGROUND_CONTEXT, { left: state.value.left, right: state.value.left });
		expect(state.value.left).not.toBe(state.value.right);
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.left.value = 9;
		});
		expect(state.value).toEqual({ left: { value: 9 }, right: { value: 1 } });

		const overlapping = replicatedState({ parent: { child: { value: 1 } }, other: { value: 2 } });
		overlapping.replace(BACKGROUND_CONTEXT, {
			parent: overlapping.value.parent,
			other: overlapping.value.parent.child,
		});
		expect(overlapping.value.parent.child).not.toBe(overlapping.value.other);
		overlapping.change(BACKGROUND_CONTEXT, (draft) => {
			draft.other.value = 9;
		});
		expect(overlapping.value).toEqual({ parent: { child: { value: 1 } }, other: { value: 9 } });
	});

	it("preserves compact string, splice, and permutation operations", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const state = replicatedState({ text: "abcdefgh", values: [a, b, c] });
		const batches: JsonValue[] = [];
		getReplicatedStateInternals(state)!.subscribe((operations) => batches.push(operations as unknown as JsonValue));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.text = "defghxyz";
			draft.values.shift();
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.values.reverse();
		});
		expect(batches).toEqual([
			[
				["t", ["text"], 3],
				["a", ["text"], "xyz"],
				["p", ["values"], 0, 1, []],
			],
			[["m", ["values"], [1, 0]]],
		]);
	});

	it("clears a replica when an adopted update is invalid", () => {
		const errors: Error[] = [];
		const replica = new ReplicatedStateReplica<{ value: number }>((error) => errors.push(error));
		replica.hydrate(0, [["r", { value: 0 }]], BACKGROUND_CONTEXT);
		expect(() => replica.update(1, [["s", ["value"], Number.NaN]], BACKGROUND_CONTEXT)).toThrow(/strict JSON/);
		expect(replica.value).toBeUndefined();
		expect(() => replica.update(2, [["s", ["value"], 2]], BACKGROUND_CONTEXT)).toThrow(/before hydration/);

		const malformed = new ReplicatedStateReplica<{ values: number[] }>((error) => errors.push(error));
		malformed.hydrate(0, [["r", { values: [1, 2] }]], BACKGROUND_CONTEXT);
		expect(() => malformed.update(1, [["m", ["values"], [0]]], BACKGROUND_CONTEXT)).toThrow();
		expect(malformed.value).toBeUndefined();
		expect(errors).toEqual([]);
	});

	it("replaces atomically and ignores deeply equal replacements", () => {
		const state = replicatedState({ value: { nested: 1 }, retained: { nested: 2 } });
		const previous = state.value;
		state.replace(BACKGROUND_CONTEXT, { value: { nested: 1 }, retained: { nested: 2 } });
		expect(state.value).toBe(previous);
		state.replace(BACKGROUND_CONTEXT, { ...state.value, value: { nested: 2 } });
		expect(state.value).toEqual({ value: { nested: 2 }, retained: { nested: 2 } });
		expect(state.value.retained).not.toBe(previous.retained);
	});
});
