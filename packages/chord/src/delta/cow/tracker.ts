import type { JsonValue } from "../../types.ts";
import type { Op } from "../index.ts";
import { applyImmutable } from "./apply-immutable.ts";
import { diffRevisions } from "./diff.ts";
import { cloneJson, createDraftTransaction, type Draft, type DraftTransaction, type ProduceMetadata } from "./draft.ts";

export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	abort(): void;
}

export interface Change<T extends object> {
	readonly state: Draft<T>;
	prepare(): Prepared<T>;
	abort(): void;
}

export interface Tracker<T extends object> {
	readonly value: T;
	readonly revision: number;
	beginChange(): Change<T>;
	prepareReplace(value: T): Prepared<T>;
	adopt(prepared: Prepared<T>): void;
}

type PreparedMetadata = {
	readonly owner: object;
	readonly revision: number;
	status: "prepared" | "consumed" | "aborted";
};

const PREPARED = new WeakMap<object, PreparedMetadata>();

class PreparedImpl<T extends object> implements Prepared<T> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];

	constructor(metadata: PreparedMetadata, base: T, value: T, ops: readonly Op[]) {
		this.base = base;
		this.value = value;
		this.ops = ops;
		PREPARED.set(this, metadata);
		Object.freeze(this);
	}

	abort(): void {
		const metadata = PREPARED.get(this)!;
		if (metadata.status === "prepared") metadata.status = "aborted";
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
			this.#preparedMetadata = PREPARED.get(prepared)!;
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
	readonly #owner = {};
	#value: T;
	#revision = 0;
	#changing = false;

	constructor(initial: T) {
		this.#value = initial;
	}

	get value(): T {
		return this.#value;
	}

	get revision(): number {
		return this.#revision;
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
			return this.#prepare({ value, hints: new WeakMap() }, true);
		} finally {
			this.#changing = false;
		}
	}

	adopt(prepared: Prepared<T>): void {
		const metadata = PREPARED.get(prepared as object);
		if (metadata?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (metadata.status === "consumed") throw new Error("Prepared change has already been used");
		if (metadata.status === "aborted") throw new Error("Prepared change has been aborted");
		if (this.#changing) throw new Error("Cannot adopt while a change is active");
		if (metadata.revision !== this.#revision || this.#value !== prepared.base)
			throw new Error("Prepared change is stale");
		metadata.status = "consumed";
		this.#value = prepared.value;
		this.#revision += 1;
	}

	prepareDraft(transaction: DraftTransaction<T>): PreparedImpl<T> {
		try {
			return this.#prepare(transaction.finish());
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

	#prepare(produced: ProduceMetadata<T>, replacement = false): PreparedImpl<T> {
		const base = this.#value;
		const operations = diffRevisions(
			base as unknown as JsonValue,
			produced.value as unknown as JsonValue,
			produced.hints,
		);
		if (operations.length === 0) {
			return new PreparedImpl({ owner: this.#owner, revision: this.#revision, status: "prepared" }, base, base, []);
		}
		// Trusted ownership rule: value and public ops are independent immutable
		// transfers. Draft revisions are reconstructed from a private detached batch:
		// differ payloads may reference retained base objects, so applying them directly
		// could introduce aliases. Replacements are already caller-transferred roots.
		// No freeze or validation runs.
		const value = replacement ? produced.value : applyImmutable(base, detachOperations(operations));
		return new PreparedImpl(
			{ owner: this.#owner, revision: this.#revision, status: "prepared" },
			base,
			value,
			detachOperations(operations),
		);
	}
}

/** Take O(1) ownership of an alias-free mutable strict-JSON root. */
export function track<T extends object>(initial: T): Tracker<T> {
	return new TrackerImpl(initial);
}

function detachOperations(operations: readonly Op[]): Op[] {
	return operations.map((operation): Op => {
		switch (operation[0]) {
			case "r":
				return ["r", cloneJson(operation[1])];
			case "s":
				return ["s", operation[1], cloneJson(operation[2])];
			case "p":
				return ["p", operation[1], operation[2], operation[3], operation[4].map((value) => cloneJson(value))];
			case "m":
				return ["m", operation[1], operation[2].slice()];
			case "d":
				return operation;
			case "a":
				return operation;
			case "t":
				return operation;
			default:
				throw new TypeError(`Unknown operation ${(operation as readonly [unknown])[0]}`);
		}
	});
}
