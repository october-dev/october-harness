import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { applyImmutable, isBase, type Op } from "../delta/index.ts";
import { diffRevisions } from "../state/diff.ts";
import { produceWithMetadata } from "../state/draft.ts";
import { JsonRevisionStore } from "../state/value.ts";
import type { Context, JsonValue, MutableReplicatedState, ReplicatedState, ReplicatedStateDelivery } from "../types.ts";
import { registerReplicatedStateInternals } from "./state-internals.ts";

type Publication<T> = {
	value: T;
	ops: readonly Op[];
	sequence: number;
	context: Context;
};

export class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	readonly #listeners = new Map<(value: T, context: Context, delivery: ReplicatedStateDelivery) => void, number>();
	readonly #sourceListeners = new Set<(ops: readonly Op[], sequence: number, context: Context) => void>();
	readonly #store = new JsonRevisionStore();
	readonly #publications: Publication<T>[] = [];
	#value: T;
	#sequence = 0;
	#changing = false;
	#delivering = false;

	constructor(initial: T) {
		this.#value = this.#store.import(initial);
		const thisSource = this;
		registerReplicatedStateInternals(this, {
			get sequence() {
				return thisSource.#sequence;
			},
			get value() {
				return thisSource.#value;
			},
			subscribe: (listener) => {
				thisSource.#sourceListeners.add(listener);
				return () => thisSource.#sourceListeners.delete(listener);
			},
		});
	}

	get value(): T {
		return this.#value;
	}

	change(context: Context, mutate: Parameters<MutableReplicatedState<T>["change"]>[1]): void {
		if (this.#changing) throw new Error("Replicated state cannot be changed reentrantly from a change callback");
		this.#changing = true;
		let next: T;
		try {
			const produced = produceWithMetadata(this.#value, mutate);
			if (produced.value === this.#value) return;
			next = this.#store.commit(produced.value, produced.owned);
		} finally {
			this.#changing = false;
		}
		this.#commit(next, context);
	}

	replace(context: Context, value: T): void {
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		this.#commit(this.#store.import(value), context);
	}

	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void {
		const sequence = this.#sequence;
		const value = this.#value;
		this.#listeners.set(listener, sequence);
		try {
			listener(value, serviceDeliveryContext(), { kind: "hydrate", sequence });
		} catch (error) {
			this.#listeners.delete(listener);
			throw error;
		}
		return () => this.#listeners.delete(listener);
	}

	#commit(next: T, context: Context): void {
		const ops = diffRevisions(this.#value as unknown as JsonValue, next as unknown as JsonValue);
		if (ops.length === 0) return;
		this.#value = next;
		this.#sequence += 1;
		this.#publications.push({ value: next, ops, sequence: this.#sequence, context });
		if (this.#delivering) return;
		this.#delivering = true;
		const errors: unknown[] = [];
		try {
			for (
				let publication = this.#publications.shift();
				publication !== undefined;
				publication = this.#publications.shift()
			) {
				for (const listener of [...this.#sourceListeners]) {
					try {
						listener(publication.ops, publication.sequence, publication.context);
					} catch (error) {
						errors.push(error);
					}
				}
				const delivery = { kind: "update", sequence: publication.sequence } as const;
				for (const [listener, hydratedSequence] of [...this.#listeners]) {
					if (publication.sequence <= hydratedSequence) continue;
					try {
						listener(publication.value, publication.context, delivery);
					} catch (error) {
						errors.push(error);
					}
				}
			}
		} finally {
			this.#delivering = false;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Replicated state listeners failed");
	}
}

/** A cold read-only state used by service consumers until a complete snapshot arrives. */
export class ReplicatedStateReplica<T extends JsonValue = JsonValue> implements ReplicatedState<T> {
	readonly #listeners = new Set<(value: T, context: Context, delivery: ReplicatedStateDelivery) => void>();
	readonly #reportError: (error: Error) => void;
	readonly #store = new JsonRevisionStore();
	#value: T | undefined;
	#sequence: number | undefined;

	constructor(reportError: (error: Error) => void) {
		this.#reportError = reportError;
	}

	get value(): T | undefined {
		return this.#value;
	}

	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void {
		this.#listeners.add(listener);
		if (this.#value !== undefined) {
			this.#deliver(listener, this.#value, serviceDeliveryContext(), {
				kind: "hydrate",
				sequence: this.#sequence!,
			});
		}
		return () => this.#listeners.delete(listener);
	}

	hydrate(sequence: number, ops: readonly Op[], context: Context): void {
		let next: T;
		try {
			if (!isBase(ops)) throw new Error("Replicated state snapshot is not a base operation batch");
			next = this.#store.adopt(applyImmutable<T>(undefined, ops));
		} catch (error) {
			this.clear();
			throw error;
		}
		this.#sequence = sequence;
		this.#value = next;
		this.#deliverAll(context, { kind: "hydrate", sequence });
	}

	update(sequence: number, ops: readonly Op[], context: Context): void {
		if (this.#sequence === undefined || this.#value === undefined) {
			throw new Error("Replicated state received an update before hydration");
		}
		if (sequence !== this.#sequence + 1) {
			this.clear();
			throw new Error("Replicated state update sequence has a gap");
		}
		let next: T;
		try {
			next = this.#store.adopt(applyImmutable(this.#value, ops));
		} catch (error) {
			this.clear();
			throw error;
		}
		this.#sequence = sequence;
		this.#value = next;
		this.#deliverAll(context, { kind: "update", sequence });
	}

	clear(): void {
		this.#value = undefined;
		this.#sequence = undefined;
	}

	#deliverAll(context: Context, delivery: ReplicatedStateDelivery): void {
		if (this.#value === undefined) return;
		for (const listener of this.#listeners) this.#deliver(listener, this.#value, context, delivery);
	}

	#deliver(
		listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void,
		value: T,
		context: Context,
		delivery: ReplicatedStateDelivery,
	): void {
		try {
			listener(value, context, delivery);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

/** @internal Context for synthetic service deliveries without a caller. */
export function serviceDeliveryContext(): Context {
	// TODO: Add delivery-scoped cancellation or metadata if deliveries gain an owned lifecycle.
	return BACKGROUND_CONTEXT;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
