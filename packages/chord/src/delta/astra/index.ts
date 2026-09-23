import type { JsonValue } from "../../types.ts";
import type { Draft } from "../draft.ts";
import { type NonEmptyPath, type Op, overlap, type Path, RESERVED_SEGMENTS } from "../index.ts";

export type { Draft, JsonValue, Op };

type Primitive = null | boolean | number | string;
type Container = JsonValue[] | Record<string, JsonValue>;
type Stored = JsonValue;
type Status = "open" | "prepared" | "consumed" | "aborted" | "stale" | "faulted";

type InsertSource = { values: Stored[] };
type ParentKind = 0 | 1 | 2; // object, base-array entry, inserted-array entry

type BasePiece = { kind: "base"; start: number; length: number; step: 1 | -1 };
type InsertPiece = { kind: "insert"; source: InsertSource; start: number; length: number; step: 1 | -1 };
type Piece = BasePiece | InsertPiece;

type PieceNode = {
	piece: Piece;
	left: PieceNode | undefined;
	right: PieceNode | undefined;
	priority: number;
	elements: number;
};

type PieceLocation = { piece: Piece; logicalStart: number; minimum: number; maximum: number };

type DenseRegion = { start: number; length: number };
type DenseCandidates = { indices: number[]; bits: Uint8Array | undefined; length: number };

type ArrayPlan = {
	removeRuns: number[];
	permutation: number[] | undefined;
	insertRuns: number[];
};

type ArrayOverlay = {
	root: PieceNode | undefined;
	pieces: Piece[] | undefined;
	baseOverrides: Map<number, Stored>;
	insertOverrides: Map<InsertSource, Map<number, Stored>>;
	structural: boolean;
	generation: number;
	plan: ArrayPlan | undefined;
	seed: number;
	locatedOffset: number;
	baseLocations: PieceLocation[] | undefined;
	insertLocations: Map<InsertSource, PieceLocation[]> | undefined;
};

type OverlayNode = {
	context: OverlayContext;
	base: Container;
	parent: OverlayNode | undefined;
	parentKind: ParentKind;
	parentKey: string | number;
	parentSource?: InsertSource;
	parentExpected?: Container;
	parentPlacement: boolean;
	target: object;
	proxy: object;
	writeKey?: string;
	writeValue?: Stored;
	writes?: Map<string, Stored>;
	deleteKey?: string;
	deletes?: Set<string>;
	readded?: Set<string>;
	array?: ArrayOverlay;
	dirty?: boolean;
	preparedPath?: Path;
	applyDepth?: number;
};

type OverlayContext = {
	owner: object;
	tracker: WeakRef<TrackerImpl<object>>;
	baseRevision: number;
	status: Status;
	root: OverlayNode | undefined;
	dirty: OverlayNode[];
	nodes: OverlayNode[];
	rawNodes: WeakMap<object, OverlayNode>;
	ops: Op[] | undefined;
	replacement: boolean;
	replacementNoop: boolean;
	baseValue: object | undefined;
	adoptedValue: object | undefined;
	registryRef: WeakRef<OverlayContext> | undefined;
};

type PreparedMetadata = { context: OverlayContext };

const NODE = Symbol("astra.overlay.node");
const PREPARED = new WeakMap<object, PreparedMetadata>();
const RELEASED: Record<string, JsonValue> = {};
const ARRAY_MUTATORS = new Set<PropertyKey>([
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"reverse",
	"sort",
	"fill",
	"copyWithin",
]);
const MAX_SPLICE_CHUNK = 10_000;
const MAX_DELTA_OPERATIONS = 4_096;

export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly baseRevision: number;
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

class PreparedImpl<T extends object> implements Prepared<T> {
	readonly #context: OverlayContext;
	readonly #view: T;
	readonly base: T;

	constructor(context: OverlayContext, value: T) {
		this.#context = context;
		this.#view = value;
		this.base = context.baseValue as T;
		PREPARED.set(this, { context });
	}

	get value(): T {
		return (this.#context.status === "consumed" ? this.#context.adoptedValue : this.#view) as T;
	}

	get baseRevision(): number {
		return this.#context.baseRevision;
	}

	get ops(): readonly Op[] {
		return ensureOperations(this.#context);
	}

	abort(): void {
		abortContext(this.#context);
	}
}

class ChangeImpl<T extends object> implements Change<T> {
	readonly #state: WeakRef<object>;
	#context: OverlayContext | undefined;
	#preparedContext: WeakRef<OverlayContext> | undefined;
	#settled = false;

	constructor(context: OverlayContext) {
		this.#context = context;
		this.#state = new WeakRef(context.root!.proxy);
	}

	get state(): Draft<T> {
		const state = this.#state.deref();
		if (state === undefined) throw new TypeError("Cannot use a settled overlay");
		return state as Draft<T>;
	}

	prepare(): Prepared<T> {
		if (this.#settled) throw new Error("Change has already been settled");
		const context = this.#context!;
		assertWritable(context);
		context.status = "prepared";
		try {
			if (!context.replacement) context.ops = emitOperations(context);
			const prepared = new PreparedImpl(context, context.root!.proxy as T);
			this.#preparedContext = new WeakRef(context);
			this.#settled = true;
			return prepared;
		} catch (error) {
			context.status = "aborted";
			clearContext(context);
			this.#settled = true;
			throw error;
		} finally {
			this.#context = undefined;
		}
	}

	abort(): void {
		if (this.#settled) {
			const context = this.#preparedContext?.deref();
			this.#preparedContext = undefined;
			if (context !== undefined) abortContext(context);
			return;
		}
		this.#settled = true;
		abortContext(this.#context!);
		this.#context = undefined;
	}
}

class TrackerImpl<T extends object> implements Tracker<T> {
	readonly #owner = {};
	readonly #contexts = new Set<WeakRef<OverlayContext>>();
	#value: T;
	#revision = 0;
	#pruneBudget = 256;
	#fault: unknown;

	constructor(initial: T) {
		this.#value = initial;
	}

	get value(): T {
		this.#assertHealthy();
		return this.#value;
	}

	get revision(): number {
		return this.#revision;
	}

	beginChange(): Change<T> {
		this.#assertHealthy();
		const context = createContext(this, this.#owner, this.#revision, this.#value, false, this.#value);
		this.#register(context);
		return new ChangeImpl(context);
	}

	prepareReplace(value: T): Prepared<T> {
		this.#assertHealthy();
		const context = createContext(this, this.#owner, this.#revision, value, true, this.#value);
		context.status = "prepared";
		this.#register(context);
		return new PreparedImpl(context, context.root!.proxy as T);
	}

	adopt(prepared: Prepared<T>): void {
		this.#assertHealthy();
		const context = PREPARED.get(prepared as object)?.context;
		if (context?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (context.status === "consumed") throw new Error("Prepared change has already been used");
		if (context.status === "aborted") throw new Error("Prepared change has been aborted");
		if (context.status === "stale") throw new Error("Prepared change is stale");
		if (context.status !== "prepared") throw new Error("Prepared change is not ready");
		if (context.baseRevision !== this.#revision) {
			context.status = "stale";
			clearContext(context);
			throw new Error("Prepared change is stale");
		}

		// Detach payloads before the candidate placements become committed mutable data.
		ensureOperations(context);
		try {
			if (context.replacement) {
				if (!context.replacementNoop) this.#value = context.root!.base as T;
			} else applyOverlay(context);
		} catch (error) {
			context.status = "faulted";
			this.#fault = error;
			this.#invalidate(context);
			throw new Error("Tracker faulted after a partial trusted adoption", { cause: error });
		}
		context.adoptedValue = this.#value;
		context.status = "consumed";
		this.#revision += 1;
		this.#invalidate(context);
	}

	releaseContext(context: OverlayContext): void {
		if (context.registryRef !== undefined) this.#contexts.delete(context.registryRef);
		context.registryRef = undefined;
	}

	#register(context: OverlayContext): void {
		const reference = new WeakRef(context);
		context.registryRef = reference;
		this.#contexts.add(reference);
		this.#pruneBudget -= 1;
		if (this.#pruneBudget === 0) {
			this.#prune();
			this.#pruneBudget = Math.max(256, this.#contexts.size);
		}
	}

	#prune(): void {
		for (const reference of this.#contexts) {
			if (reference.deref() === undefined) this.#contexts.delete(reference);
		}
	}

	#invalidate(winner: OverlayContext): void {
		for (const reference of this.#contexts) {
			const context = reference.deref();
			if (context === undefined) {
				this.#contexts.delete(reference);
				continue;
			}
			if (context !== winner && (context.status === "open" || context.status === "prepared")) {
				context.status = "stale";
			}
			clearContext(context);
			this.#contexts.delete(reference);
		}
		this.#pruneBudget = 256;
	}

	replacementBase(context: OverlayContext): T | undefined {
		return context.baseRevision === this.#revision ? this.#value : undefined;
	}

	#assertHealthy(): void {
		if (this.#fault !== undefined) throw new Error("Tracker is faulted", { cause: this.#fault });
	}
}

/** Take ownership of an alias-free mutable strict-JSON root in O(1). */
export function track<T extends object>(initial: T): Tracker<T> {
	return new TrackerImpl(initial);
}

function createContext<T extends object>(
	tracker: TrackerImpl<T>,
	owner: object,
	baseRevision: number,
	root: T,
	replacement: boolean,
	base: T,
): OverlayContext {
	const context: OverlayContext = {
		owner,
		tracker: new WeakRef(tracker as unknown as TrackerImpl<object>),
		baseRevision,
		status: "open",
		root: undefined,
		dirty: [],
		nodes: [],
		rawNodes: new WeakMap(),
		ops: undefined,
		replacement,
		replacementNoop: false,
		baseValue: base,
		adoptedValue: undefined,
		registryRef: undefined,
	};
	context.root = createNode(context, root as Container, undefined);
	return context;
}

const sharedObjectHandler: ProxyHandler<object> = {
	deleteProperty(target, property) {
		return deleteProperty(nodeForTarget(target), property);
	},
	defineProperty(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Defining overlay properties is not supported");
	},
	get(target, property) {
		const node = nodeForTarget(target);
		if (property === NODE) return node;
		return getProperty(node, property);
	},
	getOwnPropertyDescriptor(target, property) {
		return getDescriptor(nodeForTarget(target), property);
	},
	getPrototypeOf(target) {
		const node = nodeForTarget(target);
		assertReadable(node.context);
		return Object.getPrototypeOf(node.base);
	},
	has(target, property) {
		return hasProperty(nodeForTarget(target), property);
	},
	isExtensible(target) {
		assertReadable(nodeForTarget(target).context);
		return true;
	},
	ownKeys(target) {
		return ownKeys(nodeForTarget(target));
	},
	preventExtensions(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Overlays cannot be made non-extensible");
	},
	set(target, property, value) {
		return setProperty(nodeForTarget(target), property, value);
	},
	setPrototypeOf(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Changing an overlay prototype is not supported");
	},
};

const sharedArrayHandler: ProxyHandler<object> = sharedObjectHandler;

function createNode(
	context: OverlayContext,
	base: Container,
	parent: OverlayNode | undefined,
	parentKind: ParentKind = 0,
	parentKey: string | number = "",
	parentSource: InsertSource | undefined = undefined,
	parentExpected: Container | undefined = undefined,
	parentPlacement = false,
): OverlayNode {
	const existing = context.rawNodes.get(base);
	if (existing !== undefined) return existing;
	const target: object = Array.isArray(base) ? [] : {};
	if (Array.isArray(target)) target.length = (base as JsonValue[]).length;
	const node: OverlayNode = {
		context,
		base,
		parent,
		parentKind,
		parentKey,
		parentPlacement,
		target,
		proxy: target,
	};
	if (parentSource !== undefined) node.parentSource = parentSource;
	if (parentExpected !== undefined) node.parentExpected = parentExpected;
	Object.defineProperty(target, NODE, { value: node, configurable: true });
	node.proxy = new Proxy(target, Array.isArray(base) ? sharedArrayHandler : sharedObjectHandler);
	context.rawNodes.set(base, node);
	context.nodes.push(node);
	return node;
}

function nodeForTarget(target: object): OverlayNode {
	const node = Object.getOwnPropertyDescriptor(target, NODE)?.value as OverlayNode | undefined;
	if (node === undefined) throw new TypeError("Cannot use a settled overlay");
	return node;
}

function assertReadable(context: OverlayContext): void {
	if (
		context.status === "consumed" ||
		context.status === "aborted" ||
		context.status === "stale" ||
		context.status === "faulted"
	) {
		throw new TypeError("Cannot use a settled overlay");
	}
}

function assertWritable(context: OverlayContext): void {
	assertReadable(context);
	if (context.status !== "open") throw new TypeError("Prepared overlays are read-only");
}

function getProperty(node: OverlayNode, property: PropertyKey): unknown {
	assertReadable(node.context);
	if (Array.isArray(node.base)) {
		const overlay = arrayOverlay(node);
		if (property === "length") return arrayLength(overlay);
		if (ARRAY_MUTATORS.has(property)) return arrayMutators[property as keyof typeof arrayMutators];
		const index = arrayIndex(property);
		if (index !== undefined) {
			if (index >= arrayLength(overlay)) return undefined;
			const piece = locatePiece(overlay, index);
			const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
			const value = entryValueAt(node, piece, sourceIndex);
			if (!isContainer(value)) return value;
			return createNode(
				node.context,
				value,
				node,
				piece.kind === "base" ? 1 : 2,
				sourceIndex,
				piece.kind === "insert" ? piece.source : undefined,
				value,
				piece.kind === "insert" || hasEntryOverrideAt(overlay, piece, sourceIndex),
			).proxy;
		}
		return Reflect.get(Array.prototype, property, node.proxy);
	}
	if (typeof property === "symbol") return Reflect.get(node.base, property, node.proxy);
	const key = String(property);
	if (!objectHas(node, key)) {
		if (isObjectDeleted(node, key) || Object.hasOwn(node.base, key)) return undefined;
		return Reflect.get(node.base, property, node.proxy);
	}
	const value = objectValue(node, key);
	if (!isContainer(value)) return value;
	return createNode(node.context, value, node, 0, key, undefined, value, hasObjectWrite(node, key)).proxy;
}

function setProperty(node: OverlayNode, property: PropertyKey, supplied: unknown): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(node.base)) {
		if (property === "length") {
			setArrayLength(node, toArrayLength(supplied));
			return true;
		}
		const index = arrayIndex(property);
		if (index === undefined) throw new TypeError("Only array indices and length can be written");
		if (index > arrayLength(arrayOverlay(node))) throw new TypeError("Overlay arrays cannot contain holes");
		setArrayIndex(node, index, clonePlacement(supplied));
		return true;
	}
	const key = String(property);
	if (supplied === undefined) return deleteProperty(node, key);
	const stored = clonePlacement(supplied);
	const current = objectValue(node, key);
	const wasDeleted = isObjectDeleted(node, key);
	if (!wasDeleted && !isContainer(stored) && current === stored) return true;
	setObjectWrite(node, key, stored);
	if (wasDeleted && Object.hasOwn(node.base, key)) {
		if (node.readded === undefined) node.readded = new Set();
		node.readded.add(key);
	}
	deleteObjectDeletion(node, key);
	markDirty(node);
	return true;
}

function deleteProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(node.base)) throw new TypeError("Overlay arrays cannot contain holes");
	const key = String(property);
	if (!objectHas(node, key)) return true;
	deleteObjectWrite(node, key);
	node.readded?.delete(key);
	setObjectDeletion(node, key);
	markDirty(node);
	return true;
}

function hasProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertReadable(node.context);
	if (Array.isArray(node.base)) {
		if (property === "length") return true;
		const index = arrayIndex(property);
		if (index !== undefined) return index < arrayLength(arrayOverlay(node));
		return property in Array.prototype;
	}
	return typeof property === "symbol" ? property in node.base : objectHas(node, String(property));
}

function ownKeys(node: OverlayNode): ArrayLike<string | symbol> {
	assertReadable(node.context);
	if (Array.isArray(node.base)) {
		const length = arrayLength(arrayOverlay(node));
		return [...Array.from({ length }, (_, index) => String(index)), "length"];
	}
	const keys = Object.keys(node.base).filter((key) => !isObjectDeleted(node, key) && !node.readded?.has(key));
	const seen = new Set(keys);
	if (node.writeKey !== undefined && !seen.has(node.writeKey)) {
		keys.push(node.writeKey);
		seen.add(node.writeKey);
	}
	for (const key of node.writes?.keys() ?? []) {
		if (seen.has(key)) continue;
		keys.push(key);
		seen.add(key);
	}
	const indices: number[] = [];
	const strings: string[] = [];
	for (const key of keys) {
		const index = arrayIndex(key);
		if (index === undefined) strings.push(key);
		else indices.push(index);
	}
	indices.sort((left, right) => left - right);
	return [...indices.map(String), ...strings];
}

function getDescriptor(node: OverlayNode, property: PropertyKey): PropertyDescriptor | undefined {
	assertReadable(node.context);
	if (Array.isArray(node.base)) {
		if (property === "length") {
			const length = arrayLength(arrayOverlay(node));
			(node.target as unknown[]).length = length;
			return Reflect.getOwnPropertyDescriptor(node.target, "length");
		}
		const index = arrayIndex(property);
		if (index === undefined || index >= arrayLength(arrayOverlay(node))) return undefined;
	} else {
		if (typeof property === "symbol" || !objectHas(node, String(property))) return undefined;
	}
	return {
		configurable: true,
		enumerable: true,
		writable: node.context.status === "open",
		value: getProperty(node, property),
	};
}

function hasObjectWrite(node: OverlayNode, key: string): boolean {
	return node.writeKey === key || (node.writes?.has(key) ?? false);
}

function setObjectWrite(node: OverlayNode, key: string, value: Stored): void {
	if (node.writes !== undefined) {
		node.writes.set(key, value);
		return;
	}
	if (node.writeKey === undefined || node.writeKey === key) {
		node.writeKey = key;
		node.writeValue = value;
		return;
	}
	node.writes = new Map([
		[node.writeKey, node.writeValue!],
		[key, value],
	]);
	node.writeKey = undefined;
	node.writeValue = undefined;
}

function deleteObjectWrite(node: OverlayNode, key: string): void {
	if (node.writeKey === key) {
		node.writeKey = undefined;
		node.writeValue = undefined;
	} else node.writes?.delete(key);
}

function isObjectDeleted(node: OverlayNode, key: string): boolean {
	return node.deleteKey === key || (node.deletes?.has(key) ?? false);
}

function setObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deletes !== undefined) {
		node.deletes.add(key);
		return;
	}
	if (node.deleteKey === undefined || node.deleteKey === key) {
		node.deleteKey = key;
		return;
	}
	node.deletes = new Set([node.deleteKey, key]);
	node.deleteKey = undefined;
}

function deleteObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deleteKey === key) node.deleteKey = undefined;
	else node.deletes?.delete(key);
}

function objectHas(node: OverlayNode, key: string): boolean {
	if (isObjectDeleted(node, key)) return false;
	return hasObjectWrite(node, key) || Object.hasOwn(node.base, key);
}

function objectValue(node: OverlayNode, key: string): Stored {
	if (node.writeKey === key) return node.writeValue!;
	if (node.writes?.has(key)) return node.writes.get(key)!;
	return (node.base as Record<string, JsonValue>)[key]!;
}

function markDirty(node: OverlayNode): void {
	if (node.dirty) return;
	node.dirty = true;
	node.context.dirty.push(node);
}

function arrayOverlay(node: OverlayNode): ArrayOverlay {
	if (node.array !== undefined) return node.array;
	const base = node.base as JsonValue[];
	const overlay: ArrayOverlay = {
		root: undefined,
		pieces: undefined,
		baseOverrides: new Map(),
		insertOverrides: new Map(),
		structural: false,
		generation: 0,
		plan: undefined,
		seed: 0x9e3779b9,
		locatedOffset: 0,
		baseLocations: undefined,
		insertLocations: undefined,
	};
	if (base.length > 0)
		overlay.root = createPieceNode(overlay, { kind: "base", start: 0, length: base.length, step: 1 });
	node.array = overlay;
	return overlay;
}

function nextPiecePriority(overlay: ArrayOverlay): number {
	let value = overlay.seed;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	overlay.seed = value >>> 0;
	return overlay.seed;
}

function treeElements(node: PieceNode | undefined): number {
	return node?.elements ?? 0;
}

function updatePieceNode(node: PieceNode): void {
	node.elements = treeElements(node.left) + node.piece.length + treeElements(node.right);
}

function createPieceNode(overlay: ArrayOverlay, piece: Piece): PieceNode {
	return { piece, left: undefined, right: undefined, priority: nextPiecePriority(overlay), elements: piece.length };
}

function mergePieceTrees(left: PieceNode | undefined, right: PieceNode | undefined): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	if (left.priority >= right.priority) {
		left.right = mergePieceTrees(left.right, right);
		updatePieceNode(left);
		return left;
	}
	right.left = mergePieceTrees(left, right.left);
	updatePieceNode(right);
	return right;
}

function splitPieceTree(
	overlay: ArrayOverlay,
	root: PieceNode | undefined,
	index: number,
): [PieceNode | undefined, PieceNode | undefined] {
	if (root === undefined) return [undefined, undefined];
	const leftLength = treeElements(root.left);
	if (index < leftLength) {
		const [left, right] = splitPieceTree(overlay, root.left, index);
		root.left = right;
		updatePieceNode(root);
		return [left, root];
	}
	const pieceEnd = leftLength + root.piece.length;
	if (index > pieceEnd) {
		const [left, right] = splitPieceTree(overlay, root.right, index - pieceEnd);
		root.right = left;
		updatePieceNode(root);
		return [root, right];
	}
	if (index === leftLength) {
		const left = root.left;
		root.left = undefined;
		updatePieceNode(root);
		return [left, root];
	}
	if (index === pieceEnd) {
		const right = root.right;
		root.right = undefined;
		updatePieceNode(root);
		return [root, right];
	}
	const offset = index - leftLength;
	const first = { ...root.piece, length: offset };
	const second = {
		...root.piece,
		start: root.piece.start + root.piece.step * offset,
		length: root.piece.length - offset,
	};
	return [
		mergePieceTrees(root.left, createPieceNode(overlay, first)),
		mergePieceTrees(createPieceNode(overlay, second), root.right),
	];
}

function leftmostPieceNode(node: PieceNode): PieceNode {
	while (node.left !== undefined) node = node.left;
	return node;
}

function rightmostPieceNode(node: PieceNode): PieceNode {
	while (node.right !== undefined) node = node.right;
	return node;
}

function mergeablePieces(left: Piece, right: Piece): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "insert" && left.source !== (right as InsertPiece).source) return false;
	if (left.length === 1 && right.length === 1) return Math.abs(right.start - left.start) === 1;
	return left.step === right.step && left.start + left.step * left.length === right.start;
}

function joinNormalized(
	overlay: ArrayOverlay,
	left: PieceNode | undefined,
	right: PieceNode | undefined,
): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	const leftPiece = rightmostPieceNode(left).piece;
	const rightPiece = leftmostPieceNode(right).piece;
	if (!mergeablePieces(leftPiece, rightPiece)) return mergePieceTrees(left, right);
	const [leftRest] = splitPieceTree(overlay, left, treeElements(left) - leftPiece.length);
	const [, rightRest] = splitPieceTree(overlay, right, rightPiece.length);
	const step = leftPiece.length === 1 ? ((rightPiece.start - leftPiece.start) as 1 | -1) : leftPiece.step;
	const combined: Piece =
		leftPiece.kind === "base"
			? { kind: "base", start: leftPiece.start, length: leftPiece.length + rightPiece.length, step }
			: {
					kind: "insert",
					source: leftPiece.source,
					start: leftPiece.start,
					length: leftPiece.length + rightPiece.length,
					step,
				};
	return joinNormalized(overlay, joinNormalized(overlay, leftRest, createPieceNode(overlay, combined)), rightRest);
}

function flattenPieceTree(node: PieceNode | undefined, output: Piece[]): void {
	if (node === undefined) return;
	flattenPieceTree(node.left, output);
	output.push(node.piece);
	flattenPieceTree(node.right, output);
}

function piecesOf(overlay: ArrayOverlay): readonly Piece[] {
	if (overlay.pieces === undefined) {
		overlay.pieces = [];
		flattenPieceTree(overlay.root, overlay.pieces);
	}
	return overlay.pieces;
}

function treeFromPieces(overlay: ArrayOverlay, pieces: Piece[]): PieceNode | undefined {
	mergePieces(pieces);
	let root: PieceNode | undefined;
	for (const piece of pieces) root = mergePieceTrees(root, createPieceNode(overlay, piece));
	return root;
}

function replaceAllPieces(overlay: ArrayOverlay, pieces: Piece[]): void {
	overlay.root = treeFromPieces(overlay, pieces);
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
}

function arrayLength(overlay: ArrayOverlay): number {
	return treeElements(overlay.root);
}

function locatePiece(overlay: ArrayOverlay, index: number): Piece {
	let node = overlay.root;
	while (node !== undefined) {
		const leftLength = treeElements(node.left);
		if (index < leftLength) node = node.left;
		else if (index >= leftLength + node.piece.length) {
			index -= leftLength + node.piece.length;
			node = node.right;
		} else {
			overlay.locatedOffset = index - leftLength;
			return node.piece;
		}
	}
	throw new RangeError("Array overlay index is out of range");
}

function arrayIndex(property: PropertyKey): number | undefined {
	if (typeof property !== "string" || property === "") return undefined;
	const index = Number(property);
	if (!Number.isInteger(index) || index < 0 || index >= 4_294_967_295 || String(index) !== property) return undefined;
	return index;
}

function entryValueAt(node: OverlayNode, piece: Piece, sourceIndex: number): Stored {
	const overlay = arrayOverlay(node);
	if (piece.kind === "base") {
		return overlay.baseOverrides.has(sourceIndex)
			? overlay.baseOverrides.get(sourceIndex)!
			: (node.base as JsonValue[])[sourceIndex]!;
	}
	const overrides = overlay.insertOverrides.get(piece.source);
	return overrides?.has(sourceIndex) ? overrides.get(sourceIndex)! : piece.source.values[sourceIndex]!;
}

function hasEntryOverrideAt(overlay: ArrayOverlay, piece: Piece, sourceIndex: number): boolean {
	return piece.kind === "base"
		? overlay.baseOverrides.has(sourceIndex)
		: (overlay.insertOverrides.get(piece.source)?.has(sourceIndex) ?? false);
}

function extendRightmostPiece(node: PieceNode, amount: number): void {
	if (node.right !== undefined) extendRightmostPiece(node.right, amount);
	else node.piece.length += amount;
	updatePieceNode(node);
}

function invalidatePieceCaches(overlay: ArrayOverlay): void {
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
	overlay.plan = undefined;
}

function replacePieceRange(node: OverlayNode, index: number, remove: number, inserted: Piece[]): void {
	if (remove === 0 && inserted.length === 0) return;
	const overlay = arrayOverlay(node);
	if (remove === 0 && index === arrayLength(overlay) && inserted.length === 1 && overlay.root !== undefined) {
		const addition = inserted[0]!;
		const tail = rightmostPieceNode(overlay.root).piece;
		if (
			addition.kind === "insert" &&
			tail.kind === "insert" &&
			tail.step === 1 &&
			tail.start + tail.length === tail.source.values.length
		) {
			for (const value of addition.source.values) tail.source.values.push(value);
			extendRightmostPiece(overlay.root, addition.length);
			invalidatePieceCaches(overlay);
			overlay.structural = true;
			overlay.generation += 1;
			(node.target as unknown[]).length = arrayLength(overlay);
			markDirty(node);
			return;
		}
	}
	const [left, rest] = splitPieceTree(overlay, overlay.root, index);
	const [, right] = splitPieceTree(overlay, rest, remove);
	const middle = treeFromPieces(overlay, inserted);
	overlay.root = joinNormalized(overlay, joinNormalized(overlay, left, middle), right);
	invalidatePieceCaches(overlay);
	overlay.structural = true;
	overlay.generation += 1;
	(node.target as unknown[]).length = arrayLength(overlay);
	markDirty(node);
}

function mergePieces(pieces: Piece[]): void {
	for (let index = 1; index < pieces.length; ) {
		const left = pieces[index - 1]!;
		const right = pieces[index]!;
		const sameSource =
			left.kind === right.kind && (left.kind === "base" || left.source === (right as InsertPiece).source);
		if (sameSource && left.length === 1 && right.length === 1 && Math.abs(right.start - left.start) === 1) {
			left.step = (right.start - left.start) as 1 | -1;
			left.length = 2;
			pieces.splice(index, 1);
		} else if (sameSource && left.step === right.step && left.start + left.step * left.length === right.start) {
			left.length += right.length;
			pieces.splice(index, 1);
		} else index += 1;
	}
}

function insertPiece(items: Stored[]): InsertPiece[] {
	if (items.length === 0) return [];
	return [{ kind: "insert", source: { values: items }, start: 0, length: items.length, step: 1 }];
}

function setArrayIndex(node: OverlayNode, index: number, stored: Stored): void {
	const overlay = arrayOverlay(node);
	const length = arrayLength(overlay);
	if (index === length) {
		replacePieceRange(node, length, 0, insertPiece([stored]));
		return;
	}
	const piece = locatePiece(overlay, index);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const current = entryValueAt(node, piece, sourceIndex);
	if (!isContainer(stored) && current === stored) return;
	if (piece.kind === "base") {
		if (!isContainer(stored) && stored === (node.base as JsonValue[])[sourceIndex]) {
			overlay.baseOverrides.delete(sourceIndex);
		} else overlay.baseOverrides.set(sourceIndex, stored);
	} else {
		let overrides = overlay.insertOverrides.get(piece.source);
		if (!isContainer(stored) && stored === piece.source.values[sourceIndex]) {
			overrides?.delete(sourceIndex);
			if (overrides?.size === 0) overlay.insertOverrides.delete(piece.source);
		} else {
			if (overrides === undefined) {
				overrides = new Map();
				overlay.insertOverrides.set(piece.source, overrides);
			}
			overrides.set(sourceIndex, stored);
		}
	}
	markDirty(node);
}

function setArrayLength(node: OverlayNode, next: number): void {
	const current = arrayLength(arrayOverlay(node));
	if (next === current) return;
	if (next < current) replacePieceRange(node, next, current - next, []);
	else replacePieceRange(node, current, 0, insertPiece(Array.from({ length: next - current }, () => null)));
}

function toArrayLength(value: unknown): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0 || number >= 4_294_967_296) throw new RangeError("Invalid array length");
	return number;
}

function toIntegerOrInfinity(value: unknown): number {
	const number = Number(value);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
}

function clampIndex(value: number, length: number): number {
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return Math.max(length + value, 0);
	return Math.min(value, length);
}

function mutatorNode(receiver: unknown): OverlayNode | undefined {
	if (!isContainer(receiver)) return undefined;
	const node = Reflect.get(receiver, NODE) as OverlayNode | undefined;
	if (node === undefined) return undefined;
	if (!Array.isArray(node.base)) throw new TypeError("Array mutator called on incompatible receiver");
	assertWritable(node.context);
	return node;
}

const arrayMutators = {
	push(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.push, this, items) as number;
		const length = arrayLength(arrayOverlay(node));
		replacePieceRange(node, length, 0, insertPiece(items.map(clonePlacement)));
		return length + items.length;
	},
	pop(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.pop, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getProperty(node, String(length - 1));
		replacePieceRange(node, length - 1, 1, []);
		return value;
	},
	shift(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.shift, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getProperty(node, "0");
		replacePieceRange(node, 0, 1, []);
		return value;
	},
	unshift(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.unshift, this, items) as number;
		replacePieceRange(node, 0, 0, insertPiece(items.map(clonePlacement)));
		return arrayLength(arrayOverlay(node));
	},
	splice(this: unknown, ...args: unknown[]): unknown[] {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.splice, this, args) as unknown[];
		const length = arrayLength(arrayOverlay(node));
		const start = args.length === 0 ? 0 : clampIndex(toIntegerOrInfinity(args[0]), length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - start
					: Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), length - start);
		const removed = Array.from({ length: remove }, (_, offset) => getProperty(node, String(start + offset)));
		const items = args.slice(2).map(clonePlacement);
		replacePieceRange(node, start, remove, insertPiece(items));
		setArrayLength(node, length - remove + items.length);
		return removed;
	},
	reverse(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.reverse, this, []);
		const overlay = arrayOverlay(node);
		if (arrayLength(overlay) < 2) return node.proxy;
		const pieces = [...piecesOf(overlay)].reverse();
		for (const piece of pieces) {
			piece.start += piece.step * (piece.length - 1);
			piece.step = piece.step === 1 ? -1 : 1;
		}
		replaceAllPieces(overlay, pieces);
		overlay.structural = true;
		overlay.generation += 1;
		overlay.plan = undefined;
		markDirty(node);
		return node.proxy;
	},
	sort(this: unknown, comparator?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.sort, this, [comparator]);
		if (comparator !== undefined && typeof comparator !== "function")
			throw new TypeError("Comparator must be a function");
		const overlay = arrayOverlay(node);
		const insertedSources: InsertSource[] = [];
		const insertedIndices: number[] = [];
		const insertedValues: unknown[] = [];
		const baseValues: unknown[] = new Array((node.base as JsonValue[]).length);
		const order: number[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				if (piece.kind === "base") {
					order.push(sourceIndex);
					baseValues[sourceIndex] = publicSortValue(node, sourceIndex, insertedSources, insertedIndices);
				} else {
					insertedSources.push(piece.source);
					insertedIndices.push(sourceIndex);
					const token = -insertedSources.length;
					order.push(token);
					insertedValues.push(publicSortValue(node, token, insertedSources, insertedIndices));
				}
			}
		}
		const baseSnapshot = new Map(overlay.baseOverrides);
		const insertSnapshots = new Map<InsertSource, Map<number, Stored>>();
		for (const [source, overrides] of overlay.insertOverrides) insertSnapshots.set(source, new Map(overrides));
		const generation = overlay.generation;
		order.sort((left, right) => {
			const leftValue = left < 0 ? insertedValues[-left - 1] : baseValues[left];
			const rightValue = right < 0 ? insertedValues[-right - 1] : baseValues[right];
			if (typeof comparator === "function")
				return Number(Reflect.apply(comparator, undefined, [leftValue, rightValue]));
			const a = String(leftValue);
			const b = String(rightValue);
			return a < b ? -1 : a > b ? 1 : 0;
		});
		if (
			baseSnapshot.size > 0 ||
			insertSnapshots.size > 0 ||
			overlay.baseOverrides.size > 0 ||
			overlay.insertOverrides.size > 0
		) {
			for (const token of order) {
				restoreSortOverride(overlay, token, insertedSources, insertedIndices, baseSnapshot, insertSnapshots);
			}
		}
		const comparatorWasStructural = overlay.generation !== generation;
		const currentLength = arrayLength(overlay);
		const samePrefix =
			currentLength >= order.length &&
			order.every((token, index) => sameSortTokenAt(overlay, index, token, insertedSources, insertedIndices));
		if (!samePrefix) {
			replacePieceRange(
				node,
				0,
				Math.min(order.length, currentLength),
				piecesFromSortOrder(order, insertedSources, insertedIndices),
			);
		}
		if (comparatorWasStructural) deduplicateArrayEntries(node);
		return node.proxy;
	},
	fill(this: unknown, supplied: unknown, startArg?: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.fill, this, [supplied, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const start = startArg === undefined ? 0 : clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		if (end <= start) return node.proxy;
		const items = Array.from({ length: end - start }, () => clonePlacement(supplied));
		replacePieceRange(node, start, end - start, insertPiece(items));
		return node.proxy;
	},
	copyWithin(this: unknown, targetArg: unknown, startArg: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.copyWithin, this, [targetArg, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const target = clampIndex(toIntegerOrInfinity(targetArg), length);
		const start = clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		const count = Math.min(Math.max(end - start, 0), length - target);
		const values = Array.from({ length: count }, (_, offset) =>
			clonePlacement(getProperty(node, String(start + offset))),
		);
		replacePieceRange(node, target, count, insertPiece(values));
		return node.proxy;
	},
};

function sortTokenSource(token: number, sources: readonly InsertSource[]): InsertSource | undefined {
	return token < 0 ? sources[-token - 1] : undefined;
}

function sortTokenIndex(token: number, indices: readonly number[]): number {
	return token < 0 ? indices[-token - 1]! : token;
}

function publicSortValue(
	node: OverlayNode,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): unknown {
	const overlay = arrayOverlay(node);
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	const value =
		source === undefined
			? overlay.baseOverrides.has(sourceIndex)
				? overlay.baseOverrides.get(sourceIndex)!
				: (node.base as JsonValue[])[sourceIndex]!
			: (overlay.insertOverrides.get(source)?.has(sourceIndex) ?? false)
				? overlay.insertOverrides.get(source)!.get(sourceIndex)!
				: source.values[sourceIndex]!;
	if (!isContainer(value)) return value;
	return createNode(
		node.context,
		value,
		node,
		source === undefined ? 1 : 2,
		sourceIndex,
		source,
		value,
		source !== undefined || overlay.baseOverrides.has(sourceIndex),
	).proxy;
}

function restoreSortOverride(
	overlay: ArrayOverlay,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
	baseSnapshot: ReadonlyMap<number, Stored>,
	insertSnapshots: ReadonlyMap<InsertSource, ReadonlyMap<number, Stored>>,
): void {
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	if (source === undefined) {
		if (baseSnapshot.has(sourceIndex)) overlay.baseOverrides.set(sourceIndex, baseSnapshot.get(sourceIndex)!);
		else overlay.baseOverrides.delete(sourceIndex);
		return;
	}
	let overrides = overlay.insertOverrides.get(source);
	const snapshot = insertSnapshots.get(source);
	if (snapshot?.has(sourceIndex)) {
		if (overrides === undefined) {
			overrides = new Map();
			overlay.insertOverrides.set(source, overrides);
		}
		overrides.set(sourceIndex, snapshot.get(sourceIndex)!);
	} else {
		overrides?.delete(sourceIndex);
		if (overrides?.size === 0) overlay.insertOverrides.delete(source);
	}
}

function sameSortTokenAt(
	overlay: ArrayOverlay,
	logicalIndex: number,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): boolean {
	const piece = locatePiece(overlay, logicalIndex);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const tokenSource = sortTokenSource(token, sources);
	return (
		sourceIndex === sortTokenIndex(token, indices) &&
		((piece.kind === "base" && tokenSource === undefined) ||
			(piece.kind === "insert" && piece.source === tokenSource))
	);
}

function deduplicateArrayEntries(node: OverlayNode): void {
	const overlay = arrayOverlay(node);
	const seenBase = new Set<number>();
	const seenInsert = new Map<InsertSource, Set<number>>();
	const next: Piece[] = [];
	let duplicated = false;
	for (const piece of piecesOf(overlay)) {
		for (let offset = 0; offset < piece.length; offset++) {
			const sourceIndex = piece.start + piece.step * offset;
			let seen: boolean;
			if (piece.kind === "base") {
				seen = seenBase.has(sourceIndex);
				seenBase.add(sourceIndex);
			} else {
				let indices = seenInsert.get(piece.source);
				if (indices === undefined) {
					indices = new Set();
					seenInsert.set(piece.source, indices);
				}
				seen = indices.has(sourceIndex);
				indices.add(sourceIndex);
			}
			if (seen) {
				duplicated = true;
				appendMergedPiece(
					next,
					insertPiece([cloneStored(entryValueAt(node, piece, sourceIndex), node.context)])[0]!,
				);
			} else appendMergedPiece(next, singletonPiece(piece, sourceIndex));
		}
	}
	if (!duplicated) return;
	replaceAllPieces(overlay, next);
	overlay.structural = true;
	overlay.generation += 1;
	overlay.plan = undefined;
	markDirty(node);
}

function piecesFromSortOrder(
	order: readonly number[],
	sources: readonly InsertSource[],
	indices: readonly number[],
): Piece[] {
	const pieces: Piece[] = [];
	for (const token of order) {
		const source = token < 0 ? sources[-token - 1] : undefined;
		const sourceIndex = token < 0 ? indices[-token - 1]! : token;
		const previous = pieces.at(-1);
		const sameSource =
			previous !== undefined &&
			((source === undefined && previous.kind === "base") ||
				(source !== undefined && previous.kind === "insert" && previous.source === source));
		if (previous !== undefined && sameSource) {
			if (previous.length === 1) {
				const step = sourceIndex - previous.start;
				if (step === 1 || step === -1) {
					previous.step = step;
					previous.length = 2;
					continue;
				}
			} else if (previous.start + previous.step * previous.length === sourceIndex) {
				previous.length += 1;
				continue;
			}
		}
		pieces.push(
			source === undefined
				? { kind: "base", start: sourceIndex, length: 1, step: 1 }
				: { kind: "insert", source, start: sourceIndex, length: 1, step: 1 },
		);
	}
	return pieces;
}

function appendMergedPiece(pieces: Piece[], piece: Piece): void {
	const previous = pieces.at(-1);
	const sameSource =
		previous !== undefined &&
		previous.kind === piece.kind &&
		(previous.kind === "base" || previous.source === (piece as InsertPiece).source);
	if (previous !== undefined && sameSource && previous.length === 1 && piece.length === 1) {
		const step = piece.start - previous.start;
		if (step === 1 || step === -1) {
			previous.step = step;
			previous.length = 2;
			return;
		}
	}
	if (
		previous !== undefined &&
		sameSource &&
		previous.step === piece.step &&
		previous.start + previous.step * previous.length === piece.start
	) {
		previous.length += piece.length;
	} else pieces.push(piece);
}

function singletonPiece(piece: Piece, sourceIndex: number): Piece {
	return piece.kind === "base"
		? { kind: "base", start: sourceIndex, length: 1, step: 1 }
		: { kind: "insert", source: piece.source, start: sourceIndex, length: 1, step: 1 };
}

function clonePlacement(value: unknown): Stored {
	const proxyNode = isContainer(value) ? (Reflect.get(value, NODE) as OverlayNode | undefined) : undefined;
	return proxyNode === undefined ? cloneJson(value) : cloneNode(proxyNode);
}

function cloneJson(value: unknown): Stored {
	if (!isContainer(value)) return value as Primitive;
	if (Array.isArray(value)) return value.map(cloneJson);
	const result = Object.create(Object.getPrototypeOf(value)) as Record<string, JsonValue>;
	for (const key of Object.keys(value)) defineData(result, key, cloneJson((value as Record<string, unknown>)[key]));
	return result;
}

function cloneNode(node: OverlayNode): Container {
	assertReadable(node.context);
	if (Array.isArray(node.base)) {
		const overlay = arrayOverlay(node);
		const result: JsonValue[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
			}
		}
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(node.base)) as Record<string, JsonValue>;
	for (const key of ownKeys(node) as string[])
		defineData(result, key, cloneStored(objectValue(node, key), node.context));
	return result;
}

function cloneStored(value: Stored, context: OverlayContext): Stored {
	if (!isContainer(value)) return value;
	const node = context.rawNodes.get(value);
	return node === undefined ? cloneJson(value) : cloneNode(node);
}

function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function emitOperations(context: OverlayContext): Op[] {
	const operations: Op[] = [];
	const forcedFolds = new Map<OverlayNode, Path>();
	const emissionPaths = new Map<OverlayNode, Path>();
	const denseIndices = new Map<OverlayNode, DenseCandidates>();
	for (const node of context.dirty) {
		recordDenseArrayPosition(node, denseIndices);
		if (Array.isArray(node.base)) {
			const overlay = arrayOverlay(node);
			if (!overlay.structural && overlay.baseOverrides.size > 0) {
				let candidates = denseIndices.get(node);
				if (candidates === undefined) {
					candidates = { indices: [], bits: undefined, length: (node.base as JsonValue[]).length };
					denseIndices.set(node, candidates);
				}
				for (const index of overlay.baseOverrides.keys()) addDenseCandidate(candidates, index);
			}
		}
	}
	const denseRegions = new Map<OverlayNode, DenseRegion[]>();
	for (const [array, candidates] of denseIndices) {
		const path = resolvePath(array);
		if (path === undefined || path.some((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment))) {
			continue;
		}
		const regions = buildDenseRegions(candidates);
		if (regions.length > 0) denseRegions.set(array, regions);
	}
	for (const node of context.dirty) {
		const path = resolvePath(node);
		if (path === undefined) continue;
		node.applyDepth = path.length;
		if (hasCoveringDenseRegion(node, path, denseRegions)) continue;
		emissionPaths.set(node, path);
		if (!Array.isArray(node.base) && hasReservedMutation(node)) forcedFolds.set(node, path);
		const reservedAt = path.findIndex((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment));
		if (reservedAt >= 0) {
			let ancestor = node;
			for (let depth = path.length; depth > reservedAt; depth--) ancestor = ancestor.parent!;
			forcedFolds.set(ancestor, path.slice(0, reservedAt));
		}
	}
	for (const [node, path] of forcedFolds) emissionPaths.set(node, path);
	for (const node of denseRegions.keys()) {
		const path = resolvePath(node);
		if (path !== undefined && !hasCoveringDenseRegion(node, path, denseRegions)) emissionPaths.set(node, path);
	}
	let maxDepth = 0;
	for (const path of emissionPaths.values()) maxDepth = Math.max(maxDepth, path.length);
	const buckets: OverlayNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const [node, path] of emissionPaths) buckets[path.length]!.push(node);
	const folded = new Set<OverlayNode>();
	for (const bucket of buckets) {
		for (const node of bucket) {
			const path = emissionPaths.get(node)!;
			if (hasPlacementAncestor(node) || hasFoldedAncestor(node, folded)) continue;
			if (forcedFolds.has(node)) {
				emitSet(operations, path, cloneNode(node));
				folded.add(node);
				continue;
			}
			if (Array.isArray(node.base)) emitArrayOperations(node, path, operations, denseRegions.get(node));
			else emitObjectOperations(node, path, operations);
			if (operations.length > MAX_DELTA_OPERATIONS) {
				locatedDenseArray = undefined;
				return [["r", cloneNode(context.root!)]];
			}
		}
	}
	locatedDenseArray = undefined;
	return operations;
}

let locatedDenseArray: OverlayNode | undefined;
let locatedDenseIndex = 0;

function locateDenseArrayPosition(node: OverlayNode): boolean {
	let child = node;
	while (child.parent !== undefined) {
		const parent = child.parent;
		if (Array.isArray(parent.base)) {
			const overlay = arrayOverlay(parent);
			if (child.parentKind !== 1 || overlay.structural) return false;
			const sourceIndex = child.parentKey as number;
			const current = overlay.baseOverrides.has(sourceIndex)
				? overlay.baseOverrides.get(sourceIndex)
				: (parent.base as JsonValue[])[sourceIndex];
			if (current !== child.parentExpected) return false;
			locatedDenseArray = parent;
			locatedDenseIndex = sourceIndex;
			return true;
		}
		child = parent;
	}
	return false;
}

function hasCoveringDenseRegion(
	node: OverlayNode,
	path: Path,
	denseRegions: ReadonlyMap<OverlayNode, readonly DenseRegion[]>,
): boolean {
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
		const regions = denseRegions.get(parent);
		if (regions === undefined) continue;
		const parentPath = resolvePath(parent);
		if (parentPath === undefined || path.length <= parentPath.length) continue;
		let matches = true;
		for (let index = 0; index < parentPath.length; index++) {
			if (path[index] !== parentPath[index]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		const index = path[parentPath.length];
		if (typeof index === "number" && regionContaining(regions, index)) return true;
	}
	return false;
}

function addDenseCandidate(candidates: DenseCandidates, index: number): void {
	if (candidates.bits !== undefined) {
		candidates.bits[index] = 1;
		return;
	}
	candidates.indices.push(index);
	if (candidates.indices.length < 256) return;
	candidates.bits = new Uint8Array(candidates.length);
	for (const existing of candidates.indices) candidates.bits[existing] = 1;
	candidates.indices.length = 0;
}

function recordDenseArrayPosition(node: OverlayNode, groups: Map<OverlayNode, DenseCandidates>): void {
	if (!locateDenseArrayPosition(node)) return;
	let candidates = groups.get(locatedDenseArray!);
	if (candidates === undefined) {
		candidates = { indices: [], bits: undefined, length: (locatedDenseArray!.base as JsonValue[]).length };
		groups.set(locatedDenseArray!, candidates);
	}
	addDenseCandidate(candidates, locatedDenseIndex);
}

function buildDenseRegions(candidates: DenseCandidates): DenseRegion[] {
	if (candidates.bits === undefined) return [];
	const regions: DenseRegion[] = [];
	const bits = candidates.bits;
	for (let at = 0; at < bits.length; ) {
		while (at < bits.length && bits[at] === 0) at += 1;
		if (at === bits.length) break;
		const start = at;
		let end = at;
		let count = 0;
		let gap = 0;
		while (at < bits.length) {
			if (bits[at] !== 0) {
				count += 1;
				end = at;
				gap = 0;
			} else if (++gap > 1) break;
			at += 1;
		}
		const length = end - start + 1;
		if (count >= 256 && count * 2 >= length) regions.push({ start, length });
	}
	return regions;
}

function regionContaining(regions: readonly DenseRegion[], index: number): boolean {
	for (const region of regions) if (index >= region.start && index < region.start + region.length) return true;
	return false;
}

function hasReservedMutation(node: OverlayNode): boolean {
	if (node.writeKey !== undefined && RESERVED_SEGMENTS.has(node.writeKey)) return true;
	if (node.deleteKey !== undefined && RESERVED_SEGMENTS.has(node.deleteKey)) return true;
	for (const key of node.writes?.keys() ?? []) if (RESERVED_SEGMENTS.has(key)) return true;
	for (const key of node.deletes ?? []) if (RESERVED_SEGMENTS.has(key)) return true;
	return false;
}

function hasFoldedAncestor(node: OverlayNode, folded: ReadonlySet<OverlayNode>): boolean {
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) if (folded.has(parent)) return true;
	return false;
}

function hasPlacementAncestor(node: OverlayNode): boolean {
	for (let current: OverlayNode | undefined = node; current?.parent !== undefined; current = current.parent) {
		if (current.parentPlacement) return true;
	}
	return false;
}

function emitObjectWrite(node: OverlayNode, path: Path, operations: Op[], key: string, value: Stored): void {
	const nextPath = [...path, key] as unknown as NonEmptyPath;
	const before = Object.hasOwn(node.base, key) ? (node.base as Record<string, JsonValue>)[key] : undefined;
	emitChangedValue(operations, nextPath, before, cloneStored(value, node.context));
}

function emitObjectOperations(node: OverlayNode, path: Path, operations: Op[]): void {
	if (node.writeKey !== undefined) emitObjectWrite(node, path, operations, node.writeKey, node.writeValue!);
	for (const [key, value] of node.writes ?? []) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		emitObjectWrite(node, path, operations, key, value);
	}
	if (node.deleteKey !== undefined && Object.hasOwn(node.base, node.deleteKey)) {
		operations.push(["d", [...path, node.deleteKey] as unknown as NonEmptyPath]);
	}
	for (const key of node.deletes ?? []) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		if (Object.hasOwn(node.base, key)) operations.push(["d", [...path, key] as unknown as NonEmptyPath]);
	}
}

function buildArrayPlan(node: OverlayNode): ArrayPlan {
	const overlay = arrayOverlay(node);
	if (overlay.plan !== undefined) return overlay.plan;
	const base = node.base as JsonValue[];
	const pieces = piecesOf(overlay);
	const retained = new Uint8Array(base.length);
	const targetBase: number[] = [];
	for (const piece of pieces) {
		if (piece.kind !== "base") continue;
		for (let offset = 0; offset < piece.length; offset++) {
			const index = piece.start + piece.step * offset;
			retained[index] = 1;
			targetBase.push(index);
		}
	}
	const removeRuns: number[] = [];
	for (let end = base.length; end > 0; ) {
		if (retained[end - 1] !== 0) {
			end -= 1;
			continue;
		}
		let start = end - 1;
		while (start > 0 && retained[start - 1] === 0) start -= 1;
		removeRuns.push(start, end - start);
		end = start;
	}
	const retainedBase: number[] = [];
	for (let index = 0; index < retained.length; index++) if (retained[index] !== 0) retainedBase.push(index);
	let permutation: number[] | undefined;
	if (targetBase.some((value, index) => value !== retainedBase[index])) {
		const positions = new Map(retainedBase.map((value, index) => [value, index]));
		permutation = targetBase.map((value) => positions.get(value)!);
	}
	const insertRuns: number[] = [];
	let logicalIndex = 0;
	for (let pieceIndex = 0; pieceIndex < pieces.length; ) {
		const piece = pieces[pieceIndex]!;
		if (piece.kind === "base") {
			logicalIndex += piece.length;
			pieceIndex += 1;
			continue;
		}
		const startPiece = pieceIndex;
		while (pieceIndex < pieces.length && pieces[pieceIndex]!.kind === "insert") {
			logicalIndex += pieces[pieceIndex]!.length;
			pieceIndex += 1;
		}
		insertRuns.push(logicalIndex - rangeLength(pieces, startPiece, pieceIndex), startPiece, pieceIndex);
	}
	overlay.plan = { removeRuns, permutation, insertRuns };
	return overlay.plan;
}

function rangeLength(pieces: readonly Piece[], start: number, end: number): number {
	let length = 0;
	for (let index = start; index < end; index++) length += pieces[index]!.length;
	return length;
}

function emitArrayOperations(
	node: OverlayNode,
	path: Path,
	operations: Op[],
	denseRegions: readonly DenseRegion[] | undefined,
): void {
	const overlay = arrayOverlay(node);
	const base = node.base as JsonValue[];
	for (const region of denseRegions ?? []) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		operations.push(["p", [...path], region.start, region.length, cloneArrayRegion(node, region)]);
	}
	if (overlay.structural) {
		const plan = buildArrayPlan(node);
		for (let index = 0; index < plan.removeRuns.length; index += 2) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			operations.push(["p", [...path], plan.removeRuns[index]!, plan.removeRuns[index + 1]!, []]);
		}
		if (plan.permutation !== undefined) operations.push(["m", [...path], plan.permutation.slice()]);
		const pieces = piecesOf(overlay);
		for (let run = 0; run < plan.insertRuns.length; run += 3) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			const logicalIndex = plan.insertRuns[run]!;
			const items: JsonValue[] = [];
			for (let pieceIndex = plan.insertRuns[run + 1]!; pieceIndex < plan.insertRuns[run + 2]!; pieceIndex++) {
				const piece = pieces[pieceIndex]! as InsertPiece;
				for (let offset = 0; offset < piece.length; offset++) {
					const sourceIndex = piece.start + piece.step * offset;
					items.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
				}
			}
			operations.push(["p", [...path], logicalIndex, 0, items]);
		}
	}
	for (const [baseIndex, value] of overlay.baseOverrides) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		const index = findEntryIndex(overlay, 1, baseIndex, undefined);
		if (index === undefined || (denseRegions !== undefined && regionContaining(denseRegions, index))) continue;
		emitChangedValue(
			operations,
			[...path, index] as unknown as NonEmptyPath,
			base[baseIndex],
			cloneStored(value, node.context),
		);
	}
}

function cloneArrayRegion(node: OverlayNode, region: DenseRegion): JsonValue[] {
	const overlay = arrayOverlay(node);
	const result: JsonValue[] = [];
	for (let index = region.start; index < region.start + region.length; index++) {
		const piece = locatePiece(overlay, index);
		const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
		result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
	}
	return result;
}

function emitChangedValue(operations: Op[], path: NonEmptyPath, before: JsonValue | undefined, after: JsonValue): void {
	if (!isContainer(after) && before === after) return;
	if (isContainer(before) && isContainer(after) && equalTrustedJson(before, after)) return;
	if (typeof before === "string" && typeof after === "string") {
		if (after.startsWith(before)) {
			if (after.length > before.length) operations.push(["a", path, after.slice(before.length)]);
			return;
		}
		const shared = overlap(before, after, 65_536);
		if (shared > 0) {
			operations.push(["t", path, before.length - shared]);
			if (after.length > shared) operations.push(["a", path, after.slice(shared)]);
			return;
		}
	}
	operations.push(["s", path, after]);
}

function emitSet(operations: Op[], path: Path, value: JsonValue): void {
	if (path.length === 0) operations.push(["r", value]);
	else operations.push(["s", path as NonEmptyPath, value]);
}

function resolvePath(node: OverlayNode): Path | undefined {
	if (node.preparedPath !== undefined) return node.preparedPath;
	if (node.parent === undefined) {
		node.preparedPath = [];
		return node.preparedPath;
	}
	const parentPath = resolvePath(node.parent);
	if (parentPath === undefined) return undefined;
	if (node.parentKind === 0) {
		const key = node.parentKey as string;
		if (!objectHas(node.parent, key) || objectValue(node.parent, key) !== node.parentExpected) return undefined;
		node.preparedPath = [...parentPath, key];
		return node.preparedPath;
	}
	const overlay = arrayOverlay(node.parent);
	const index = findEntryIndex(overlay, node.parentKind, node.parentKey as number, node.parentSource);
	if (index === undefined) return undefined;
	const piece = locatePiece(overlay, index);
	if (entryValueAt(node.parent, piece, node.parentKey as number) !== node.parentExpected) return undefined;
	node.preparedPath = [...parentPath, index];
	return node.preparedPath;
}

function ensurePieceLocations(overlay: ArrayOverlay): void {
	if (overlay.baseLocations !== undefined) return;
	overlay.baseLocations = [];
	overlay.insertLocations = new Map();
	let logicalStart = 0;
	for (const piece of piecesOf(overlay)) {
		const last = piece.start + piece.step * (piece.length - 1);
		const location = {
			piece,
			logicalStart,
			minimum: Math.min(piece.start, last),
			maximum: Math.max(piece.start, last),
		};
		if (piece.kind === "base") overlay.baseLocations.push(location);
		else {
			let locations = overlay.insertLocations.get(piece.source);
			if (locations === undefined) {
				locations = [];
				overlay.insertLocations.set(piece.source, locations);
			}
			locations.push(location);
		}
		logicalStart += piece.length;
	}
	const byMinimum = (left: PieceLocation, right: PieceLocation): number => left.minimum - right.minimum;
	overlay.baseLocations.sort(byMinimum);
	for (const locations of overlay.insertLocations.values()) locations.sort(byMinimum);
}

function findEntryIndex(
	overlay: ArrayOverlay,
	kind: ParentKind,
	sourceIndex: number,
	source: InsertSource | undefined,
): number | undefined {
	ensurePieceLocations(overlay);
	const locations = kind === 1 ? overlay.baseLocations! : overlay.insertLocations!.get(source!);
	if (locations === undefined) return undefined;
	let low = 0;
	let high = locations.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (locations[middle]!.minimum <= sourceIndex) low = middle + 1;
		else high = middle;
	}
	const location = locations[low - 1];
	if (location === undefined || sourceIndex > location.maximum) return undefined;
	const offset = (sourceIndex - location.piece.start) / location.piece.step;
	return offset >= 0 && offset < location.piece.length ? location.logicalStart + offset : undefined;
}

function ensureOperations(context: OverlayContext): Op[] {
	if (context.ops !== undefined) return context.ops;
	assertReadable(context);
	if (context.replacement) {
		const base = context.tracker.deref()?.replacementBase(context);
		context.replacementNoop =
			base !== undefined && equalTrustedJson(base as unknown as JsonValue, context.root!.base as JsonValue);
		context.ops = context.replacementNoop ? [] : [["r", cloneNode(context.root!)]];
	} else context.ops = emitOperations(context);
	return context.ops;
}

function equalTrustedJson(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const other = right as JsonValue[];
		if (left.length !== other.length) return false;
		for (let index = 0; index < left.length; index++)
			if (!equalTrustedJson(left[index]!, other[index]!)) return false;
		return true;
	}
	const other = right as Record<string, JsonValue>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(other).length) return false;
	for (const key of keys) if (!Object.hasOwn(other, key) || !equalTrustedJson(left[key]!, other[key]!)) return false;
	return true;
}

function applyOverlay(context: OverlayContext): void {
	let maxDepth = 0;
	for (const node of context.dirty) if (node.applyDepth !== undefined) maxDepth = Math.max(maxDepth, node.applyDepth);
	const buckets: OverlayNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const node of context.dirty) if (node.applyDepth !== undefined) buckets[node.applyDepth]!.push(node);
	for (let depth = buckets.length - 1; depth >= 0; depth--) {
		for (const node of buckets[depth]!) {
			if (Array.isArray(node.base)) applyArrayNode(node);
			else applyObjectNode(node);
		}
	}
}

function applyObjectNode(node: OverlayNode): void {
	const target = node.base as Record<string, JsonValue>;
	if (node.deleteKey !== undefined) Reflect.deleteProperty(target, node.deleteKey);
	for (const key of node.deletes ?? []) Reflect.deleteProperty(target, key);
	for (const key of node.readded ?? []) Reflect.deleteProperty(target, key);
	if (node.writeKey !== undefined) applyObjectWrite(target, node, node.writeKey, node.writeValue!);
	for (const [key, value] of node.writes ?? []) applyObjectWrite(target, node, key, value);
}

function applyObjectWrite(target: Record<string, JsonValue>, node: OverlayNode, key: string, value: JsonValue): void {
	if (Object.hasOwn(target, key) && !node.readded?.has(key)) {
		const current = target[key]!;
		if (isContainer(current) && isContainer(value) && equalTrustedJson(current, value)) return;
		target[key] = value;
	} else defineData(target, key, value);
}

function applyArrayNode(node: OverlayNode): void {
	const target = node.base as JsonValue[];
	const overlay = arrayOverlay(node);
	if (overlay.structural) {
		const plan = buildArrayPlan(node);
		for (let index = 0; index < plan.removeRuns.length; index += 2) {
			target.splice(plan.removeRuns[index]!, plan.removeRuns[index + 1]!);
		}
		if (plan.permutation !== undefined) permuteInPlace(target, plan.permutation);
		const pieces = piecesOf(overlay);
		for (let run = 0; run < plan.insertRuns.length; run += 3) {
			const items: JsonValue[] = [];
			for (let pieceIndex = plan.insertRuns[run + 1]!; pieceIndex < plan.insertRuns[run + 2]!; pieceIndex++) {
				const piece = pieces[pieceIndex]! as InsertPiece;
				for (let offset = 0; offset < piece.length; offset++) {
					const sourceIndex = piece.start + piece.step * offset;
					items.push(entryValueAt(node, piece, sourceIndex));
				}
			}
			insertChunked(target, plan.insertRuns[run]!, items);
		}
	}
	for (const [baseIndex, value] of overlay.baseOverrides) {
		const index = findEntryIndex(overlay, 1, baseIndex, undefined);
		if (index === undefined) continue;
		const current = target[index]!;
		if (isContainer(current) && isContainer(value) && equalTrustedJson(current, value)) continue;
		target[index] = value;
	}
}

function permuteInPlace(values: JsonValue[], permutation: readonly number[]): void {
	const visited = new Uint8Array(permutation.length);
	for (let start = 0; start < permutation.length; start++) {
		if (visited[start] !== 0) continue;
		let current = start;
		const saved = values[start]!;
		while (true) {
			visited[current] = 1;
			const source = permutation[current]!;
			if (source === start) {
				values[current] = saved;
				break;
			}
			values[current] = values[source]!;
			current = source;
		}
	}
}

function insertChunked(target: JsonValue[], index: number, items: JsonValue[]): void {
	for (let offset = 0; offset < items.length; offset += MAX_SPLICE_CHUNK) {
		target.splice(index + offset, 0, ...items.slice(offset, offset + MAX_SPLICE_CHUNK));
	}
}

function abortContext(context: OverlayContext): void {
	if (
		context.status === "aborted" ||
		context.status === "consumed" ||
		context.status === "stale" ||
		context.status === "faulted"
	)
		return;
	context.status = "aborted";
	clearContext(context);
}

function clearContext(context: OverlayContext): void {
	context.tracker.deref()?.releaseContext(context);
	if (locatedDenseArray?.context === context) locatedDenseArray = undefined;
	for (const node of context.nodes) {
		Reflect.deleteProperty(node.target, NODE);
		node.writes?.clear();
		node.deletes?.clear();
		node.readded?.clear();
		node.array?.pieces?.splice(0);
		if (node.array !== undefined) {
			node.array.root = undefined;
			node.array.baseLocations = undefined;
			node.array.insertLocations = undefined;
		}
		node.array?.baseOverrides.clear();
		node.array?.insertOverrides.clear();
		node.base = RELEASED;
		node.parent = undefined;
		node.parentSource = undefined;
		node.parentExpected = undefined;
		node.target = RELEASED;
		node.proxy = RELEASED;
		node.writeKey = undefined;
		node.writeValue = undefined;
		node.writes = undefined;
		node.deleteKey = undefined;
		node.deletes = undefined;
		node.readded = undefined;
		node.array = undefined;
		node.preparedPath = undefined;
		node.applyDepth = undefined;
	}
	context.dirty.length = 0;
	context.nodes.length = 0;
	context.rawNodes = new WeakMap();
	context.root = undefined;
	context.baseValue = undefined;
}

function isContainer(value: unknown): value is Container {
	return value !== null && typeof value === "object";
}
