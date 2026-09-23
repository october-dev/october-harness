import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { track } from "../../src/delta/astra/index.ts";

async function collect(reference: WeakRef<object>): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	for (let attempt = 0; attempt < 40; attempt++) {
		await setImmediate();
		global.gc();
		if (reference.deref() === undefined) return;
	}
	assert.fail("overlay data is still retained");
}

const retainedRevoked: object[] = [];
const retainedSettledChanges: object[] = [];
const retainedStaleChanges: object[] = [];
const scenario = process.argv[2];
if (scenario === "aborted") {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const reference = new WeakRef(change.state.payload.rows);
	change.abort();
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: null });
} else if (scenario === "dropped-prepared") {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const makeReference = (): WeakRef<object> => {
		const change = tracker.beginChange();
		change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
		const prepared = change.prepare();
		return new WeakRef(prepared.value.payload!.rows);
	};
	const reference = makeReference();
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: null });
} else if (scenario === "settled-change") {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const makeReference = (): WeakRef<object> => {
		const change = tracker.beginChange();
		change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
		const prepared = change.prepare();
		const reference = new WeakRef(prepared.value.payload!.rows);
		retainedSettledChanges.push(change);
		return reference;
	};
	const reference = makeReference();
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: null });
} else if (scenario === "stale-unprepared") {
	const setup = (): {
		tracker: ReturnType<typeof track<{ payload: { rows: { value: number }[] } }>>;
		reference: WeakRef<object>;
	} => {
		const initial = { payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } };
		const tracker = track(initial);
		const reference = new WeakRef(initial.payload.rows);
		retainedStaleChanges.push(tracker.beginChange());
		const winner = tracker.prepareReplace({ payload: { rows: [{ value: -1 }] } });
		tracker.adopt(winner);
		return { tracker, reference };
	};
	const { tracker, reference } = setup();
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: { rows: [{ value: -1 }] } });
	assert.throws(() => (retainedStaleChanges[0] as { state: { payload: unknown } }).state.payload, TypeError);
} else if (scenario === "stale-held") {
	const tracker = track({ child: { value: 0 } });
	let prepared = (() => {
		const change = tracker.beginChange();
		change.state.child.value = 1;
		return change.prepare();
	})();
	const held = prepared.value;
	const wrapper = new WeakRef(prepared);
	prepared = undefined as never;
	await collect(wrapper);
	const winner = tracker.prepareReplace({ child: { value: 2 } });
	tracker.adopt(winner);
	assert.throws(() => held.child.value, TypeError);
} else if (scenario === "held-revoked") {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const held = change.state.payload;
	const child = new WeakRef(change.state.payload.rows);
	retainedRevoked.push(held);
	change.abort();
	await collect(child);
	assert.throws(() => held.rows, TypeError);
} else if (scenario === "registry-churn") {
	const tracker = track({ value: 0 });
	for (let index = 0; index < 100_000; index++) {
		const change = tracker.beginChange();
		change.state.value = index;
		change.abort();
	}
	const winner = tracker.prepareReplace({ value: 1 });
	tracker.adopt(winner);
	assert.deepEqual(tracker.value, { value: 1 });
} else {
	throw new Error(`unknown scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, passed: true }));
