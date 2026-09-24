import type { Context, JsonValue } from "@earendil-works/chord";
import { applyImmutable } from "@earendil-works/chord/delta";
import type {
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionRecord,
	TaskQuery,
	TaskRecord,
} from "../types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TaskStatus = StoredTask["state"]["status"];
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentRevision = DocumentContent & { readonly seq: Seq };
type StoredDocumentState = {
	record: DocumentRecord;
	revisions: DocumentRevision[];
};
type DocumentAction = {
	create?: DocumentCreate;
	content?: DocumentContent;
	retire: boolean;
};

type DocumentAddressIndex = {
	ids: Id[];
	currentId?: Id;
};

type State = {
	conversations: Map<Id, ConversationRecord>;
	conversationIds: Id[];
	entries: Map<Id, EntryRecord>;
	entryIds: Map<Id, Id[]>;
	headEntryIds: Map<Id, Id[]>;
	entryCommitSeqs: Map<Id, Seq>;
	tasks: Map<Id, StoredTask>;
	taskIds: Id[];
	taskIdsByStatus: Record<TaskStatus, Id[]>;
	submissions: Map<Id, SubmissionRecord>;
	submissionIdsByRequest: Map<Id, Map<string, Id>>;
	documents: Map<Id, StoredDocumentState>;
	documentAddresses: Map<string, DocumentAddressIndex>;
	documentIdsByScope: Map<string, Id[]>;
};

const clone = <T>(value: T): T => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	const source = value as Record<string, unknown>;
	const nullPrototype = Object.getPrototypeOf(value) === null;
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const copied = clone(source[key]);
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			result[key] = copied;
		}
	}
	return result as T;
};

const freeze = <T>(value: T): T => {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
};

const cursorId = (cursor: Readonly<Record<string, JsonValue>> | undefined): Id | undefined =>
	cursor?.after as Id | undefined;

const lowerBound = (ids: readonly Id[], target: Id): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const upperBound = (ids: readonly Id[], target: Id): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] <= target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const insertSorted = (ids: Id[], id: Id): void => {
	if (ids.length === 0 || ids[ids.length - 1] < id) ids.push(id);
	else ids.splice(lowerBound(ids, id), 0, id);
};

const removeSorted = (ids: Id[], id: Id): void => {
	const index = lowerBound(ids, id);
	if (ids[index] === id) ids.splice(index, 1);
};

const scopeKey = (scope: DocumentRecord["scope"]): string => {
	switch (scope.kind) {
		case "session":
			return JSON.stringify(["session"]);
		case "conversation":
			return JSON.stringify(["conversation", scope.conversationId]);
		case "task":
			return JSON.stringify(["task", scope.taskId]);
	}
};

const addressKey = (address: DocumentAddress): string =>
	JSON.stringify([
		address.kind,
		scopeKey(address.scope),
		address.key === undefined ? ["singleton"] : ["family", address.key],
	]);

const recordAddressKey = (record: DocumentRecord | DocumentCreate): string =>
	addressKey({ kind: record.kind, scope: record.scope, key: record.key });

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const tableContaining = (state: State, id: Id): TableName | undefined => {
	if (state.conversations.has(id)) return "conversation";
	if (state.entries.has(id)) return "entry";
	if (state.tasks.has(id)) return "task";
	if (state.submissions.has(id)) return "submission";
	if (state.documents.has(id)) return "document";
	return undefined;
};

const page = <T extends { readonly id: Id }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items: clone(items) };
	return { items: clone(items), next: { after: items.at(-1)!.id } };
};

/** A fully validated, detached state mutation whose application performs no fallible preparation. */
export interface PreparedMemoryCommit {
	readonly seq: Seq;
	/** Deeply frozen detached writes for persistence. */
	readonly writes: readonly StorageWrite[];
	apply(): Seq;
}

/**
 * Detached in-memory reference implementation of `Storage`.
 *
 * Reads and retained writes are cloned intentionally to match the ownership boundary
 * of serialization-backed stores. This is backend conformance, not validation.
 */
export class MemoryStorage implements Storage {
	private readonly state: State = {
		conversations: new Map(),
		conversationIds: [],
		entries: new Map(),
		entryIds: new Map(),
		headEntryIds: new Map(),
		entryCommitSeqs: new Map(),
		tasks: new Map(),
		taskIds: [],
		taskIdsByStatus: { pending: [], running: [], terminal: [] },
		submissions: new Map(),
		submissionIdsByRequest: new Map(),
		documents: new Map(),
		documentAddresses: new Map(),
		documentIdsByScope: new Map(),
	};
	private nextId = 2;
	private nextSeq = 1;
	private closed = false;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		return this.prepareCommit(writes).apply();
	}

	/** Validate and detach one commit without changing observable state. */
	prepareCommit(writes: readonly StorageWrite[], seq: Seq = this.nextSeq): PreparedMemoryCommit {
		this.assertOpen();
		if (!Number.isSafeInteger(seq) || seq < this.nextSeq) {
			throw new Error(`Commit sequence ${seq} does not strictly increase`);
		}
		const detachedWrites = freeze(writes.map((write) => clone(write)));
		this.checkGlobalIds(detachedWrites);
		const documentActions = this.prepareDocumentActions(detachedWrites);
		this.checkDocumentActions(documentActions);
		let applied = false;
		return {
			seq,
			writes: detachedWrites,
			apply: () => {
				if (!applied) {
					applied = true;
					this.applyPreparedCommit(detachedWrites, documentActions, seq);
				}
				return seq;
			},
		};
	}

	private applyPreparedCommit(
		prepared: readonly StorageWrite[],
		documentActions: ReadonlyMap<Id, DocumentAction>,
		seq: Seq,
	): Seq {
		for (const write of prepared) {
			switch (write.type) {
				case "conversation":
					this.state.conversations.set(write.value.id, write.value);
					insertSorted(this.state.conversationIds, write.value.id);
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				case "entry": {
					this.state.entries.set(write.value.id, write.value);
					this.state.entryCommitSeqs.set(write.value.id, seq);
					let ids = this.state.entryIds.get(write.value.conversationId);
					if (ids === undefined) {
						ids = [];
						this.state.entryIds.set(write.value.conversationId, ids);
					}
					insertSorted(ids, write.value.id);
					if (write.value.head !== undefined) {
						let headIds = this.state.headEntryIds.get(write.value.conversationId);
						if (headIds === undefined) {
							headIds = [];
							this.state.headEntryIds.set(write.value.conversationId, headIds);
						}
						insertSorted(headIds, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "task": {
					const previous = this.state.tasks.get(write.value.id);
					if (previous === undefined) {
						insertSorted(this.state.taskIds, write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					} else if (previous.state.status !== write.value.state.status) {
						removeSorted(this.state.taskIdsByStatus[previous.state.status], write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					}
					this.state.tasks.set(write.value.id, write.value);
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "submission": {
					const previous = this.state.submissions.get(write.value.id);
					if (previous?.requestId !== undefined) {
						const previousRequests = this.state.submissionIdsByRequest.get(previous.conversationId);
						if (previousRequests?.get(previous.requestId) === write.value.id) {
							previousRequests.delete(previous.requestId);
							if (previousRequests.size === 0) this.state.submissionIdsByRequest.delete(previous.conversationId);
						}
					}
					this.state.submissions.set(write.value.id, write.value);
					if (write.value.requestId !== undefined) {
						let requests = this.state.submissionIdsByRequest.get(write.value.conversationId);
						if (requests === undefined) {
							requests = new Map();
							this.state.submissionIdsByRequest.set(write.value.conversationId, requests);
						}
						requests.set(write.value.requestId, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "document.create":
				case "document.change":
				case "document.retire":
					break;
			}
		}

		this.applyDocumentActions(documentActions, seq);
		this.nextSeq = seq + 1;
		return seq;
	}

	async mintId(): Promise<Id> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++;
	}

	async conversation(id: Id, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const start = after === undefined ? 0 : upperBound(this.state.conversationIds, after);
		const values = this.state.conversationIds
			.slice(start, start + limit + 1)
			.map((id) => this.state.conversations.get(id)!);
		return page(values, limit);
	}

	async entry(
		id: Id,
		_context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		const entry = this.state.entries.get(id);
		if (entry === undefined) return undefined;
		return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
	}

	async findLatestHeadMarker(
		conversationId: Id,
		atOrBeforeEntryId: Id | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: Id }) | undefined> {
		this.assertOpen();
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
		while (true) {
			const ids = this.state.headEntryIds.get(currentId) ?? [];
			const index = upperBound(ids, upperEntryId) - 1;
			if (index >= 0) {
				const entry = this.state.entries.get(ids[index])!;
				return clone({ ...entry, head: entry.head! });
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) return undefined;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			currentId = conversation.parent.conversationId;
		}
	}

	async scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const maxEntryId =
			after === undefined ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
		const visible: EntryRecord[] = [];
		for (const entry of this.visibleEntries(query.conversationId, query.minEntryId, maxEntryId)) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		return page(visible, limit);
	}

	async task(id: Id, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const ids = query.status === undefined ? this.state.taskIds : this.state.taskIdsByStatus[query.status];
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: StoredTask[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const value = this.state.tasks.get(ids[index])!;
			if (query.conversationId !== undefined && value.conversationId !== query.conversationId) continue;
			if (query.kind !== undefined && value.kind !== query.kind) continue;
			if (query.abortRequested !== undefined && value.abortRequested !== query.abortRequested) continue;
			if (query.background !== undefined && value.background !== query.background) continue;
			values.push(value);
		}
		return page(values, limit);
	}

	async submission(id: Id, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const value = this.state.submissions.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async submissionByRequest(
		conversationId: Id,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const id = this.state.submissionIdsByRequest.get(conversationId)?.get(requestId);
		if (id === undefined) return undefined;
		return clone(this.state.submissions.get(id)!);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const index = this.state.documentAddresses.get(addressKey(address));
		if (at === "current") {
			return index?.currentId === undefined ? undefined : clone(this.state.documents.get(index.currentId)!.record);
		}
		for (const id of index?.ids ?? []) {
			const record = this.state.documents.get(id)!.record;
			if (isAliveAt(record, at)) return clone(record);
		}
		return undefined;
	}

	async document(id: Id, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		const stored = this.state.documents.get(id);
		if (stored === undefined) return undefined;
		if (at !== "current" && isCurrentOnly(stored.record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(stored.record, at)) return undefined;
		const revisions = at === "current" ? stored.revisions : stored.revisions.filter((revision) => revision.seq <= at);
		let baseIndex = revisions.length - 1;
		while (baseIndex >= 0 && revisions[baseIndex]!.kind !== "base") baseIndex--;
		const base = revisions[baseIndex];
		if (base?.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		let value = base.value;
		for (let index = baseIndex + 1; index < revisions.length; index++) {
			const revision = revisions[index]!;
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = applyImmutable(value, revision.ops) as JsonObject;
		}
		return { record: clone(stored.record), version: base.version, value: clone(value) };
	}

	async scanDocuments(
		query: DocumentQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const ids = this.state.documentIdsByScope.get(scopeKey(query.scope)) ?? [];
		const after = cursorId(cursor);
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: DocumentRecord[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const record = this.state.documents.get(ids[index]!)!.record;
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (isAliveAt(record, query.at)) values.push(record);
		}
		return page(values, limit);
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private *visibleEntries(
		conversationId: Id,
		minEntryId = Number.NEGATIVE_INFINITY,
		maxEntryId = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = maxEntryId;
		while (true) {
			const ids = this.state.entryIds.get(currentId) ?? [];
			for (let index = upperBound(ids, upperEntryId) - 1; index >= 0; index--) {
				const id = ids[index];
				if (id < minEntryId) break;
				yield this.state.entries.get(id)!;
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
	}

	private checkGlobalIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const table: TableName = write.type === "document.create" ? "document" : write.type;
			const id = write.type === "document.create" ? write.record.id : write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<Id, DocumentAction> {
		const actions = new Map<Id, DocumentAction>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
				continue;
			}
			const id = write.type === "document.create" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.change":
					if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private checkDocumentActions(actions: ReadonlyMap<Id, DocumentAction>): void {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			const existing = this.state.documents.get(id);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.create !== undefined && action.content?.kind !== "base") {
				throw new Error(`Document ${id} creation requires a base`);
			}
			const previous = existing?.revisions.at(-1);
			if (action.content?.kind === "delta") {
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}

			const key = action.create === undefined ? recordAddressKey(existing!.record) : recordAddressKey(action.create);
			const currentId = this.state.documentAddresses.get(key)?.currentId;
			let live = liveCounts.get(key);
			if (live === undefined) live = currentId === undefined ? 0 : 1;
			if (action.retire && currentId === id) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}

		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error(`Document address already has a current incarnation`);
		}
	}

	private applyDocumentActions(actions: ReadonlyMap<Id, DocumentAction>, seq: Seq): void {
		for (const [id, action] of actions) {
			let stored = this.state.documents.get(id);
			if (action.create !== undefined) {
				const record: DocumentRecord = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				stored = { record, revisions: [{ ...action.content!, seq }] };
				this.state.documents.set(id, stored);

				const key = recordAddressKey(record);
				let address = this.state.documentAddresses.get(key);
				if (address === undefined) {
					address = { ids: [] };
					this.state.documentAddresses.set(key, address);
				}
				insertSorted(address.ids, id);

				let scopeIds = this.state.documentIdsByScope.get(scopeKey(record.scope));
				if (scopeIds === undefined) {
					scopeIds = [];
					this.state.documentIdsByScope.set(scopeKey(record.scope), scopeIds);
				}
				insertSorted(scopeIds, id);
				this.nextId = Math.max(this.nextId, id + 1);
			} else if (action.content !== undefined) {
				const revision = { ...action.content, seq } as DocumentRevision;
				if (revision.kind === "base" && isCurrentOnly(stored!.record)) stored!.revisions = [revision];
				else stored!.revisions.push(revision);
			}

			if (action.retire && action.create === undefined) stored!.record = { ...stored!.record, retiredAt: seq };
			if (action.retire && isCurrentOnly(stored!.record)) stored!.revisions = [];
			if (action.create !== undefined || action.retire) {
				const address = this.state.documentAddresses.get(recordAddressKey(stored!.record))!;
				if (action.retire && address.currentId === id) delete address.currentId;
				if (action.create !== undefined && !action.retire) address.currentId = id;
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
