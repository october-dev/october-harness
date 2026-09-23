import type { JsonValue } from "../types.ts";

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

const isContainer = (value: unknown): value is JsonContainer => typeof value === "object" && value !== null;

/** Owns and freezes immutable JSON revisions while reusing already-owned subtrees. */
export class JsonRevisionStore {
	readonly #owned = new WeakSet<object>();

	import<T extends object>(value: T): T {
		return this.#clone(value, new Set<object>()) as T;
	}

	commit<T extends object>(value: T, transactionOwned: WeakSet<object>): T {
		return this.#finish(value as JsonContainer, transactionOwned, new Set<object>(), new WeakSet<object>()) as T;
	}

	adopt<T extends JsonValue>(value: T): T {
		return this.#adopt(value, new Set<object>(), new WeakSet<object>()) as T;
	}

	#clone(value: unknown, ancestors: Set<object>): JsonValue {
		if (!isContainer(value)) return assertPrimitive(value);
		if (ancestors.has(value)) throw new TypeError("Replicated state cannot contain cycles");
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				assertDenseArray(value);
				const result = new Array<JsonValue>(value.length);
				for (let index = 0; index < value.length; index++) {
					Object.defineProperty(result, index, {
						value: this.#clone(value[index], ancestors),
						writable: true,
						enumerable: true,
						configurable: true,
					});
				}
				this.#owned.add(result);
				return Object.freeze(result) as unknown as JsonValue;
			}
			assertPlainObject(value);
			const result = Object.create(Object.getPrototypeOf(value)) as Record<string, JsonValue>;
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key === "symbol") throw new TypeError("Replicated state cannot contain symbol properties");
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Replicated state objects must contain enumerable data properties");
				}
				Object.defineProperty(result, key, {
					value: this.#clone(descriptor.value, ancestors),
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
			this.#owned.add(result);
			return Object.freeze(result) as unknown as JsonValue;
		} finally {
			ancestors.delete(value);
		}
	}

	#adopt(value: JsonValue, ancestors: Set<object>, finished: WeakSet<object>): JsonValue {
		if (!isContainer(value) || this.#owned.has(value)) return isContainer(value) ? value : assertPrimitive(value);
		if (finished.has(value)) return value;
		if (ancestors.has(value)) throw new TypeError("Replicated state cannot contain cycles");
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				assertDenseArray(value);
				for (let index = 0; index < value.length; index++) {
					const child = this.#adopt(value[index]!, ancestors, finished);
					if (child !== value[index]) defineValue(value, String(index), child as JsonContainer);
				}
			} else {
				assertPlainObject(value);
				for (const key of Reflect.ownKeys(value)) {
					if (typeof key === "symbol") throw new TypeError("Replicated state cannot contain symbol properties");
					const descriptor = Object.getOwnPropertyDescriptor(value, key);
					if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
						throw new TypeError("Replicated state objects must contain enumerable data properties");
					}
					const child = this.#adopt(descriptor.value as JsonValue, ancestors, finished);
					if (child !== descriptor.value && isContainer(child)) defineValue(value, key, child);
				}
			}
			finished.add(value);
			this.#owned.add(value);
			return Object.freeze(value) as unknown as JsonValue;
		} finally {
			ancestors.delete(value);
		}
	}

	#finish(
		value: JsonContainer,
		transactionOwned: WeakSet<object>,
		ancestors: Set<object>,
		placements: WeakSet<object>,
	): JsonContainer {
		if (ancestors.has(value)) throw new TypeError("Replicated state cannot contain cycles");
		if (placements.has(value)) return this.#clone(value, new Set<object>()) as JsonContainer;
		placements.add(value);
		if (this.#owned.has(value)) return value;
		if (!transactionOwned.has(value)) return this.#clone(value, ancestors) as JsonContainer;
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				assertDenseArray(value);
				for (let index = 0; index < value.length; index++) {
					const child = value[index];
					if (!isContainer(child)) {
						assertPrimitive(child);
						continue;
					}
					const next = this.#finish(child, transactionOwned, ancestors, placements);
					if (next !== child) defineValue(value, String(index), next);
				}
			} else {
				assertPlainObject(value);
				for (const key of Reflect.ownKeys(value)) {
					if (typeof key === "symbol") throw new TypeError("Replicated state cannot contain symbol properties");
					const descriptor = Object.getOwnPropertyDescriptor(value, key);
					if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
						throw new TypeError("Replicated state objects must contain enumerable data properties");
					}
					if (!isContainer(descriptor.value)) {
						assertPrimitive(descriptor.value);
						continue;
					}
					const next = this.#finish(descriptor.value, transactionOwned, ancestors, placements);
					if (next !== descriptor.value) defineValue(value, key, next);
				}
			}
			this.#owned.add(value);
			return Object.freeze(value) as unknown as JsonContainer;
		} finally {
			ancestors.delete(value);
		}
	}
}

function defineValue(target: object, key: string, value: JsonContainer): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function assertPrimitive(value: unknown): null | boolean | number | string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new TypeError("Replicated state values must be strict JSON");
}

function assertPlainObject(value: object): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Replicated state containers must be plain objects or arrays");
	}
}

function assertDenseArray(value: readonly unknown[]): void {
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
		throw new TypeError("Replicated state arrays must be dense and contain only indexed entries");
	}
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			throw new TypeError(
				"Replicated state arrays must contain enumerable indexed data properties with defined values",
			);
		}
	}
}
