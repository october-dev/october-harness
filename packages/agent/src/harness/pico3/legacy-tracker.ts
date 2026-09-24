import {
	type Change,
	type Tracker as ChordTracker,
	type JsonValue,
	type Op,
	type Prepared,
	track as trackChord,
} from "@earendil-works/chord/delta";

/** Temporary compatibility surface for Pico3's flush-based document handling. */
export interface Tracker<T extends object> {
	readonly state: T;
	readonly target: T;
	readonly dirty: boolean;
	flush(): Op[];
	rebase(): void;
}

class LegacyTracker<T extends object> implements Tracker<T> {
	private readonly tracker: ChordTracker<T>;
	private change: Change<T> | undefined;
	private wrappers = new WeakMap<object, object>();
	private forceBase = true;

	constructor(initial: T) {
		this.tracker = trackChord(initial);
	}

	get state(): T {
		this.change ??= this.tracker.beginChange();
		return this.wrap(this.change.state as T);
	}

	get target(): T {
		return this.tracker.value;
	}

	get dirty(): boolean {
		return this.forceBase || this.change !== undefined;
	}

	flush(): Op[] {
		let prepared: Prepared<T> | undefined;
		if (this.change !== undefined) {
			const change = this.change;
			this.change = undefined;
			this.wrappers = new WeakMap();
			prepared = change.prepare();
			// Pico3 adopts before storage. A storage failure faults the owning Session.
			this.tracker.adopt(prepared);
		}
		if (this.forceBase) {
			this.forceBase = false;
			return [["r", this.tracker.value as unknown as JsonValue]];
		}
		return (prepared?.ops ?? []) as Op[];
	}

	rebase(): void {
		this.forceBase = true;
	}

	private wrap<V extends object>(draft: V): V {
		const cached = this.wrappers.get(draft);
		if (cached !== undefined) return cached as V;
		const tracker = this;
		const proxy = new Proxy(draft, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver);
				if (typeof value === "function") {
					return (...args: unknown[]) => {
						const result = Reflect.apply(value, target, args);
						return typeof result === "object" && result !== null ? tracker.wrap(result) : result;
					};
				}
				return typeof value === "object" && value !== null ? tracker.wrap(value) : value;
			},
			set(target, key, value, receiver) {
				if (value === undefined && !Array.isArray(target)) return Reflect.deleteProperty(target, key);
				return Reflect.set(target, key, value, receiver);
			},
		});
		this.wrappers.set(draft, proxy);
		return proxy;
	}
}

export function track<T extends object>(initial: T): Tracker<T> {
	return new LegacyTracker(initial);
}
