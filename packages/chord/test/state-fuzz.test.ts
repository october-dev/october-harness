import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { applyImmutable, type Op } from "../src/delta/index.ts";
import { replicatedState } from "../src/index.ts";
import { getReplicatedStateInternals } from "../src/services/state-internals.ts";
import type { Draft } from "../src/state/draft.ts";

type Item = { id: number; text: string; score: number };
type Document = {
	items: Item[];
	text: string;
	meta: { revision: number; label?: string };
};

type MutableDocument = Document | Draft<Document>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const random =
	(seed: number): (() => number) =>
	() => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};

const mutate = (document: MutableDocument, choice: number, value: number): void => {
	const item = (): Item => ({ id: value, text: `item-${value}`, score: value % 7 });
	switch (choice) {
		case 0:
			document.text += `-${value}`;
			break;
		case 1:
			document.text = `${document.text.slice(Math.min(2, document.text.length))}${value}`;
			break;
		case 2:
			document.items.push(item());
			break;
		case 3:
			document.items.unshift(item());
			break;
		case 4:
			if (document.items.length > 0) document.items.shift();
			break;
		case 5:
			if (document.items.length > 0) document.items.pop();
			break;
		case 6: {
			const index = document.items.length === 0 ? 0 : value % (document.items.length + 1);
			document.items.splice(index, document.items.length === 0 ? 0 : value % 2, item());
			break;
		}
		case 7:
			document.items.reverse();
			break;
		case 8:
			document.items.sort((left, right) => left.id - right.id);
			break;
		case 9:
			if (document.items.length > 0) document.items[value % document.items.length]!.score = value;
			break;
		case 10:
			document.meta.revision += 1;
			document.meta.label = `revision-${value}`;
			break;
		case 11:
			delete document.meta.label;
			break;
		case 12:
			if (document.items.length > 1) document.items[1] = clone(document.items[0]!);
			break;
		default:
			for (let index = 0; index < Math.min(2, document.items.length); index++) document.items[index] = item();
	}
};

it("converges across randomized transactional revisions", () => {
	for (let seed = 1; seed <= 100; seed++) {
		const rng = random(seed);
		const initial: Document = {
			items: Array.from({ length: 4 }, (_, id) => ({ id, text: `item-${id}`, score: 0 })),
			text: "start",
			meta: { revision: 0 },
		};
		const state = replicatedState(initial);
		const expected = clone(initial);
		let replica = clone(state.value);
		let latest: readonly Op[] = [];
		getReplicatedStateInternals(state)!.subscribe((operations) => {
			latest = operations;
		});
		for (let step = 0; step < 100; step++) {
			const choice = Math.floor(rng() * 14);
			const value = seed * 1_000 + step;
			mutate(expected, choice, value);
			latest = [];
			state.change(BACKGROUND_CONTEXT, (draft) => mutate(draft, choice, value));
			replica = applyImmutable(replica, latest);
			expect(state.value, `state seed ${seed} step ${step} choice ${choice}`).toEqual(expected);
			expect(replica, `replica seed ${seed} step ${step} choice ${choice}`).toEqual(expected);
			expect(Object.isFrozen(state.value)).toBe(true);
		}
	}
});
