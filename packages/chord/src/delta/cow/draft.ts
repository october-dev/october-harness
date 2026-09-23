import type { JsonValue } from "../../types.ts";

/** Mutable transaction-scoped view of a JSON value, preserving tuple positions. */
export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends null | boolean | number | string
		? T
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
				: T;

type Container = Record<string, unknown> | unknown[];
type ChildKey = string | number;

export type ArrayDiffHint = {
	readonly base: JsonValue[];
	readonly keys: readonly number[];
};

export type DiffHints = WeakMap<object, ArrayDiffHint>;

export type ProduceMetadata<T> = {
	value: T;
	hints: DiffHints;
};

type DraftContext = {
	active: boolean;
	states: WeakMap<object, DraftState>;
	created: DraftState[];
	hints: DiffHints;
};

type ChildIndex = DraftState | Map<ChildKey, DraftState>;
type ChangedIndex = number | Set<number>;

class DraftState {
	context: DraftContext;
	base: Container;
	copy: Container | undefined;
	parent: DraftState | undefined;
	key: ChildKey | undefined;
	proxy: object;
	target: object;
	dirty = false;
	structural = false;
	children: ChildIndex | undefined;
	changedIndices: ChangedIndex | undefined;
	finalized: Container | undefined;

	constructor(context: DraftContext, base: Container, parent: DraftState | undefined, key: ChildKey | undefined) {
		this.context = context;
		this.base = base;
		this.copy = undefined;
		this.parent = parent;
		this.key = key;
		this.proxy = this;
		this.target = this;
		this.children = undefined;
		this.changedIndices = undefined;
		this.finalized = undefined;
	}
}

const DRAFT_STATE = Symbol("cow draft state");
const RELEASED: Record<string, never> = {};
const MAX_NATIVE_ARRAY_INSERT_ITEMS = 10_000;
const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

export type DraftTransaction<T extends object> = {
	readonly state: Draft<T>;
	finish(): ProduceMetadata<T>;
	abort(): void;
};

export function createDraftTransaction<T extends object>(base: T): DraftTransaction<T> {
	const context: DraftContext = {
		active: true,
		states: new WeakMap(),
		created: [],
		hints: new WeakMap(),
	};
	const root = stateFor(context, base as Container, undefined, undefined);
	const release = (): void => {
		assertActive(context);
		context.active = false;
		for (const state of context.created) {
			state.base = RELEASED;
			state.copy = undefined;
			state.parent = undefined;
			state.key = undefined;
			state.proxy = RELEASED;
			state.target = RELEASED;
			state.children = undefined;
			state.changedIndices = undefined;
			state.finalized = undefined;
		}
		context.created.length = 0;
		context.states = new WeakMap();
	};
	return {
		state: root.proxy as Draft<T>,
		finish() {
			assertActive(context);
			try {
				return { value: finalize(root) as T, hints: context.hints };
			} finally {
				release();
			}
		},
		abort: release,
	};
}

/** Compatibility helper for synchronous COW recipes. */
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
			// finish() already released the transaction.
		}
		throw error;
	}
}

export function produce<T extends object>(base: T, recipe: (draft: Draft<T>) => void): T {
	return produceWithMetadata(base, recipe).value;
}

function stateFor(
	context: DraftContext,
	base: Container,
	parent: DraftState | undefined,
	key: ChildKey | undefined,
): DraftState {
	const existing = context.states.get(base);
	if (existing !== undefined) return existing;
	const state = new DraftState(context, base, parent, key);
	const target: object = Array.isArray(base) ? [] : state;
	if (Array.isArray(base)) {
		(target as unknown[]).length = base.length;
		Object.defineProperty(target, DRAFT_STATE, { value: state, configurable: true });
	}
	state.target = target;
	state.proxy = new Proxy(target, SHARED_HANDLER);
	context.states.set(base, state);
	context.created.push(state);
	return state;
}

const SHARED_HANDLER: ProxyHandler<object> = {
	deleteProperty(target, property): boolean {
		const state = targetState(target);
		assertWritable(state, property);
		if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
		if (Array.isArray(state.base)) throw new TypeError("Draft arrays cannot contain holes");
		return deleteObjectProperty(state, property);
	},
	defineProperty(target): never {
		assertActive(targetState(target).context);
		throw new TypeError("Defining draft properties is not supported");
	},
	get(target, property): unknown {
		const state = targetState(target);
		assertActive(state.context);
		if (property === DRAFT_STATE) return state;
		if (Array.isArray(state.base) && typeof property === "string" && ARRAY_MUTATORS.has(property)) {
			return MUTATORS[property as keyof typeof MUTATORS];
		}
		const value = Reflect.get(currentValue(state), property, state.proxy);
		return draftValue(state.context, value, state, childKey(property));
	},
	getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
		const state = targetState(target);
		assertActive(state.context);
		const descriptor = Reflect.getOwnPropertyDescriptor(currentValue(state), property);
		if (descriptor === undefined) return undefined;
		if (Array.isArray(state.base) && property === "length") {
			syncArrayTarget(state);
			return Reflect.getOwnPropertyDescriptor(state.target, property);
		}
		return {
			configurable: true,
			enumerable: descriptor.enumerable,
			writable: true,
			value:
				"value" in descriptor ? draftValue(state.context, descriptor.value, state, childKey(property)) : undefined,
		};
	},
	getPrototypeOf(target): object | null {
		const state = targetState(target);
		assertActive(state.context);
		return Object.getPrototypeOf(state.base);
	},
	has(target, property): boolean {
		const state = targetState(target);
		assertActive(state.context);
		return Reflect.has(currentValue(state), property);
	},
	isExtensible(target): boolean {
		assertActive(targetState(target).context);
		return true;
	},
	ownKeys(target): ArrayLike<string | symbol> {
		const state = targetState(target);
		assertActive(state.context);
		return Reflect.ownKeys(currentValue(state));
	},
	preventExtensions(target): never {
		assertActive(targetState(target).context);
		throw new TypeError("Drafts cannot be made non-extensible");
	},
	set(target, property, value): boolean {
		const state = targetState(target);
		assertWritable(state, property);
		return writeProperty(state, property, value);
	},
	setPrototypeOf(target): never {
		assertActive(targetState(target).context);
		throw new TypeError("Changing a draft prototype is not supported");
	},
};

function targetState(target: object): DraftState {
	return Array.isArray(target)
		? (target as unknown as Record<symbol, DraftState>)[DRAFT_STATE]!
		: (target as DraftState);
}

function childKey(property: PropertyKey): ChildKey | undefined {
	if (typeof property === "symbol") return undefined;
	const index = arrayIndex(property);
	return index ?? property;
}

function draftState(value: unknown): DraftState | undefined {
	if (!isContainer(value)) return undefined;
	return (value as Record<symbol, DraftState | undefined>)[DRAFT_STATE];
}

function draftValue(context: DraftContext, value: unknown, parent?: DraftState, key?: ChildKey): unknown {
	if (!isContainer(value)) return value;
	const existingDraft = draftState(value);
	if (existingDraft !== undefined) return value;
	return stateFor(context, value, parent, key).proxy;
}

function currentValue(state: DraftState): Container {
	assertActive(state.context);
	return state.copy ?? state.base;
}

function ensureCopy(state: DraftState): Container {
	markChanged(state);
	if (state.copy !== undefined) return state.copy;
	state.copy = shallowCopy(state.base);
	return state.copy;
}

function shallowCopy(value: Container): Container {
	if (Array.isArray(value)) return Array.from(value);
	if (Object.getPrototypeOf(value) === null)
		return Object.assign(Object.create(null) as Record<string, unknown>, value);
	return { ...value };
}

function markChanged(state: DraftState): void {
	let current: DraftState | undefined = state;
	while (current !== undefined && !current.dirty) {
		current.dirty = true;
		const parent: DraftState | undefined = current.parent;
		if (parent !== undefined && current.key !== undefined) registerChild(parent, current.key, current);
		current = parent;
	}
}

function registerChild(parent: DraftState, key: ChildKey, child: DraftState): void {
	const children = parent.children;
	if (children === undefined) parent.children = child;
	else if (children instanceof Map) children.set(key, child);
	else if (children !== child)
		parent.children = new Map([
			[children.key!, children],
			[key, child],
		]);
	if (Array.isArray(parent.base) && typeof key === "number") markArrayIndex(parent, key);
}

function markArrayIndex(state: DraftState, index: number): void {
	const changed = state.changedIndices;
	if (changed === undefined) state.changedIndices = index;
	else if (changed instanceof Set) changed.add(index);
	else if (changed !== index) state.changedIndices = new Set([changed, index]);
}

function writeProperty(state: DraftState, property: string | symbol, supplied: unknown): boolean {
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(state.base)) {
		if (property === "length") return writeArrayLength(state, supplied);
		const index = arrayIndex(property);
		if (index === undefined) throw new TypeError("Only array indices and length can be written");
		const current = currentValue(state) as unknown[];
		if (index > current.length) throw new TypeError("Draft arrays cannot contain holes");
		const stored = clonePlacement(supplied, state.context);
		if (index < current.length && Object.is(current[index], stored)) return true;
		if (index < current.length) detachCurrentChild(state, current[index]);
		const copy = ensureCopy(state) as unknown[];
		defineData(copy, String(index), stored);
		if (index === current.length) state.structural = true;
		else markArrayIndex(state, index);
		syncArrayTarget(state);
		return true;
	}
	if (supplied === undefined) return deleteObjectProperty(state, property);
	const stored = clonePlacement(supplied, state.context);
	const current = currentValue(state) as Record<string, unknown>;
	if (Object.hasOwn(current, property) && !isContainer(stored) && Object.is(current[property], stored)) return true;
	if (Object.hasOwn(current, property)) detachCurrentChild(state, current[property]);
	const copy = ensureCopy(state) as Record<string, unknown>;
	defineData(copy, property, stored);
	return true;
}

function writeArrayLength(state: DraftState, supplied: unknown): boolean {
	const probe: unknown[] = [];
	Reflect.set(probe, "length", supplied);
	const next = probe.length;
	const current = (currentValue(state) as unknown[]).length;
	if (next === current) return true;
	const copy = ensureCopy(state) as unknown[];
	if (next < current) copy.length = next;
	else {
		copy.length = next;
		for (let index = current; index < next; index++) copy[index] = null;
	}
	state.structural = true;
	syncArrayTarget(state);
	return true;
}

function deleteObjectProperty(state: DraftState, property: string): boolean {
	const current = currentValue(state);
	if (!Object.hasOwn(current, property)) return true;
	detachCurrentChild(state, (current as Record<string, unknown>)[property]);
	Reflect.deleteProperty(ensureCopy(state), property);
	return true;
}

function detachCurrentChild(parent: DraftState, value: unknown): void {
	if (!isContainer(value)) return;
	const child = draftState(value) ?? parent.context.states.get(value);
	if (child?.parent !== parent) return;
	const children = parent.children;
	if (children === child) parent.children = undefined;
	else if (children instanceof Map && child.key !== undefined && children.get(child.key) === child) {
		children.delete(child.key);
	}
	child.parent = undefined;
	child.key = undefined;
}

function arrayIndex(property: PropertyKey): number | undefined {
	if (typeof property !== "string" || property === "") return undefined;
	const index = Number(property);
	if (!Number.isInteger(index) || index < 0 || index >= 4_294_967_295 || String(index) !== property) return undefined;
	return index;
}

function mutatorState(receiver: unknown): DraftState | undefined {
	if (!isContainer(receiver)) return undefined;
	return draftState(receiver);
}

const MUTATORS = {
	push(this: unknown, ...args: unknown[]): number {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.push, this, args) as number;
		assertActive(state.context);
		if (args.length === 0) return (currentValue(state) as unknown[]).length;
		const target = ensureCopy(state) as unknown[];
		for (const item of cloneItems(args, state.context)) defineData(target, String(target.length), item);
		state.structural = true;
		syncArrayTarget(state);
		return target.length;
	},
	pop(this: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.pop, this, []);
		assertActive(state.context);
		const current = currentValue(state) as unknown[];
		if (current.length === 0) return undefined;
		const target = ensureCopy(state) as unknown[];
		const value = target[target.length - 1];
		target.length -= 1;
		state.structural = true;
		syncArrayTarget(state);
		return draftValue(state.context, value, state, target.length);
	},
	shift(this: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.shift, this, []);
		assertActive(state.context);
		const current = currentValue(state) as unknown[];
		if (current.length === 0) return undefined;
		const target = ensureCopy(state) as unknown[];
		const value = Reflect.apply(Array.prototype.shift, target, []);
		state.structural = true;
		syncArrayTarget(state);
		return draftValue(state.context, value, state, 0);
	},
	unshift(this: unknown, ...args: unknown[]): number {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.unshift, this, args) as number;
		assertActive(state.context);
		if (args.length === 0) return (currentValue(state) as unknown[]).length;
		const target = ensureCopy(state) as unknown[];
		const items = cloneItems(args, state.context);
		insertChunked(target, 0, items);
		state.structural = true;
		syncArrayTarget(state);
		return target.length;
	},
	splice(this: unknown, ...args: unknown[]): unknown[] {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.splice, this, args) as unknown[];
		assertActive(state.context);
		const length = (currentValue(state) as unknown[]).length;
		const start = args.length === 0 ? 0 : clampIndex(toIntegerOrInfinity(args[0]), length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - start
					: Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), length - start);
		const inputs = cloneItems(args.slice(2), state.context);
		if (remove === 0 && inputs.length === 0) return [];
		const target = ensureCopy(state) as unknown[];
		const removed = spliceCapturedLength(target, start, remove, inputs, length);
		state.structural = true;
		syncArrayTarget(state);
		return removed.map((value, offset) => draftValue(state.context, value, state, start + offset));
	},
	sort(this: unknown, comparator?: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.sort, this, [comparator]);
		assertActive(state.context);
		if (comparator !== undefined && typeof comparator !== "function")
			throw new TypeError("Comparator must be a function");
		const target = ensureCopy(state) as unknown[];
		state.structural = true;
		Reflect.apply(Array.prototype.sort, target, [
			(left: unknown, right: unknown): number => {
				const draftedLeft = draftValue(state.context, left, state);
				const draftedRight = draftValue(state.context, right, state);
				if (typeof comparator === "function") {
					// Array.prototype.sort performs ToNumber on the return value. Returning
					// it directly preserves native bigint TypeError behavior.
					return Reflect.apply(comparator, undefined, [draftedLeft, draftedRight]) as number;
				}
				const leftString = String(draftedLeft);
				const rightString = String(draftedRight);
				return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
			},
		]);
		syncArrayTarget(state);
		return state.proxy;
	},
	reverse(this: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.reverse, this, []);
		assertActive(state.context);
		const target = ensureCopy(state) as unknown[];
		if (target.length > 1) {
			Reflect.apply(Array.prototype.reverse, target, []);
			state.structural = true;
		}
		return state.proxy;
	},
	fill(this: unknown, supplied: unknown, startArg?: unknown, endArg?: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.fill, this, [supplied, startArg, endArg]);
		assertActive(state.context);
		const length = (currentValue(state) as unknown[]).length;
		const start = startArg === undefined ? 0 : clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		if (end <= start) return state.proxy;
		const target = ensureCopy(state) as unknown[];
		for (let index = start; index < end; index++) target[index] = clonePlacement(supplied, state.context);
		state.structural = true;
		return state.proxy;
	},
	copyWithin(this: unknown, targetArg: unknown, startArg: unknown, endArg?: unknown): unknown {
		const state = mutatorState(this);
		if (state === undefined) return Reflect.apply(Array.prototype.copyWithin, this, [targetArg, startArg, endArg]);
		assertActive(state.context);
		const length = (currentValue(state) as unknown[]).length;
		const targetIndex = clampIndex(toIntegerOrInfinity(targetArg), length);
		const start = clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		const count = Math.min(Math.max(end - start, 0), length - targetIndex);
		if (count === 0) return state.proxy;
		const source = (currentValue(state) as unknown[]).slice(start, start + count);
		const target = ensureCopy(state) as unknown[];
		for (let offset = 0; offset < count; offset++)
			target[targetIndex + offset] = cloneLogical(source[offset], state.context);
		state.structural = true;
		return state.proxy;
	},
};

function cloneItems(values: readonly unknown[], context: DraftContext): unknown[] {
	return values.map((value) => clonePlacement(value, context));
}

function clonePlacement(value: unknown, _context: DraftContext): unknown {
	if (!isContainer(value)) return value;
	const state = draftState(value);
	return state === undefined ? cloneJson(value) : cloneState(state);
}

/** Fast trusted strict-JSON clone. Inputs are caller-guaranteed plain, dense, acyclic trees. */
export function cloneJson<T>(value: T): T {
	if (!isContainer(value)) return value;
	if (Array.isArray(value)) return value.map((child) => cloneJson(child)) as T;
	const result = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
	for (const key of Object.keys(value)) defineData(result, key, cloneJson((value as Record<string, unknown>)[key]));
	return result as T;
}

function cloneState(state: DraftState): Container {
	assertActive(state.context);
	const context = state.context;
	const current = state.copy ?? state.base;
	if (Array.isArray(current)) {
		const result = new Array<unknown>(current.length);
		for (let index = 0; index < current.length; index++) result[index] = cloneLogical(current[index], context);
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(current)) as Record<string, unknown>;
	for (const key of Object.keys(current)) defineData(result, key, cloneLogical(current[key], context));
	return result;
}

function cloneLogical(value: unknown, context: DraftContext): unknown {
	if (!isContainer(value)) return value;
	const proxyState = draftState(value);
	if (proxyState !== undefined) return cloneState(proxyState);
	const state = context.states.get(value);
	return state === undefined ? cloneJson(value) : cloneState(state);
}

function finalize(state: DraftState): Container {
	if (state.finalized !== undefined) return state.finalized;
	if (!state.dirty) return state.base;
	const current = state.copy ?? state.base;
	let result = current;
	if (Array.isArray(current) && state.structural) {
		for (let index = 0; index < current.length; index++) {
			const value = current[index];
			if (!isContainer(value)) continue;
			const child = draftState(value) ?? state.context.states.get(value);
			if (child === undefined || !child.dirty) continue;
			const next = finalize(child);
			if (next === value) continue;
			if (result === state.base) result = shallowCopy(state.base);
			(result as unknown[])[index] = next;
		}
	} else {
		forEachDirtyChild(state, (key, child) => {
			const value = (current as Record<ChildKey, unknown>)[key];
			if (value !== child.base && draftState(value) !== child) return;
			const next = finalize(child);
			if (next === value) return;
			if (result === state.base) result = shallowCopy(state.base);
			defineData(result, String(key), next);
			if (Array.isArray(current) && typeof key === "number") markArrayIndex(state, key);
		});
	}
	if (result !== state.base && shallowEqual(state.base, result)) result = state.base;
	state.finalized = result;
	if (
		Array.isArray(state.base) &&
		Array.isArray(result) &&
		result !== state.base &&
		!state.structural &&
		state.base.length === result.length
	) {
		const base = state.base as unknown[];
		const output = result as unknown[];
		const changed = changedIndexList(state);
		if (changed !== undefined) {
			const keys = changed.filter((index) => index < base.length && index < output.length);
			state.context.hints.set(result, { base: state.base as JsonValue[], keys });
		}
	}
	return result;
}

function forEachDirtyChild(state: DraftState, visit: (key: ChildKey, child: DraftState) => void): void {
	const children = state.children;
	if (children === undefined) return;
	if (children instanceof Map) {
		for (const [key, child] of children) if (child.dirty) visit(key, child);
	} else if (children.dirty && children.key !== undefined) visit(children.key, children);
}

function changedIndexList(state: DraftState): number[] | undefined {
	const changed = state.changedIndices;
	if (changed === undefined) return [];
	// The differ only consumes narrow hints. Avoid materializing and sorting a
	// dense set that it would immediately discard.
	if (changed instanceof Set) {
		if (changed.size >= 2_048) return undefined;
		return [...changed].sort((left, right) => left - right);
	}
	return [changed];
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

function defineData(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function spliceCapturedLength(
	target: unknown[],
	start: number,
	remove: number,
	items: readonly unknown[],
	capturedLength: number,
): unknown[] {
	const removed = new Array<unknown>(remove);
	for (let offset = 0; offset < remove; offset++) {
		defineData(removed, String(offset), denseArrayValue(target, start + offset));
	}
	if (items.length < remove) {
		for (let source = start + remove; source < capturedLength; source++) {
			defineData(target, String(source - remove + items.length), denseArrayValue(target, source));
		}
	} else if (items.length > remove) {
		for (let source = capturedLength - 1; source >= start + remove; source--) {
			defineData(target, String(source - remove + items.length), denseArrayValue(target, source));
		}
	}
	for (let offset = 0; offset < items.length; offset++) defineData(target, String(start + offset), items[offset]);
	target.length = capturedLength - remove + items.length;
	return removed;
}

function denseArrayValue(target: readonly unknown[], index: number): unknown {
	return index < target.length && Object.hasOwn(target, index) && target[index] !== undefined ? target[index] : null;
}

function insertChunked(target: unknown[], index: number, values: readonly unknown[]): void {
	for (let offset = 0; offset < values.length; offset += MAX_NATIVE_ARRAY_INSERT_ITEMS) {
		target.splice(index + offset, 0, ...values.slice(offset, offset + MAX_NATIVE_ARRAY_INSERT_ITEMS));
	}
}

function toIntegerOrInfinity(value: unknown): number {
	const number = +(value as number);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
}

function clampIndex(value: number, length: number): number {
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return Math.max(length + value, 0);
	return Math.min(value, length);
}

function syncArrayTarget(state: DraftState): void {
	(state.target as unknown[]).length = ((state.copy ?? state.base) as unknown[]).length;
}

function assertWritable(state: DraftState, property: PropertyKey): void {
	assertActive(state.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
}

function assertActive(context: DraftContext): void {
	if (!context.active) throw new TypeError("Cannot use a draft outside its change callback");
}

function isContainer(value: unknown): value is Container {
	return value !== null && typeof value === "object";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
