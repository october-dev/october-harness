import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { type Tracker, track } from "../../src/delta/cow/index.ts";

const retainedSettledObjects: object[] = [];
const retainedLargePrepared: object[] = [];
const retainedSettledChanges: object[] = [];

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

async function assertRetained(reference: WeakRef<object>): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	for (let attempt = 0; attempt < 5; attempt++) {
		await setImmediate();
		global.gc();
	}
	assert.notEqual(reference.deref(), undefined, "retained Prepared must retain its immutable revisions");
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
} else if (scenario === "retained-settled-prepared") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const retain = (): { base: WeakRef<object>; value: WeakRef<object> } => {
		const change = tracker.beginChange();
		change.state.payload.rows[0]!.value = -1;
		const prepared = change.prepare();
		const references = {
			base: new WeakRef(prepared.base.payload.rows),
			value: new WeakRef(prepared.value.payload.rows),
		};
		tracker.adopt(prepared);
		retainedLargePrepared.push(prepared);
		return references;
	};
	const references = retain();
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ payload: { rows: [{ value: 1 }] } });
		tracker.adopt(replacement);
	};
	replace();
	await assertRetained(references.base);
	await assertRetained(references.value);
	retainedLargePrepared.length = 0;
	await collect(references.base);
	await collect(references.value);
} else if (scenario === "retained-settled-change") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const settleChange = (): { base: WeakRef<object>; value: WeakRef<object> } => {
		const change = tracker.beginChange();
		change.state.payload.rows[0]!.value = -1;
		const prepared = change.prepare();
		const references = {
			base: new WeakRef(prepared.base.payload.rows),
			value: new WeakRef(prepared.value.payload.rows),
		};
		tracker.adopt(prepared);
		retainedSettledChanges.push(change);
		return references;
	};
	const references = settleChange();
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ payload: { rows: [{ value: 1 }] } });
		tracker.adopt(replacement);
	};
	replace();
	await collect(references.base);
	await collect(references.value);
	assert.equal(retainedSettledChanges.length, 1);
} else if (scenario === "lifecycle-churn") {
	const tracker = track({ value: 0 });
	for (let index = 0; index < 100_000; index++) {
		const change = tracker.beginChange();
		change.state.value = index;
		change.abort();
	}
	const prepared = tracker.prepareReplace({ value: 1 });
	tracker.adopt(prepared);
	assert.deepEqual(tracker.value, { value: 1 });
} else if (scenario === "obsolete-revisions") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const oldRoot = new WeakRef(tracker.value.payload.rows);
	const replace = (value: number): void => {
		const prepared = tracker.prepareReplace({ payload: { rows: [{ value }] } });
		tracker.adopt(prepared);
	};
	for (let value = 0; value < 100; value++) replace(value);
	await collect(oldRoot);
	assert.deepEqual(tracker.value, { payload: { rows: [{ value: 99 }] } });
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
