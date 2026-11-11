/**
 * Portable session interchange.
 *
 * A portable session is native-shaped JSONL v3 with a `portable: 1` header marker. Export writes
 * the active branch built field by field from an allowlist and reports everything it leaves out.
 * Import accepts exactly that contract and writes a new native session for the destination cwd.
 * See docs/session-format.md "Portable Sessions".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TObject, type TProperties, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { resolvePath } from "../utils/paths.ts";
import {
	assertValidSessionId,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.ts";
import { isVirtualModel } from "./virtual-models.ts";

export const PORTABLE_SESSION_MARKER = 1;

export interface PortableSessionDiagnostic {
	code: "excluded_field" | "excluded_entry" | "inactive_branch" | "normalized_value" | "remapped_reference";
	/** Absent for header and branch-level items. */
	entryId?: string;
	/** Portable field name, e.g. "header.cwd", "assistant.content.thinkingSignature", "custom". */
	field: string;
	message: string;
}

export interface PortableSessionSerialization {
	jsonl: string;
	diagnostics: PortableSessionDiagnostic[];
}

export interface PortableSessionExportResult {
	path: string;
	diagnostics: PortableSessionDiagnostic[];
}

export type PortableSessionSource = Pick<SessionManager, "getHeader" | "getBranch" | "getEntries" | "getSessionId">;

export type PortableSessionErrorCode =
	| "invalid_json"
	| "missing_header"
	| "not_portable"
	| "invalid_header"
	| "duplicate_header"
	| "invalid_entry"
	| "duplicate_id"
	| "invalid_parent"
	| "unresolved_reference";

/** An import was rejected before anything was written or the active session changed. */
export class SessionImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionImportError";
	}
}

/** Thrown when a file does not match the portable session contract. */
export class PortableSessionError extends SessionImportError {
	readonly code: PortableSessionErrorCode;
	/** Physical 1-based line number, when the error belongs to one record. */
	readonly line?: number;
	/** JSON path inside the record, e.g. "$.message.content[0].thinkingSignature". */
	readonly path?: string;

	constructor(
		code: PortableSessionErrorCode,
		detail: string,
		location: { source: string; line?: number; path?: string },
	) {
		const where = [location.line !== undefined ? `line ${location.line}` : undefined, location.path]
			.filter((part) => part !== undefined)
			.join(", ");
		super(`Invalid portable session ${location.source}${where ? ` (${where})` : ""}: ${detail}`);
		this.name = "PortableSessionError";
		this.code = code;
		this.line = location.line;
		this.path = location.path;
	}
}

/** Thrown when an import would create a second session file with an existing session id. */
export class SessionImportIdConflictError extends SessionImportError {
	readonly sessionId: string;
	readonly existingPath: string;

	constructor(sessionId: string, existingPath: string) {
		super(`Session ${sessionId} already exists: ${existingPath}`);
		this.name = "SessionImportIdConflictError";
		this.sessionId = sessionId;
		this.existingPath = existingPath;
	}
}

/** Thrown when an import references a file path that does not exist. */
export class SessionImportFileNotFoundError extends SessionImportError {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

// ============================================================================
// Contract
// ============================================================================

function strictObject<T extends TProperties>(properties: T): TObject<T> {
	return Type.Object(properties, { additionalProperties: false });
}

const UsageSchema = strictObject({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cacheWrite1h: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: strictObject({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"];

const HeaderSchema = strictObject({
	type: Type.Literal("session"),
	version: Type.Literal(CURRENT_SESSION_VERSION),
	portable: Type.Literal(PORTABLE_SESSION_MARKER),
	id: Type.String(),
	timestamp: Type.String(),
});

const BLOCKS = {
	text: { keys: ["type", "text"], schema: strictObject({ type: Type.Literal("text"), text: Type.String() }) },
	image: {
		keys: ["type", "mimeType", "data"],
		schema: strictObject({ type: Type.Literal("image"), mimeType: Type.String(), data: Type.String() }),
	},
	thinking: {
		keys: ["type", "thinking"],
		schema: strictObject({ type: Type.Literal("thinking"), thinking: Type.String() }),
	},
	toolCall: {
		keys: ["type", "id", "name", "arguments", "namespace"],
		schema: strictObject({
			type: Type.Literal("toolCall"),
			id: Type.String(),
			name: Type.String(),
			arguments: Type.Record(Type.String(), Type.Unknown()),
			namespace: Type.Optional(Type.String()),
		}),
	},
} as const;
type BlockType = keyof typeof BLOCKS;

/** Owners of model-visible content, keyed by message role or entry type. */
type ContentOwner = "user" | "assistant" | "toolResult" | "custom_message";
const CONTENT_RULES: Record<ContentOwner, { blocks: readonly BlockType[]; allowString: boolean }> = {
	user: { blocks: ["text", "image"], allowString: true },
	assistant: { blocks: ["text", "thinking", "toolCall"], allowString: false },
	toolResult: { blocks: ["text", "image"], allowString: false },
	custom_message: { blocks: ["text", "image"], allowString: true },
};

const SETTLED_STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"];

// `content` is validated per owner by checkContent(), so object schemas leave it open.
const MESSAGES = {
	user: {
		keys: ["role", "content", "timestamp"],
		schema: strictObject({ role: Type.Literal("user"), content: Type.Unknown(), timestamp: Type.Number() }),
	},
	assistant: {
		keys: [
			"role",
			"content",
			"api",
			"provider",
			"model",
			"responseModel",
			"providerThinkingLevel",
			"usage",
			"stopReason",
			"endTurn",
			"timestamp",
		],
		schema: strictObject({
			role: Type.Literal("assistant"),
			content: Type.Unknown(),
			api: Type.String(),
			provider: Type.String(),
			model: Type.String(),
			responseModel: Type.Optional(Type.String()),
			providerThinkingLevel: Type.Optional(Type.String()),
			usage: UsageSchema,
			stopReason: Type.Union(SETTLED_STOP_REASONS.map((reason) => Type.Literal(reason))),
			endTurn: Type.Optional(Type.Boolean()),
			timestamp: Type.Number(),
		}),
	},
	toolResult: {
		keys: ["role", "toolCallId", "toolName", "content", "isError", "usage", "timestamp"],
		schema: strictObject({
			role: Type.Literal("toolResult"),
			toolCallId: Type.String(),
			toolName: Type.String(),
			content: Type.Unknown(),
			isError: Type.Boolean(),
			usage: Type.Optional(UsageSchema),
			timestamp: Type.Number(),
		}),
	},
	bashExecution: {
		keys: ["role", "command", "output", "exitCode", "cancelled", "truncated", "excludeFromContext", "timestamp"],
		schema: strictObject({
			role: Type.Literal("bashExecution"),
			command: Type.String(),
			output: Type.String(),
			exitCode: Type.Optional(Type.Number()),
			cancelled: Type.Boolean(),
			truncated: Type.Boolean(),
			excludeFromContext: Type.Optional(Type.Boolean()),
			timestamp: Type.Number(),
		}),
	},
} as const;

const BASE_KEYS = ["type", "id", "parentId", "timestamp"];

function entrySchema<T extends TProperties>(type: string, properties: T) {
	return strictObject({
		type: Type.Literal(type),
		id: Type.String({ minLength: 1 }),
		parentId: Type.Union([Type.String(), Type.Null()]),
		timestamp: Type.String(),
		...properties,
	});
}

// `message`, `content`, and `replacement` are validated per role/owner, so entry schemas leave them open.
const ENTRIES = {
	message: { keys: ["message"], schema: entrySchema("message", { message: Type.Unknown() }) },
	compaction: {
		keys: ["summary", "firstKeptEntryId", "tokensBefore", "usage", "fromHook"],
		schema: entrySchema("compaction", {
			summary: Type.String(),
			firstKeptEntryId: Type.String(),
			tokensBefore: Type.Number(),
			usage: Type.Optional(UsageSchema),
			fromHook: Type.Optional(Type.Boolean()),
		}),
	},
	branch_summary: {
		keys: ["fromId", "summary", "usage", "fromHook"],
		schema: entrySchema("branch_summary", {
			fromId: Type.String(),
			summary: Type.String(),
			usage: Type.Optional(UsageSchema),
			fromHook: Type.Optional(Type.Boolean()),
		}),
	},
	custom_message: {
		keys: ["customType", "content", "display"],
		schema: entrySchema("custom_message", {
			customType: Type.String(),
			content: Type.Unknown(),
			display: Type.Boolean(),
		}),
	},
	context_edit: {
		keys: ["targetId", "replacement"],
		schema: entrySchema("context_edit", {
			targetId: Type.String(),
			replacement: Type.Union([Type.Null(), strictObject({ content: Type.Unknown() })]),
		}),
	},
	model_change: {
		keys: ["provider", "modelId"],
		schema: entrySchema("model_change", { provider: Type.String(), modelId: Type.String() }),
	},
	thinking_level_change: {
		keys: ["thinkingLevel"],
		schema: entrySchema("thinking_level_change", { thinkingLevel: Type.String() }),
	},
	usage: {
		keys: ["kind", "provider", "model", "usage"],
		schema: entrySchema("usage", {
			kind: Type.String(),
			provider: Type.String(),
			model: Type.String(),
			usage: UsageSchema,
		}),
	},
	session_info: { keys: ["name"], schema: entrySchema("session_info", { name: Type.Optional(Type.String()) }) },
	label: {
		keys: ["targetId", "label"],
		schema: entrySchema("label", { targetId: Type.String(), label: Type.Optional(Type.String()) }),
	},
} as const;
type PortableEntryType = keyof typeof ENTRIES;

const EXCLUSION_REASONS: Record<string, string> = {
	cwd: "machine-specific path",
	parentSession: "machine-specific path",
	fullOutputPath: "machine-specific path",
	textSignature: "provider replay signature",
	thinkingSignature: "provider replay signature",
	thoughtSignature: "provider replay signature",
	responseId: "provider response handle",
	deferred: "provider response handle",
	diagnostics: "provider runtime diagnostics",
	errorMessage: "free-form provider text",
	rawStopReason: "free-form provider text",
	note: "free-form usage text",
	details: "untyped extension data",
	systemMessage: "source prompt and tool state",
};
const UNSUPPORTED_FIELD_REASON = "not part of the portable session contract";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKey<T extends object>(table: T, key: unknown): key is keyof T {
	return typeof key === "string" && Object.hasOwn(table, key);
}

// ============================================================================
// Export
// ============================================================================

/** Rebuild a projected object in allowlist order after fields were filled in. */
function ordered(record: JsonRecord, keys: readonly string[]): JsonRecord {
	return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

const NORMALIZED_CONTENT_REASON = "normalized to an array of content blocks";

class Projection {
	readonly diagnostics: PortableSessionDiagnostic[] = [];
	entryId: string | undefined;

	report(code: PortableSessionDiagnostic["code"], field: string, message: string): void {
		this.diagnostics.push({ code, ...(this.entryId !== undefined ? { entryId: this.entryId } : {}), field, message });
	}

	/** Copy allowlisted keys in allowlist order and report every other defined key. */
	pick(source: JsonRecord, keep: readonly string[], field: string, ignore: readonly string[] = []): JsonRecord {
		const result: JsonRecord = {};
		for (const key of keep) {
			if (source[key] !== undefined) result[key] = source[key];
		}
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined || keep.includes(key) || ignore.includes(key)) continue;
			this.report("excluded_field", `${field}.${key}`, EXCLUSION_REASONS[key] ?? UNSUPPORTED_FIELD_REASON);
		}
		return result;
	}

	usage(value: unknown, field: string): unknown {
		if (!isRecord(value)) return value;
		const usage = this.pick(value, USAGE_KEYS, field);
		if (isRecord(usage.cost)) usage.cost = this.pick(usage.cost, COST_KEYS, `${field}.cost`);
		return usage;
	}

	content(value: unknown, owner: ContentOwner, field: string): unknown {
		const rule = CONTENT_RULES[owner];
		if (typeof value === "string" && rule.allowString) return value;
		// Native loading and the context builder treat missing content as no blocks and string
		// content on block-only roles as one text block, so both keep their meaning; report them.
		if (value === null || value === undefined) {
			this.report("normalized_value", `${field}.content`, NORMALIZED_CONTENT_REASON);
			return [];
		}
		if (typeof value === "string") {
			this.report("normalized_value", `${field}.content`, NORMALIZED_CONTENT_REASON);
			return [{ type: "text", text: value }];
		}
		if (!Array.isArray(value)) return value;
		const blocks: JsonRecord[] = [];
		for (const block of value) {
			const type = isRecord(block) ? block.type : undefined;
			if (!isRecord(block) || !hasKey(BLOCKS, type) || !rule.blocks.includes(type)) {
				this.report("excluded_field", `${field}.content[${String(type)}]`, "unsupported content block");
				continue;
			}
			if (type === "thinking" && block.redacted === true) {
				this.report("excluded_field", `${field}.content[thinking:redacted]`, "provider-encrypted reasoning");
				continue;
			}
			blocks.push(this.pick(block, BLOCKS[type].keys, `${field}.content`, type === "thinking" ? ["redacted"] : []));
		}
		return blocks;
	}

	message(value: unknown): JsonRecord | undefined {
		const role = isRecord(value) ? value.role : undefined;
		if (!isRecord(value) || !hasKey(MESSAGES, role)) {
			const reason = role === "system" ? "source prompt and tool state" : "unsupported message role";
			this.report("excluded_entry", `message.${String(role)}`, reason);
			return undefined;
		}
		if (role === "assistant" && !SETTLED_STOP_REASONS.includes(value.stopReason as string)) {
			this.report("excluded_entry", "message.assistant", "unsettled assistant turn (pending or deferred)");
			return undefined;
		}
		const message = this.pick(value, MESSAGES[role].keys, role);
		if (role !== "bashExecution") message.content = this.content(value.content, role, role);
		if (message.usage !== undefined) message.usage = this.usage(message.usage, `${role}.usage`);
		return ordered(message, MESSAGES[role].keys);
	}
}

/** Content owner of an exported entry, used to project and validate context edits that target it. */
function contentOwnerOf(entry: JsonRecord): ContentOwner | undefined {
	if (entry.type === "custom_message") return "custom_message";
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const role = entry.message.role;
	return role === "user" || role === "assistant" || role === "toolResult" ? role : undefined;
}

/**
 * Serialize the active branch of a session as portable JSONL.
 *
 * Entries keep their ids, order, and timestamps. Excluded entries are removed and parents are
 * re-chained. Every excluded or changed value is reported in the returned diagnostics.
 */
export function serializePortableSession(sessionManager: PortableSessionSource): PortableSessionSerialization {
	const projection = new Projection();
	const sourceHeader = (sessionManager.getHeader() ?? {}) as unknown as JsonRecord;
	projection.pick(sourceHeader, ["type", "version", "id", "timestamp"], "header", ["portable"]);
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		portable: PORTABLE_SESSION_MARKER,
		id: sessionManager.getSessionId(),
		timestamp: sourceHeader.timestamp,
	};

	const path = sessionManager.getBranch();
	const inactive = sessionManager.getEntries().length - path.length;
	if (inactive > 0) {
		projection.report("inactive_branch", "entries", `${inactive} entries are not on the active branch`);
	}

	const pathIndex = new Map(path.map((entry, index) => [entry.id, index]));
	const kept: boolean[] = [];
	const exported = new Map<string, JsonRecord>();
	const entries: JsonRecord[] = [];
	let parentId: string | null = null;
	for (const [index, sourceEntry] of path.entries()) {
		projection.entryId = sourceEntry.id;
		const entry = projectEntry(sourceEntry, index);
		kept.push(entry !== undefined);
		if (!entry) continue;
		const output = {
			type: sourceEntry.type,
			id: sourceEntry.id,
			parentId,
			timestamp: sourceEntry.timestamp,
			...entry,
		};
		entries.push(output);
		exported.set(sourceEntry.id, output);
		parentId = sourceEntry.id;
	}

	function projectEntry(sourceEntry: SessionEntry, index: number): JsonRecord | undefined {
		const type = sourceEntry.type;
		const source = sourceEntry as unknown as JsonRecord;
		if (!hasKey(ENTRIES, type)) {
			projection.report(
				"excluded_entry",
				type,
				type === "custom" ? "untyped extension state" : "unsupported entry type",
			);
			return undefined;
		}
		if (type === "message") {
			const message = projection.message(source.message);
			return message ? { message } : undefined;
		}
		if ((type === "label" || type === "context_edit") && !exported.has(source.targetId as string)) {
			projection.report("excluded_entry", type, "target entry is not exported");
			return undefined;
		}
		const targetOwner =
			type === "context_edit" ? contentOwnerOf(exported.get(source.targetId as string)!) : undefined;
		if (type === "context_edit" && !targetOwner) {
			projection.report("excluded_entry", type, "target entry has no editable content");
			return undefined;
		}

		const entry = projection.pick(source, ENTRIES[type].keys, type, BASE_KEYS);
		if (entry.usage !== undefined) entry.usage = projection.usage(entry.usage, `${type}.usage`);
		if (type === "custom_message") entry.content = projection.content(entry.content, "custom_message", type);
		if (type === "context_edit" && isRecord(entry.replacement)) {
			const replacement = projection.pick(entry.replacement, ["content"], "context_edit.replacement");
			replacement.content = projection.content(replacement.content, targetOwner!, "context_edit.replacement");
			entry.replacement = replacement;
		}
		if (type === "compaction") {
			const firstKeptEntryId = remapFirstKeptEntryId(sourceEntry.id, entry.firstKeptEntryId, index);
			if (firstKeptEntryId !== entry.firstKeptEntryId) {
				projection.report(
					"remapped_reference",
					"compaction.firstKeptEntryId",
					"moved to an exported entry with the same retained context",
				);
				entry.firstKeptEntryId = firstKeptEntryId;
			}
		}
		return ordered(entry, ENTRIES[type].keys);
	}

	// The first kept entry moves forward past excluded entries. With no such entry, or with a target
	// that is not before the compaction on this path, it becomes the compaction's own id, which is
	// the existing "retain none" sentinel. Both keep the retained context unchanged.
	function remapFirstKeptEntryId(compactionId: string, target: unknown, compactionIndex: number): string {
		const targetIndex = typeof target === "string" ? pathIndex.get(target) : undefined;
		if (targetIndex === undefined || targetIndex >= compactionIndex) return compactionId;
		for (let index = targetIndex; index < compactionIndex; index++) {
			if (kept[index]) return path[index].id;
		}
		return compactionId;
	}

	const records = [header, ...entries];
	try {
		validatePortableRecords(
			records.map((value, index) => ({ value, line: index + 1 })),
			"export",
		);
	} catch (error) {
		if (!(error instanceof PortableSessionError)) throw error;
		throw new Error(`Cannot export session ${sessionManager.getSessionId()}: ${error.message}`);
	}
	return {
		jsonl: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
		diagnostics: projection.diagnostics,
	};
}

/**
 * Write the active branch as a portable session file.
 * @param outputPath Target file path. If omitted, generates a timestamped file in the process cwd.
 */
export function exportPortableSession(
	sessionManager: PortableSessionSource,
	outputPath?: string,
): PortableSessionExportResult {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const { jsonl, diagnostics } = serializePortableSession(sessionManager);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, jsonl);
	return { path: filePath, diagnostics };
}

/** Group diagnostics into one line per code and field, in first-occurrence order. */
export function formatPortableSessionDiagnostics(diagnostics: readonly PortableSessionDiagnostic[]): string[] {
	const groups = new Map<string, { diagnostic: PortableSessionDiagnostic; count: number }>();
	for (const diagnostic of diagnostics) {
		const key = `${diagnostic.code}\0${diagnostic.field}`;
		const group = groups.get(key);
		if (group) group.count++;
		else groups.set(key, { diagnostic, count: 1 });
	}
	return Array.from(
		groups.values(),
		({ diagnostic, count }) => `${diagnostic.code} ${diagnostic.field} (${count}): ${diagnostic.message}`,
	);
}

// ============================================================================
// Validation
// ============================================================================

/** Append a key to a JSON path. Keys come from untrusted input, so unusual ones are quoted and escaped. */
function appendKey(path: string, key: string): string {
	if (/^\d+$/.test(key)) return `${path}[${key}]`;
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function jsonPath(base: string, instancePath: string): string {
	let path = base;
	for (const segment of instancePath.split("/").slice(1)) {
		path = appendKey(path, segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	}
	return path;
}

interface RecordLocation {
	source: string;
	line?: number;
}

function fail(code: PortableSessionErrorCode, detail: string, location: RecordLocation, path?: string): never {
	throw new PortableSessionError(code, detail, { ...location, path });
}

function checkSchema(
	schema: TSchema,
	value: unknown,
	path: string,
	code: PortableSessionErrorCode,
	location: RecordLocation,
): void {
	if (Check(schema, value)) return;
	const error = Errors(schema, value)[0];
	if (!error) fail(code, "does not match the portable session contract", location, path);
	const params = error.params as { additionalProperties?: string[]; requiredProperties?: string[] };
	if (error.keyword === "boolean") fail(code, "unexpected field", location, jsonPath(path, error.instancePath));
	if (error.keyword === "additionalProperties" && params.additionalProperties?.[0]) {
		fail(
			code,
			"unexpected field",
			location,
			appendKey(jsonPath(path, error.instancePath), params.additionalProperties[0]),
		);
	}
	if (error.keyword === "required" && params.requiredProperties?.[0]) {
		fail(
			code,
			"missing required field",
			location,
			appendKey(jsonPath(path, error.instancePath), params.requiredProperties[0]),
		);
	}
	fail(code, error.message, location, jsonPath(path, error.instancePath));
}

function checkContent(value: unknown, owner: ContentOwner, path: string, location: RecordLocation): void {
	const rule = CONTENT_RULES[owner];
	if (typeof value === "string") {
		if (rule.allowString) return;
		fail("invalid_entry", `expected content blocks for ${owner}`, location, path);
	}
	if (!Array.isArray(value)) fail("invalid_entry", "expected string or content blocks", location, path);
	for (const [index, block] of value.entries()) {
		const blockPath = `${path}[${index}]`;
		const type = isRecord(block) ? block.type : undefined;
		if (!hasKey(BLOCKS, type) || !rule.blocks.includes(type)) {
			fail(
				"invalid_entry",
				`content block type ${JSON.stringify(type)} is not allowed for ${owner}`,
				location,
				`${blockPath}.type`,
			);
		}
		checkSchema(BLOCKS[type].schema, block, blockPath, "invalid_entry", location);
	}
}

interface PortableRecord {
	value: unknown;
	line: number;
}

interface ValidatedPortableSession {
	header: { id: string; timestamp: string };
	entries: JsonRecord[];
}

function validatePortableRecords(records: readonly PortableRecord[], source: string): ValidatedPortableSession {
	const [first, ...rest] = records;
	if (!first || !isRecord(first.value) || first.value.type !== "session") {
		fail("missing_header", "the first record must be the session header", { source, line: first?.line });
	}
	const header = first.value;
	const headerLocation = { source, line: first.line };
	if (header.portable !== PORTABLE_SESSION_MARKER) {
		fail(
			"not_portable",
			"not a portable session; open native session files with --session / switch_session",
			headerLocation,
		);
	}
	checkSchema(HeaderSchema, header, "$", "invalid_header", headerLocation);
	const id = header.id as string;
	try {
		assertValidSessionId(id);
	} catch (error) {
		fail("invalid_header", error instanceof Error ? error.message : String(error), headerLocation, "$.id");
	}

	const entries: JsonRecord[] = [];
	const owners = new Map<string, ContentOwner | undefined>();
	let previousId: string | null = null;
	for (const { value, line } of rest) {
		const location = { source, line };
		if (!isRecord(value)) fail("invalid_entry", "expected an object", location, "$");
		const type = value.type;
		if (type === "session")
			fail("duplicate_header", "only the first record may be a session header", location, "$.type");
		if (!hasKey(ENTRIES, type)) {
			fail("invalid_entry", `unsupported entry type ${JSON.stringify(type)}`, location, "$.type");
		}
		checkSchema(ENTRIES[type].schema, value, "$", "invalid_entry", location);
		validateEntryBody(type, value, owners, location);

		const entryId = value.id as string;
		if (owners.has(entryId)) fail("duplicate_id", `duplicate entry id ${entryId}`, location, "$.id");
		if (value.parentId !== previousId) {
			fail(
				"invalid_parent",
				`parentId must be ${JSON.stringify(previousId)} (the previous entry)`,
				location,
				"$.parentId",
			);
		}
		if (
			type === "compaction" &&
			value.firstKeptEntryId !== entryId &&
			!owners.has(value.firstKeptEntryId as string)
		) {
			fail(
				"unresolved_reference",
				"firstKeptEntryId must name an earlier entry or this entry",
				location,
				"$.firstKeptEntryId",
			);
		}
		owners.set(entryId, contentOwnerOf(value));
		entries.push(value);
		previousId = entryId;
	}
	return { header: { id, timestamp: header.timestamp as string }, entries };
}

function validateEntryBody(
	type: PortableEntryType,
	entry: JsonRecord,
	owners: ReadonlyMap<string, ContentOwner | undefined>,
	location: RecordLocation,
): void {
	if (type === "message") {
		const message = entry.message;
		if (!isRecord(message) || !hasKey(MESSAGES, message.role)) {
			const role = isRecord(message) ? message.role : undefined;
			fail("invalid_entry", `unsupported message role ${JSON.stringify(role)}`, location, "$.message.role");
		}
		const role = message.role;
		checkSchema(MESSAGES[role].schema, message, "$.message", "invalid_entry", location);
		if (role !== "bashExecution") checkContent(message.content, role, "$.message.content", location);
	} else if (type === "custom_message") {
		checkContent(entry.content, "custom_message", "$.content", location);
	} else if (type === "label" || type === "context_edit") {
		const targetId = entry.targetId as string;
		if (!owners.has(targetId))
			fail("unresolved_reference", "targetId must name an earlier entry", location, "$.targetId");
		if (type === "context_edit") {
			const owner = owners.get(targetId);
			if (!owner) fail("invalid_entry", "context edit target has no editable content", location, "$.targetId");
			const replacement = entry.replacement;
			if (isRecord(replacement)) checkContent(replacement.content, owner, "$.replacement.content", location);
		}
	}
}

// ============================================================================
// Import
// ============================================================================

export interface PortableImportOptions {
	/** Destination working directory written into the native header. */
	cwd: string;
	/** Destination session directory. It is created on commit when missing. */
	sessionDir: string;
}

export interface PreparedPortableImport {
	sessionId: string;
	sessionDir: string;
	/** Native session file that commit will create. */
	destination: string;
	jsonl: string;
	/** Validated entries in file order, read by compatibility inspection. */
	entries: Record<string, unknown>[];
}

/**
 * Validate a portable session file and compute the native session it becomes. Writes nothing.
 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
 * @throws {PortableSessionError} When the file does not match the portable contract.
 * @throws {SessionImportIdConflictError} When the session id already exists in the session dir.
 */
export function preparePortableImport(inputPath: string, options: PortableImportOptions): PreparedPortableImport {
	const filePath = resolvePath(inputPath);
	if (!existsSync(filePath)) throw new SessionImportFileNotFoundError(filePath);

	const records: PortableRecord[] = [];
	for (const [index, text] of readFileSync(filePath, "utf8").split("\n").entries()) {
		if (!text.trim()) continue;
		try {
			records.push({ value: JSON.parse(text), line: index + 1 });
		} catch (error) {
			const detail = `malformed JSON: ${error instanceof Error ? error.message : String(error)}`;
			fail("invalid_json", detail, { source: filePath, line: index + 1 });
		}
	}
	const { header, entries } = validatePortableRecords(records, filePath);

	const sessionDir = resolvePath(options.sessionDir);
	const existingPath = SessionManager.findByIdInDirectory(sessionDir, header.id);
	if (existingPath) throw new SessionImportIdConflictError(header.id, existingPath);

	const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const nativeHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: header.id,
		timestamp: header.timestamp,
		cwd: resolvePath(options.cwd),
	};
	return {
		sessionId: header.id,
		sessionDir,
		destination: join(sessionDir, `${fileTimestamp}_${header.id}.jsonl`),
		jsonl: `${[nativeHeader, ...entries].map((record) => JSON.stringify(record)).join("\n")}\n`,
		entries,
	};
}

/** Create the session dir if needed and write the prepared native session without overwriting. Filesystem errors are thrown as is. */
export function commitPortableImport(prepared: PreparedPortableImport): string {
	mkdirSync(prepared.sessionDir, { recursive: true });
	writeFileSync(prepared.destination, prepared.jsonl, { flag: "wx" });
	return prepared.destination;
}

/**
 * Import a portable session file as a new native session. Open the result with `SessionManager.open()`.
 * @returns Path of the new native session file.
 */
export function importPortableSession(inputPath: string, options: PortableImportOptions): string {
	return commitPortableImport(preparePortableImport(inputPath, options));
}

// ============================================================================
// Compatibility
// ============================================================================

/**
 * Status of a referenced model, tool, or renderer in the destination. `no_auth` applies only to a
 * model that exists but has no credentials here. `unknown` means the destination cannot decide yet.
 */
export type PortableReferenceStatus = "available" | "missing" | "no_auth" | "unknown";

/** Destination lookups used by inspection. Each one is pure: it does not load or run extensions. */
export interface PortableCapabilities {
	model(provider: string, modelId: string): PortableReferenceStatus;
	isVirtualModel(provider: string, modelId: string): boolean;
	tool(name: string): PortableReferenceStatus;
	renderer(customType: string): PortableReferenceStatus;
}

export interface PortableModelReference {
	provider: string;
	modelId: string;
	status: PortableReferenceStatus;
	/** References in the file: selections and assistant responses. */
	count: number;
}

export interface PortableNamedReference {
	name: string;
	status: PortableReferenceStatus;
	count: number;
}

/**
 * How a prepared import compares with the destination. Only `requirement` can block: the next turn
 * runs on that model. Every other field describes history or display and never blocks.
 */
export interface PortableCompatibilityReport {
	sessionId: string;
	/** Model the next turn uses. Absent when the file records no model selection or response. */
	requirement?: PortableModelReference;
	/** Model references other than the requirement. */
	historicalModels: PortableModelReference[];
	/** Tool names from past tool calls and results. The destination's own tools run the next turn. */
	historicalTools: PortableNamedReference[];
	/** Custom message types. Without a renderer, a message uses the default display. */
	customMessages: PortableNamedReference[];
	/** True when the requirement is not available here, so the import needs a replacement model. */
	blocking: boolean;
}

/** A model reference chosen by the caller, e.g. `{ provider: "anthropic", modelId: "claude-sonnet-5-5" }`. */
export interface PortableModelChoice {
	provider: string;
	modelId: string;
}

/**
 * The caller's answer to a blocked import. `model` names the replacement directly. Without it, `chooseModel`
 * is asked; returning undefined cancels the import. With neither, a blocked import throws.
 */
export interface PortableImportChoice {
	model?: PortableModelChoice;
	chooseModel?: (report: PortableCompatibilityReport) => Promise<PortableModelChoice | undefined>;
}

/** A blocked import has no replacement model. Nothing was written. */
export class SessionImportSelectionRequiredError extends SessionImportError {
	readonly report: PortableCompatibilityReport;

	constructor(report: PortableCompatibilityReport) {
		super(`Import of session ${report.sessionId} needs a replacement model. Nothing was written.`);
		this.name = "SessionImportSelectionRequiredError";
		this.report = report;
	}
}

type ModelKey = PortableModelChoice;

function modelKey(record: JsonRecord): ModelKey {
	return { provider: record.provider as string, modelId: record.modelId as string };
}

function findLastModelChange(entries: readonly JsonRecord[], before: number): ModelKey | undefined {
	for (let index = before - 1; index >= 0; index--) {
		if (entries[index].type === "model_change") return modelKey(entries[index]);
	}
	return undefined;
}

/**
 * The model the next turn uses. Mirrors getBranchSelection() in virtual-models.ts: the last model
 * selection wins, unless a physical response comes later and no virtual selection holds.
 */
function nextTurnModel(entries: readonly JsonRecord[], isVirtual: (key: ModelKey) => boolean): ModelKey | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "model_change") return modelKey(entry);
		const message = entry.message;
		if (entry.type !== "message" || !isRecord(message) || message.role !== "assistant") continue;
		if (isVirtualModel({ api: message.api as string })) continue;
		const response = { provider: message.provider as string, modelId: message.model as string };
		const change = findLastModelChange(entries, index);
		return change && isVirtual(change) ? change : response;
	}
	return undefined;
}

interface CountedModel extends ModelKey {
	count: number;
}

/**
 * Compare a prepared import with the destination. Reads the validated entries and calls only the lookups
 * in `capabilities`. It writes nothing, runs no extension code, and reads no credentials from the file.
 */
export function inspectPortableImport(
	prepared: PreparedPortableImport,
	capabilities: PortableCapabilities,
): PortableCompatibilityReport {
	const entries = prepared.entries;
	const models = new Map<string, CountedModel>();
	const tools = new Map<string, number>();
	const customTypes = new Map<string, number>();

	const countModel = (key: ModelKey): void => {
		const id = `${key.provider}\0${key.modelId}`;
		const existing = models.get(id);
		if (existing) existing.count++;
		else models.set(id, { ...key, count: 1 });
	};
	const countName = (counts: Map<string, number>, name: string): void => {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	};

	for (const entry of entries) {
		if (entry.type === "model_change") {
			countModel(modelKey(entry));
		} else if (entry.type === "custom_message") {
			countName(customTypes, entry.customType as string);
		} else if (entry.type === "message" && isRecord(entry.message)) {
			const message = entry.message;
			if (message.role === "assistant") {
				countModel({ provider: message.provider as string, modelId: message.model as string });
				if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (isRecord(block) && block.type === "toolCall") countName(tools, block.name as string);
					}
				}
			} else if (message.role === "toolResult") {
				countName(tools, message.toolName as string);
			}
		}
	}

	const next = nextTurnModel(entries, (key) => capabilities.isVirtualModel(key.provider, key.modelId));
	const requirementId = next ? `${next.provider}\0${next.modelId}` : undefined;
	const toModelReference = (entry: CountedModel): PortableModelReference => ({
		provider: entry.provider,
		modelId: entry.modelId,
		status: capabilities.model(entry.provider, entry.modelId),
		count: entry.count,
	});
	const requirement = requirementId !== undefined ? models.get(requirementId) : undefined;
	const named = (counts: Map<string, number>, lookup: (name: string) => PortableReferenceStatus) =>
		Array.from(counts, ([name, count]) => ({ name, status: lookup(name), count }));

	const requirementReference = requirement ? toModelReference(requirement) : undefined;
	return {
		sessionId: prepared.sessionId,
		...(requirementReference ? { requirement: requirementReference } : {}),
		historicalModels: Array.from(models)
			.filter(([id]) => id !== requirementId)
			.map(([, entry]) => toModelReference(entry)),
		historicalTools: named(tools, (name) => capabilities.tool(name)),
		customMessages: named(customTypes, (name) => capabilities.renderer(name)),
		blocking: requirementReference !== undefined && requirementReference.status !== "available",
	};
}

function describeMissing(kind: "model" | "tool" | "renderer", name: string, status: PortableReferenceStatus): string {
	if (kind === "model") {
		if (status === "no_auth")
			return `${name} has no credentials here. Log in to its provider, or choose a replacement.`;
		if (status === "unknown") {
			return `${name} is not in the built-in catalog, so an extension may provide it. Choose a replacement, or load the extension and import again.`;
		}
		return `${name} is not in this harness's catalog. Choose a replacement, or enable the extension that provides it.`;
	}
	if (kind === "tool") {
		if (status === "unknown")
			return `${name} may come from an extension that has not loaded yet. The import is not blocked.`;
		return `${name} is not registered here. Enable the extension that provides it to use it again. The import is not blocked.`;
	}
	if (status === "unknown") return `${name} may get a renderer from an extension that has not loaded yet.`;
	return `${name} has no renderer here and uses the default display.`;
}

/**
 * Human-readable lines for a report. Available references are summarized by count; every other
 * reference gets a line with its remediation.
 */
export function formatPortableCompatibilityReport(report: PortableCompatibilityReport): string[] {
	const lines: string[] = [];
	const requirement = report.requirement;
	if (requirement) {
		const name = `${requirement.provider}/${requirement.modelId}`;
		lines.push(`Next turn model: ${name} (${requirement.status})`);
		if (requirement.status !== "available") lines.push(`  ${describeMissing("model", name, requirement.status)}`);
	} else {
		lines.push("Next turn model: none recorded in the file");
	}
	const findings: string[] = [];
	for (const model of report.historicalModels) {
		if (model.status === "available") continue;
		const name = `${model.provider}/${model.modelId}`;
		findings.push(`  history model ${name} (${model.count}): ${describeMissing("model", name, model.status)}`);
	}
	for (const tool of report.historicalTools) {
		if (tool.status === "available") continue;
		findings.push(`  history tool ${tool.name} (${tool.count}): ${describeMissing("tool", tool.name, tool.status)}`);
	}
	for (const custom of report.customMessages) {
		if (custom.status === "available") continue;
		findings.push(
			`  custom message ${custom.name} (${custom.count}): ${describeMissing("renderer", custom.name, custom.status)}`,
		);
	}
	if (findings.length === 0) lines.push("All other references are available.");
	else lines.push("Other references:", ...findings);
	lines.push(report.blocking ? "Blocked: choose a replacement model." : "Not blocked.");
	return lines;
}

/** True when the first non-blank line of a file is a header carrying the portable marker. */
export function isPortableSessionFile(filePath: string): boolean {
	const firstLine = readFileSync(filePath, "utf8")
		.split("\n")
		.find((line) => line.trim());
	if (!firstLine) return false;
	try {
		const header: unknown = JSON.parse(firstLine);
		return isRecord(header) && header.type === "session" && header.portable === PORTABLE_SESSION_MARKER;
	} catch {
		return false;
	}
}
