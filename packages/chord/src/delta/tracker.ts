import type { JsonValue } from "../types.ts";
import { diffRevisions } from "./diff.ts";
import { createDraftTransaction, type Draft, type DraftTransaction } from "./draft.ts";
import type { Op } from "./index.ts";
import { JsonRevisionStore } from "./value.ts";

export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
}

export interface Change<T extends object> {
	readonly state: Draft<T>;
	prepare(): Prepared<T>;
	abort(): void;
}

export interface Tracker<T extends object> {
	readonly value: T;
	beginChange(): Change<T>;
	prepareReplace(value: T): Prepared<T>;
	adopt(prepared: Prepared<T>): void;
}

type PreparedMetadata = {
	readonly owner: object;
	readonly revision: number;
	status: "prepared" | "consumed" | "aborted";
};

const preparedMetadata = new WeakMap<object, PreparedMetadata>();

class PreparedImpl<T extends object> implements Prepared<T> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];

	constructor(metadata: PreparedMetadata, base: T, value: T, ops: readonly Op[]) {
		this.base = base;
		this.value = value;
		this.ops = ops;
		preparedMetadata.set(this, metadata);
		Object.freeze(this);
	}
}

class ChangeImpl<T extends object> implements Change<T> {
	readonly state: Draft<T>;
	#tracker: TrackerImpl<T> | undefined;
	#transaction: DraftTransaction<T> | undefined;
	#preparedMetadata: PreparedMetadata | undefined;
	#status: "open" | "prepared" | "aborted" = "open";

	constructor(tracker: TrackerImpl<T>, transaction: DraftTransaction<T>) {
		this.#tracker = tracker;
		this.#transaction = transaction;
		this.state = transaction.state;
	}

	prepare(): Prepared<T> {
		if (this.#status !== "open") throw new Error("Change has already been settled");
		const tracker = this.#tracker!;
		const transaction = this.#transaction!;
		try {
			const prepared = tracker.prepareDraft(transaction);
			this.#preparedMetadata = preparedMetadata.get(prepared)!;
			this.#status = "prepared";
			return prepared;
		} catch (error) {
			this.#status = "aborted";
			throw error;
		} finally {
			this.#tracker = undefined;
			this.#transaction = undefined;
		}
	}

	abort(): void {
		if (this.#status === "aborted") return;
		if (this.#status === "prepared") {
			if (this.#preparedMetadata?.status === "prepared") this.#preparedMetadata.status = "aborted";
			this.#preparedMetadata = undefined;
			this.#status = "aborted";
			return;
		}
		this.#status = "aborted";
		const tracker = this.#tracker!;
		const transaction = this.#transaction!;
		this.#tracker = undefined;
		this.#transaction = undefined;
		try {
			transaction.abort();
		} finally {
			tracker.releaseChange();
		}
	}
}

class TrackerImpl<T extends object> implements Tracker<T> {
	readonly #store = new JsonRevisionStore();
	readonly #owner = {};
	#value: T;
	#revision = 0;
	#changing = false;

	constructor(initial: T) {
		this.#value = this.#store.import(initial);
	}

	get value(): T {
		return this.#value;
	}

	beginChange(): Change<T> {
		this.#reserveChange();
		try {
			return new ChangeImpl(this, createDraftTransaction(this.#value));
		} catch (error) {
			this.#changing = false;
			throw error;
		}
	}

	prepareReplace(value: T): Prepared<T> {
		this.#reserveChange();
		try {
			return this.#prepare(this.#store.import(value));
		} finally {
			this.#changing = false;
		}
	}

	adopt(prepared: Prepared<T>): void {
		const metadata = prepared instanceof PreparedImpl ? preparedMetadata.get(prepared) : undefined;
		if (metadata?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (metadata.status === "consumed") throw new Error("Prepared change has already been used");
		if (metadata.status === "aborted") throw new Error("Prepared change has been aborted");
		if (this.#changing) throw new Error("Cannot adopt while a change is active");
		if (metadata.revision !== this.#revision || this.#value !== prepared.base) {
			throw new Error("Prepared change is stale");
		}
		metadata.status = "consumed";
		this.#value = prepared.value;
		this.#revision += 1;
	}

	prepareDraft(transaction: DraftTransaction<T>): PreparedImpl<T> {
		try {
			const produced = transaction.finish();
			return this.#prepare(this.#store.commit(produced.value, produced.owned));
		} finally {
			this.#changing = false;
		}
	}

	releaseChange(): void {
		this.#changing = false;
	}

	#reserveChange(): void {
		if (this.#changing) throw new Error("Tracker already has an active change");
		this.#changing = true;
	}

	#prepare(candidate: T): PreparedImpl<T> {
		const base = this.#value;
		const operations = diffRevisions(base as unknown as JsonValue, candidate as unknown as JsonValue);
		const value = operations.length === 0 ? base : candidate;
		const ops = freezeOperations(operations);
		return new PreparedImpl({ owner: this.#owner, revision: this.#revision, status: "prepared" }, base, value, ops);
	}
}

/** Create a tracker around an imported immutable JSON revision. */
export function track<T extends object>(initial: T): Tracker<T> {
	return new TrackerImpl(initial);
}

function freezeOperations(operations: Op[]): readonly Op[] {
	for (const operation of operations) freezeMetadata(operation);
	return Object.freeze(operations);
}

function freezeMetadata(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeMetadata(child);
	Object.freeze(value);
}
