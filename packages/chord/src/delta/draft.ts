/** A mutable transaction-scoped view of a JSON value, preserving tuple positions. */
export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends null | boolean | number | string
		? T
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
				: T;

export type ProduceMetadata<T> = {
	value: T;
	owned: WeakSet<object>;
};

type Container = Record<string, unknown> | unknown[];

type DraftState = {
	base: Container;
	context: DraftContext;
	copy: Container | undefined;
	methods: Map<string, unknown> | undefined;
	proxy: object;
	target: unknown[] | undefined;
};

type DraftContext = {
	active: boolean;
	created: DraftState[];
	owned: WeakSet<object>;
	proxies: WeakMap<object, DraftState>;
	states: WeakMap<object, DraftState>;
};

const RELEASED_BASE: Container = Object.freeze({});
const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const MAX_NATIVE_ARRAY_INSERT_ITEMS = 10_000;

export type DraftTransaction<T extends object> = {
	readonly state: Draft<T>;
	finish(): ProduceMetadata<T>;
	abort(): void;
};

/** Create a revocable copy-on-write draft whose lifetime is controlled by its owner. */
export function createDraftTransaction<T extends object>(base: T): DraftTransaction<T> {
	const context: DraftContext = {
		active: true,
		created: [],
		owned: new WeakSet<object>(),
		proxies: new WeakMap<object, DraftState>(),
		states: new WeakMap<object, DraftState>(),
	};
	const root = getState(context, base as Container);
	const release = (): void => {
		assertActive(context);
		context.active = false;
		for (const state of context.created) {
			state.base = RELEASED_BASE;
			state.copy = undefined;
			state.methods = undefined;
			state.proxy = RELEASED_BASE;
			state.target = undefined;
		}
		context.created.length = 0;
		context.proxies = new WeakMap();
		context.states = new WeakMap();
	};
	return {
		state: root.proxy as Draft<T>,
		finish() {
			assertActive(context);
			try {
				return {
					value: finalize(root, new Set<DraftState>(), new WeakMap<DraftState, Container>()) as T,
					owned: context.owned,
				};
			} finally {
				release();
			}
		},
		abort: release,
	};
}

/** @internal Compatibility helper for the existing replicated-state service. */
export function produceWithMetadata<T extends object>(base: T, recipe: (draft: Draft<T>) => void): ProduceMetadata<T> {
	const transaction = createDraftTransaction(base);
	try {
		const outcome = (recipe as (draft: Draft<T>) => unknown)(transaction.state);
		if (isPromiseLike(outcome)) {
			void Promise.resolve(outcome).catch(() => undefined);
			throw new TypeError("Replicated state change callbacks must be synchronous");
		}
		return transaction.finish();
	} catch (error) {
		try {
			transaction.abort();
		} catch {
			// finish() already released the transaction before propagating an error.
		}
		throw error;
	}
}

/** @internal Compatibility helper for the existing replicated-state service. */
export function produce<T extends object>(base: T, recipe: (draft: Draft<T>) => void): T {
	return produceWithMetadata(base, recipe).value;
}

function getState(context: DraftContext, base: Container): DraftState {
	const existing = context.states.get(base);
	if (existing !== undefined) return existing;

	const target = Array.isArray(base) ? [] : undefined;
	if (target !== undefined) Reflect.set(target, "length", base.length);
	const state: DraftState = {
		base,
		context,
		copy: undefined,
		methods: undefined,
		proxy: target ?? {},
		target,
	};
	state.proxy = new Proxy(target ?? state, createHandler(state));
	context.states.set(base, state);
	context.proxies.set(state.proxy, state);
	context.created.push(state);
	return state;
}

type DraftHandler = ProxyHandler<object> & { state: DraftState };

const handlerPrototype: ProxyHandler<object> = {
	deleteProperty(this: DraftHandler, _target, property): boolean {
		const state = this.state;
		assertStringWrite(property);
		const current = currentValue(state);
		if (Array.isArray(current)) throw new TypeError("Draft arrays cannot contain holes");
		if (!Object.hasOwn(current, property)) return true;
		const deleted = Reflect.deleteProperty(ensureCopy(state), property);
		syncArrayTarget(state);
		return deleted;
	},
	defineProperty(this: DraftHandler): never {
		assertActive(this.state.context);
		throw new TypeError("Defining draft properties is not supported");
	},
	get(this: DraftHandler, _target, property): unknown {
		const state = this.state;
		const current = currentValue(state);
		const value = Reflect.get(current, property, state.proxy);
		if (Array.isArray(current) && typeof property === "string" && ARRAY_MUTATORS.has(property)) {
			return arrayMutator(state, property, value);
		}
		return draftValue(state.context, value);
	},
	getOwnPropertyDescriptor(this: DraftHandler, _target, property): PropertyDescriptor | undefined {
		const state = this.state;
		const current = currentValue(state);
		const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
		if (descriptor === undefined) return undefined;
		if (Array.isArray(current) && property === "length") {
			syncArrayTarget(state);
			return Reflect.getOwnPropertyDescriptor(state.target!, property);
		}
		return {
			configurable: true,
			enumerable: descriptor.enumerable,
			value: "value" in descriptor ? draftValue(state.context, descriptor.value) : undefined,
			writable: true,
		};
	},
	getPrototypeOf(this: DraftHandler): object | null {
		assertActive(this.state.context);
		return Object.getPrototypeOf(this.state.base);
	},
	has(this: DraftHandler, _target, property): boolean {
		return Reflect.has(currentValue(this.state), property);
	},
	isExtensible(this: DraftHandler): boolean {
		assertActive(this.state.context);
		return true;
	},
	ownKeys(this: DraftHandler): ArrayLike<string | symbol> {
		return Reflect.ownKeys(currentValue(this.state));
	},
	preventExtensions(this: DraftHandler): never {
		assertActive(this.state.context);
		throw new TypeError("Drafts cannot be made non-extensible");
	},
	set(this: DraftHandler, _target, property, value): boolean {
		const state = this.state;
		assertStringWrite(property);
		const current = currentValue(state);
		let stored: unknown;
		if (isContainer(value)) {
			stored = cloneAssigned(value, state.context, new Set<object>());
		} else {
			assertJsonPrimitive(value);
			stored = value;
		}
		if (Object.hasOwn(current, property) && Object.is(Reflect.get(current, property), stored)) return true;
		const copy = ensureCopy(state);
		if (Array.isArray(copy) && property === "length") {
			const written = Reflect.set(copy, property, stored);
			syncArrayTarget(state);
			return written;
		}
		Object.defineProperty(copy, property, {
			value: stored,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		syncArrayTarget(state);
		return true;
	},
	setPrototypeOf(this: DraftHandler): never {
		assertActive(this.state.context);
		throw new TypeError("Changing a draft prototype is not supported");
	},
};

function createHandler(state: DraftState): ProxyHandler<object> {
	const handler = Object.create(handlerPrototype) as DraftHandler;
	handler.state = state;
	return handler;
}

function arrayMutator(state: DraftState, property: string, value: unknown): unknown {
	assertActive(state.context);
	const cached = state.methods?.get(property);
	if (cached !== undefined) return cached;
	if (typeof value !== "function") return draftValue(state.context, value);
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		assertActive(state.context);
		const receiver = isContainer(this) ? state.context.proxies.get(this) : undefined;
		if (receiver === undefined) return Reflect.apply(value, this, args);
		const target = ensureCopy(receiver);
		if (!Array.isArray(target)) throw new TypeError("Array mutator receiver is not an array draft");
		try {
			return mutateArray(receiver, target, property, args);
		} finally {
			syncArrayTarget(receiver);
		}
	};
	if (state.methods === undefined) state.methods = new Map();
	state.methods.set(property, wrapped);
	return wrapped;
}

function mutateArray(state: DraftState, target: unknown[], property: string, args: unknown[]): unknown {
	const { context } = state;
	switch (property) {
		case "push": {
			const items = cloneArrayItems(args, context);
			for (const item of items) defineArrayValue(target, target.length, item);
			return target.length;
		}
		case "pop": {
			if (target.length === 0) return undefined;
			const index = target.length - 1;
			const removed = target[index];
			Reflect.deleteProperty(target, String(index));
			target.length = index;
			return draftValue(context, removed);
		}
		case "shift":
			return draftValue(context, Reflect.apply(Array.prototype.shift, target, []));
		case "unshift": {
			const items = cloneArrayItems(args, context);
			if (
				items.length <= MAX_NATIVE_ARRAY_INSERT_ITEMS &&
				!hasInheritedGrowthIndex(target, target.length + items.length)
			) {
				return Reflect.apply(Array.prototype.unshift, target, items);
			}
			spliceArray(target, items, 0, 0, context);
			return target.length;
		}
		case "splice": {
			const length = target.length;
			const start = args.length === 0 ? 0 : clampArrayIndex(toIntegerOrInfinity(args[0]), length);
			const remove =
				args.length === 0
					? 0
					: args.length === 1
						? length - start
						: Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), length - start);
			const items = cloneArrayItems(args.slice(2), context);
			if (
				items.length <= MAX_NATIVE_ARRAY_INSERT_ITEMS &&
				!mayRunCoercionCode(args[0]) &&
				!mayRunCoercionCode(args[1]) &&
				!hasInheritedGrowthIndex(target, length - remove + items.length)
			) {
				return Reflect.apply(Array.prototype.splice, target, [start, remove, ...items]).map((item) =>
					draftValue(context, item),
				);
			}
			return spliceArray(target, items, start, remove, context, length);
		}
		case "sort": {
			const comparator = args[0];
			if (comparator !== undefined && typeof comparator !== "function") {
				Reflect.apply(Array.prototype.sort, target, args);
			} else {
				Reflect.apply(Array.prototype.sort, target, [
					(left: unknown, right: unknown): number => {
						const draftedLeft = draftValue(context, left);
						const draftedRight = draftValue(context, right);
						if (typeof comparator === "function") {
							return Reflect.apply(comparator, undefined, [draftedLeft, draftedRight]) as number;
						}
						const leftString = String(draftedLeft);
						const rightString = String(draftedRight);
						return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
					},
				]);
			}
			return state.proxy;
		}
		case "reverse":
			Reflect.apply(Array.prototype.reverse, target, []);
			return state.proxy;
		case "fill": {
			const length = target.length;
			const start = args.length > 1 ? clampArrayIndex(toIntegerOrInfinity(args[1]), length) : 0;
			const end =
				args.length > 2 && args[2] !== undefined ? clampArrayIndex(toIntegerOrInfinity(args[2]), length) : length;
			if (end <= start) return state.proxy;
			const supplied = args[0];
			for (let index = start; index < end; index++) {
				const item = isContainer(supplied)
					? cloneAssigned(supplied, context, new Set<object>())
					: assertJsonPrimitive(supplied);
				defineArrayValue(target, index, item);
			}
			return state.proxy;
		}
		case "copyWithin": {
			const length = target.length;
			const to = clampArrayIndex(toIntegerOrInfinity(args[0]), length);
			const from = clampArrayIndex(toIntegerOrInfinity(args[1]), length);
			const end =
				args.length > 2 && args[2] !== undefined ? clampArrayIndex(toIntegerOrInfinity(args[2]), length) : length;
			const count = Math.min(Math.max(end - from, 0), length - to);
			const source = target.slice(from, from + count);
			for (let offset = 0; offset < count; offset++) {
				const item = source[offset];
				const itemState = isContainer(item) ? context.states.get(item) : undefined;
				const current = (itemState?.proxy as Container | undefined) ?? item;
				const copy = isContainer(current)
					? cloneAssigned(current, context, new Set<object>())
					: assertJsonPrimitive(current);
				defineArrayValue(target, to + offset, copy);
			}
			return state.proxy;
		}
	}
	throw new TypeError(`Unsupported array mutator: ${property}`);
}

function cloneArrayItems(items: readonly unknown[], context: DraftContext): unknown[] {
	return items.map((item) => {
		if (isContainer(item)) return cloneAssigned(item, context, new Set<object>());
		assertJsonPrimitive(item);
		return item;
	});
}

function hasInheritedGrowthIndex(target: unknown[], nextLength: number): boolean {
	for (let index = target.length; index < nextLength; index++) {
		if (index in target) return true;
	}
	return false;
}

function mayRunCoercionCode(value: unknown): boolean {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function spliceArray(
	target: unknown[],
	items: readonly unknown[],
	index: number,
	remove: number,
	context: DraftContext,
	length = target.length,
): unknown[] {
	const removed = new Array<unknown>(remove);
	for (let offset = 0; offset < remove; offset++) {
		const source = index + offset;
		if (!(source in target)) continue;
		defineArrayValue(removed, offset, draftValue(context, target[source]));
	}
	if (items.length < remove) {
		for (let source = index + remove; source < length; source++) {
			defineArrayValue(target, source - remove + items.length, target[source]);
		}
	} else if (items.length > remove) {
		for (let source = length - 1; source >= index + remove; source--) {
			defineArrayValue(target, source - remove + items.length, target[source]);
		}
	}
	for (let offset = 0; offset < items.length; offset++) defineArrayValue(target, index + offset, items[offset]);
	target.length = length - remove + items.length;
	return removed;
}

function defineArrayValue(target: unknown[], index: number, value: unknown): void {
	Object.defineProperty(target, index, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

function toIntegerOrInfinity(value: unknown): number {
	const number = +(value as unknown as number);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
}

function clampArrayIndex(value: number, length: number): number {
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return Math.max(length + value, 0);
	return Math.min(value, length);
}

function currentValue(state: DraftState): Container {
	assertActive(state.context);
	return state.copy ?? state.base;
}

function ensureCopy(state: DraftState): Container {
	if (state.copy !== undefined) return state.copy;
	if (state.context.owned.has(state.base)) {
		state.copy = state.base;
	} else {
		state.copy = shallowOwnedCopy(state.base, state.context);
	}
	return state.copy;
}

function shallowOwnedCopy(value: Container, context: DraftContext): Container {
	if (Array.isArray(value)) {
		const copy = value.slice();
		context.owned.add(copy);
		return copy;
	}
	const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		Object.defineProperty(copy, key, {
			value: value[key],
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	context.owned.add(copy);
	return copy;
}

function cloneAssigned(value: Container, context: DraftContext, ancestors: Set<object>): Container {
	if (ancestors.has(value)) throw new TypeError("Assigned JSON values cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			assertDenseArray(value);
			const clone: unknown[] = [];
			context.owned.add(clone);
			for (let index = 0; index < value.length; index++) {
				clone.push(cloneAssignedValue(Reflect.get(value, String(index)), context, ancestors));
			}
			return clone;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Assigned JSON containers must be plain objects or arrays");
		}
		const clone = Object.create(prototype) as Record<string, unknown>;
		context.owned.add(clone);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Assigned JSON objects cannot have symbol properties");
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Assigned JSON objects must contain enumerable data properties");
			}
			Object.defineProperty(clone, key, {
				value: cloneAssignedValue(descriptor.value, context, ancestors),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return clone;
	} finally {
		ancestors.delete(value);
	}
}

function cloneAssignedValue(value: unknown, context: DraftContext, ancestors: Set<object>): unknown {
	if (isContainer(value)) return cloneAssigned(value, context, ancestors);
	assertJsonPrimitive(value);
	return value;
}

function assertJsonPrimitive(value: unknown): null | boolean | number | string {
	if (value === undefined) throw new TypeError("Assigned values cannot be undefined");
	if (
		value !== null &&
		typeof value !== "string" &&
		typeof value !== "boolean" &&
		!(typeof value === "number" && Number.isFinite(value))
	) {
		throw new TypeError("Assigned values must be strict JSON values");
	}
	return value;
}

function draftValue(context: DraftContext, value: unknown): unknown {
	if (!isContainer(value)) return value;
	return getState(context, value).proxy;
}

function isContainer(value: unknown): value is Container {
	return typeof value === "object" && value !== null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function assertActive(context: DraftContext): void {
	if (!context.active) throw new TypeError("Cannot use a draft outside its change callback");
}

function assertStringWrite(property: string | symbol): asserts property is string {
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
}

function syncArrayTarget(state: DraftState): void {
	const current = currentValue(state);
	if (Array.isArray(current)) Reflect.set(state.target!, "length", current.length);
}

function finalize(
	state: DraftState,
	finalizing: Set<DraftState>,
	finalized: WeakMap<DraftState, Container>,
): Container {
	const cached = finalized.get(state);
	if (cached !== undefined) return cached;
	if (finalizing.has(state)) throw new TypeError("Cyclic draft state is not supported");
	finalizing.add(state);
	try {
		if (state.copy !== undefined && shallowEqual(state.base, state.copy)) state.copy = undefined;
		const current = currentValue(state);
		let result = current;
		for (const key of Object.keys(current)) {
			const value = Reflect.get(current, key);
			if (!isContainer(value)) continue;
			const child = state.context.states.get(value);
			if (child === undefined) continue;
			const finalizedChild = finalize(child, finalizing, finalized);
			if (finalizedChild === value) continue;
			if (result === state.base) result = shallowOwnedCopy(state.base, state.context);
			Object.defineProperty(result, key, {
				value: finalizedChild,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		if (state.copy !== undefined && Array.isArray(result)) assertDenseArray(result);
		finalized.set(state, result);
		return result;
	} finally {
		finalizing.delete(state);
	}
}

function shallowEqual(left: Container, right: Container): boolean {
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	for (const key of leftKeys) {
		if (!Object.hasOwn(right, key) || !Object.is(leftRecord[key], rightRecord[key])) return false;
	}
	return true;
}

function assertDenseArray(value: unknown[]): void {
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
		throw new TypeError("Draft arrays must be dense and contain only indexed entries");
	}
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			throw new TypeError("Draft arrays must contain enumerable indexed data properties with defined values");
		}
	}
}
