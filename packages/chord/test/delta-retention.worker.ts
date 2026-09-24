import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { type Tracker, track } from "../src/delta/index.ts";

const retainedSettledObjects: object[] = [];

async function collect(ref: WeakRef<object>): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	for (let attempt = 0; attempt < 30; attempt++) {
		await setImmediate();
		global.gc();
		if (ref.deref() === undefined) return;
	}
	assert.fail("released change data is still retained");
}

function abortedPayload(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const reference = new WeakRef(change.state.payload.rows);
	change.abort();
	return reference;
}

function unadoptedPrepared(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const prepared = change.prepare();
	return new WeakRef(prepared.value.payload!.rows);
}

function draftProxies(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: [{ value: 1 }] };
	const reference = new WeakRef(change.state.payload.rows[0]!);
	change.abort();
	return reference;
}

function settledLifecycle(): { tracker: WeakRef<object>; future: WeakRef<object> } {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const change = tracker.beginChange();
	change.state.payload = { rows: [{ value: 1 }] };
	const retainedPrepared = change.prepare();
	tracker.adopt(retainedPrepared);
	retainedSettledObjects.push(change, retainedPrepared);

	const futurePrepared = tracker.prepareReplace({
		payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) },
	});
	tracker.adopt(futurePrepared);
	return {
		tracker: new WeakRef(tracker),
		future: new WeakRef(futurePrepared.value.payload!.rows),
	};
}

const scenario = process.argv[2];
if (scenario === "settled-lifecycle") {
	const references = settledLifecycle();
	await collect(references.tracker);
	await collect(references.future);
} else {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	let reference: WeakRef<object>;
	switch (scenario) {
		case "aborted-payload":
			reference = abortedPayload(tracker);
			break;
		case "unadopted-prepared":
			reference = unadoptedPrepared(tracker);
			break;
		case "draft-proxies":
			reference = draftProxies(tracker);
			break;
		default:
			throw new Error(`unknown retention scenario: ${scenario}`);
	}
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: null });
}
console.log(JSON.stringify({ scenario, passed: true }));
