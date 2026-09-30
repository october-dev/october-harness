/**
 * Redaction for trace records. Works on detached JSON snapshots only; live objects are never
 * modified. Known secret literals, `Bearer`/`Basic` credentials, URL credentials, and values
 * under credential-named keys become `<redacted>`. Images and signatures become typed omissions.
 */

import { parseStreamingJson } from "@earendil-works/pi-ai";
import { isSensitiveEnvName, isSensitiveKey } from "../sensitive-names.ts";
import type { TraceFrame, TraceRecord } from "./format.ts";

export const REDACTED = "<redacted>";
export const OMITTED = "<omitted>";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Range = [start: number, end: number];

/** Payload keys whose string values are schema discriminants or model identity. */
const PRESERVED_KEYS = new Set([
	"type",
	"role",
	"stopReason",
	"api",
	"provider",
	"model",
	"responseModel",
	"providerThinkingLevel",
	"mimeType",
	"customType",
	"executionMode",
	"toolName",
]);
/**
 * Opaque identifiers that correlate records. They are replaced by trace-local pseudonyms from their
 * first appearance, so their written form never depends on which secrets are known at the time.
 */
const PSEUDONYM_KINDS: Record<string, "session" | "call"> = { sessionId: "session", toolCallId: "call" };
/** Object types whose `id` is a tool call ID and whose `name` is a tool name. */
const TOOL_CALL_TYPES = new Set(["toolCall", "toolcall_end"]);
/** Keys whose array items are tool declarations. */
const TOOL_LIST_KEYS = new Set(["tools", "toolsAdded", "toolsRemoved"]);
const SIGNATURE_KEYS = new Set(["textSignature", "thinkingSignature", "thoughtSignature"]);
/** Keys whose values are free-form data: nested keys have no schema meaning. */
const FREE_KEYS = new Set(["arguments", "args", "preparedArgs", "details"]);
/** Envelope fields written verbatim: generated IDs, counters, and enums. */
const ENVELOPE_KEYS = new Set([
	"type",
	"seq",
	"ts",
	"runId",
	"requestId",
	"hookId",
	"turn",
	"kind",
	"hook",
	"phase",
	"status",
	"source",
	"event",
	"returned",
	"willRetry",
	"isError",
	"openOperations",
	"eventCount",
	"handlerIndex",
	"thinkingLevel",
	"toolExecution",
	"model",
	"toolName",
]);

/**
 * `name:` or `name=`, optionally quoted. Only the name and separator are consumed, so a name inside
 * another field's value (`log: password=...`, `note="password=..."`) is still found.
 */
const NAMED = /\b([A-Za-z][\w-]*)\\?["']?\s*([:=])\s*/gi;
/**
 * The value after a credential name, matched at that position: an escaped-quoted value (group 2)
 * runs to its escaped closing quote, a quoted value (group 4) to its closing quote honoring
 * backslash escapes, and an unquoted value (group 5) to whitespace or a delimiter. An auth scheme
 * may precede the credential. Auth schemes are case-insensitive (RFC 9110).
 */
const NAMED_VALUE =
	/(?:\\(["'])((?:(?!\\\1)[^\n])*)(?:\\\1)?|(["'])((?:\\.|(?!\3)[^\\\n])*)\3?|((?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;&\\]+))/diy;
/** An auth scheme before a credential. */
const SCHEME_PREFIX = /^(?:Bearer|Basic|Token|Digest)\s+/i;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi;
const BASIC = /\bBasic\s+([A-Za-z0-9+/]+={0,2})(?![\w+/=])/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const QUERY_PARAMETER = /[?&]([^=&#\s]+)=([^&#\s]*)/g;

function mergeRanges(ranges: Range[]): Range[] {
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: Range[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	return merged;
}

function replaceRanges(text: string, ranges: Range[], offset = 0): string {
	let result = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		const localStart = Math.max(0, start - offset);
		const localEnd = Math.min(text.length, end - offset);
		if (localEnd <= 0 || localStart >= text.length || localEnd <= localStart) continue;
		result += `${text.slice(cursor, localStart)}${REDACTED}`;
		cursor = localEnd;
	}
	return result + text.slice(cursor);
}

function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TraceRedactor {
	private readonly literals = new Set<string>();
	private readonly pseudonyms = new Map<string, string>();
	private readonly pseudonymCounts = { session: 0, call: 0 };

	/** Register a secret literal of any non-empty length. */
	addSecret(value: string | undefined | null): void {
		if (value) this.literals.add(value);
	}

	/** Register credential-named header values, including the credential after an auth scheme. */
	addHeaders(headers: Record<string, string | null | undefined> | undefined): void {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (!value || !isSensitiveEnvName(name)) continue;
			this.addSecret(value);
			const credential = /^\S+\s+(\S.*)$/.exec(value)?.[1];
			this.addSecret(credential);
		}
	}

	/** Register values of credential-named environment variables. Short values are included. */
	addEnv(env: Record<string, string | undefined> | undefined): void {
		for (const [name, value] of Object.entries(env ?? {})) {
			if (isSensitiveEnvName(name)) this.addSecret(value);
		}
	}

	private ranges(text: string): Range[] {
		const ranges: Range[] = [];
		for (const literal of this.literals) {
			for (let index = text.indexOf(literal); index !== -1; index = text.indexOf(literal, index + 1)) {
				ranges.push([index, index + literal.length]);
			}
		}
		const pushTail = (match: RegExpMatchArray, value: string) => {
			const start = (match.index ?? 0) + match[0].length - value.length;
			ranges.push([start, start + value.length]);
		};
		// An explicitly named credential, such as `Authorization: Basic YTpi` or `SERVICE_KEY=...`.
		// A quoted value runs to its closing quote, so a credential containing spaces is removed whole.
		for (const named of text.matchAll(NAMED)) {
			const [, name, separator] = named;
			if (!isSensitiveKey(name) && !(separator === "=" && isSensitiveEnvName(name))) continue;
			NAMED_VALUE.lastIndex = (named.index ?? 0) + named[0].length;
			const match = NAMED_VALUE.exec(text);
			if (!match) continue;
			const group = match[2] !== undefined ? 2 : match[4] !== undefined ? 4 : 5;
			const [start, end] = match.indices?.[group] ?? [0, 0];
			const scheme = SCHEME_PREFIX.exec(match[group] ?? "")?.[0].length ?? 0;
			if (end > start + scheme) ranges.push([start + scheme, end]);
		}
		for (const match of text.matchAll(BEARER)) {
			if (match[1].length >= 8) pushTail(match, match[1]);
		}
		// A bare Basic credential is recognized by decoding to `user:password`.
		for (const match of text.matchAll(BASIC)) {
			if (isBasicCredential(match[1])) pushTail(match, match[1]);
		}
		for (const match of text.matchAll(URL_PATTERN)) {
			const url = match[0];
			const authorityStart = url.indexOf("://") + 3;
			const authorityEnd = url.slice(authorityStart).search(/[/?#]/);
			const authority = url.slice(authorityStart, authorityEnd === -1 ? undefined : authorityStart + authorityEnd);
			const at = authority.lastIndexOf("@");
			if (at > 0) ranges.push([match.index + authorityStart, match.index + authorityStart + at]);
			for (const parameter of url.matchAll(QUERY_PARAMETER)) {
				if (!parameter[2] || !isSensitiveKey(decodeURIComponentSafe(parameter[1]))) continue;
				const valueStart = match.index + parameter.index + parameter[0].length - parameter[2].length;
				ranges.push([valueStart, valueStart + parameter[2].length]);
			}
		}
		return mergeRanges(ranges);
	}

	redactString(text: string): string {
		const ranges = this.ranges(text);
		return ranges.length === 0 ? text : replaceRanges(text, ranges);
	}

	/**
	 * Redact consecutive fragments of one stream. Matches are found in the joined text, so a
	 * secret split across fragments is removed from every fragment that holds part of it.
	 */
	redactFragments(fragments: readonly string[]): string[] {
		const ranges = this.ranges(fragments.join(""));
		if (ranges.length === 0) return [...fragments];
		let offset = 0;
		return fragments.map((fragment) => {
			const redacted = replaceRanges(fragment, ranges, offset);
			offset += fragment.length;
			return redacted;
		});
	}

	/** Trace-local name for an opaque identifier, fixed at its first appearance. */
	pseudonym(kind: "session" | "call", id: string): string {
		const key = `${kind}\u0000${id}`;
		let pseudonym = this.pseudonyms.get(key);
		if (!pseudonym) {
			pseudonym = `${kind}-${++this.pseudonymCounts[kind]}`;
			this.pseudonyms.set(key, pseudonym);
		}
		return pseudonym;
	}

	/** Redacted copy of a payload value. `free` payloads have no schema keys to preserve. */
	redactValue(value: unknown, free = false, key?: string, toolDeclaration = false): Json {
		if (typeof value === "string") {
			if (key !== undefined && isSensitiveKey(key)) return REDACTED;
			if (!free && key !== undefined) {
				if (PRESERVED_KEYS.has(key)) return value;
				const kind = PSEUDONYM_KINDS[key];
				if (kind) return this.pseudonym(kind, value);
				if (SIGNATURE_KEYS.has(key)) return OMITTED;
			}
			return this.redactString(value);
		}
		if (value === null || typeof value !== "object") return (value ?? null) as Json;
		if (key !== undefined && isSensitiveKey(key)) return REDACTED;
		if (Array.isArray(value)) {
			const declarations = !free && key !== undefined && TOOL_LIST_KEYS.has(key);
			return value.map((item) => this.redactValue(item, free, undefined, declarations));
		}
		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") {
			return {
				type: "image",
				omitted: true,
				...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
				bytes: base64Bytes(record.data),
			};
		}
		// Tool names are schema identifiers, like model identity: kept verbatim so tool calls,
		// declarations, and results stay consistent. Tool call IDs get pseudonyms.
		const toolCall = !free && typeof record.type === "string" && TOOL_CALL_TYPES.has(record.type);
		const result: JsonObject = {};
		for (const [childKey, child] of Object.entries(record)) {
			if (child === undefined) continue;
			if ((toolCall || toolDeclaration) && childKey === "name" && typeof child === "string") {
				result.name = child;
			} else if (toolCall && childKey === "id" && typeof child === "string") {
				result.id = this.pseudonym("call", child);
			} else {
				result[free ? this.redactString(childKey) : childKey] = this.redactValue(
					child,
					free || FREE_KEYS.has(childKey),
					childKey,
				);
			}
		}
		if (!free && record.type === "thinking" && record.redacted === true) result.thinking = OMITTED;
		return result;
	}

	/** Redact one assistant stream's frames with cross-fragment sanitation per content block. */
	redactFrames(frames: readonly TraceFrame[]): Json[] {
		const redacted = frames.map((frame) => this.redactValue(frame) as JsonObject);
		const blocks = new Map<number, number[]>();
		frames.forEach((frame, index) => {
			if (frame.type === "start" || frame.contentIndex === undefined) return;
			const list = blocks.get(frame.contentIndex) ?? [];
			list.push(index);
			blocks.set(frame.contentIndex, list);
		});
		for (const indexes of blocks.values()) {
			const first = frames[indexes[0]];
			if (first.type.startsWith("toolcall")) this.sanitizeToolCallBlock(frames, redacted, indexes);
			else this.sanitizeTextBlock(frames, redacted, indexes);
		}
		return redacted;
	}

	private sanitizeTextBlock(frames: readonly TraceFrame[], redacted: JsonObject[], indexes: number[]): void {
		const field = frames[indexes[0]].type.startsWith("thinking") ? "thinking" : "text";
		const opaque = indexes.some((index) => {
			const frame = frames[index];
			return frame.redacted === true || (isObject(frame.content) && frame.content.redacted === true);
		});
		const fragmentIndexes: number[] = [];
		const fragments: string[] = [];
		for (const index of indexes) {
			const frame = frames[index];
			if (frame.type.endsWith("_start") && isObject(frame.content)) {
				fragmentIndexes.push(index);
				fragments.push(String(frame.content[field] ?? ""));
			} else if (frame.type.endsWith("_delta")) {
				fragmentIndexes.push(index);
				fragments.push(String(frame.delta ?? ""));
			} else if (frame.type.endsWith("_end")) {
				redacted[index].content = opaque ? OMITTED : this.redactString(String(frame.content ?? ""));
			}
		}
		const sanitized = opaque
			? fragments.map((_fragment, position) => (position === 0 ? OMITTED : ""))
			: this.redactFragments(fragments);
		fragmentIndexes.forEach((index, position) => {
			const target = redacted[index];
			if (frames[index].type.endsWith("_start") && isObject(target.content))
				target.content[field] = sanitized[position];
			else target.delta = sanitized[position];
		});
	}

	/**
	 * Tool-call JSON is streamed as fragments of one document. When any redaction applies, the
	 * block is coalesced: the start snapshot is emptied and the first JSON fragment carries the
	 * redacted arguments, so no fragment retains part of a secret and numbers stay valid JSON.
	 */
	private sanitizeToolCallBlock(frames: readonly TraceFrame[], redacted: JsonObject[], indexes: number[]): void {
		let json = "";
		const jsonIndexes: number[] = [];
		let startIndex: number | undefined;
		let endIndex: number | undefined;
		for (const index of indexes) {
			const frame = frames[index];
			if (frame.type === "toolcall_start") startIndex = index;
			else if (frame.type === "toolcall_end") endIndex = index;
			else if (frame.type === "toolcall_checkpoint") {
				json = String(frame.json ?? "");
				jsonIndexes.push(index);
			} else if (frame.type === "toolcall_delta") {
				json += String(frame.delta ?? "");
				jsonIndexes.push(index);
			}
		}
		const partial = parseStreamingJson(json);
		const partialRedacted = this.redactValue(partial, true);
		const changed = (original: unknown, copy: Json) => JSON.stringify(original) !== JSON.stringify(copy);
		const startArguments =
			startIndex === undefined ? undefined : (frames[startIndex].toolCall as JsonObject)?.arguments;
		const affected =
			changed(partial, partialRedacted) ||
			this.redactString(json) !== json ||
			(startIndex !== undefined && changed(startArguments ?? {}, this.redactValue(startArguments ?? {}, true))) ||
			(endIndex !== undefined &&
				changed(frames[endIndex].arguments, this.redactValue(frames[endIndex].arguments, true)));
		if (!affected) {
			// Keep the exact JSON fragments so replaying them reproduces the recorded arguments.
			for (const index of jsonIndexes) {
				if (frames[index].type === "toolcall_checkpoint") redacted[index].json = String(frames[index].json ?? "");
				else redacted[index].delta = String(frames[index].delta ?? "");
			}
			return;
		}
		if (startIndex !== undefined && isObject(redacted[startIndex].toolCall)) {
			(redacted[startIndex].toolCall as JsonObject).arguments = {};
			redacted[startIndex].coalesced = true;
		}
		const document = jsonIndexes.length > 0 ? JSON.stringify(partialRedacted) : "";
		jsonIndexes.forEach((index, position) => {
			const target = redacted[index];
			const value = position === 0 ? document : "";
			if (target.type === "toolcall_checkpoint") target.json = value;
			else target.delta = value;
			target.coalesced = true;
		});
		if (endIndex !== undefined) redacted[endIndex].coalesced = true;
	}

	/**
	 * Redact one tool invocation's partial results. Text content is scanned across updates, so a
	 * secret split between two updates is removed from both.
	 */
	redactToolUpdates(partialResults: readonly unknown[]): Json[] {
		const redacted = partialResults.map((result) => this.redactValue(result));
		const slots: Array<{ target: JsonObject }> = [];
		const fragments: string[] = [];
		partialResults.forEach((result, index) => {
			const target = redacted[index];
			if (
				!isObject(result) ||
				!Array.isArray(result.content) ||
				!isObject(target) ||
				!Array.isArray(target.content)
			) {
				return;
			}
			result.content.forEach((block, blockIndex) => {
				const targetBlock = (target.content as Json[])[blockIndex];
				if (isObject(block) && block.type === "text" && typeof block.text === "string" && isObject(targetBlock)) {
					slots.push({ target: targetBlock });
					fragments.push(block.text);
				}
			});
		});
		const sanitized = this.redactFragments(fragments);
		slots.forEach((slot, index) => {
			slot.target.text = sanitized[index];
		});
		return redacted;
	}

	/** Redact one record. Envelope IDs, counters, and enums stay valid; payloads are redacted. */
	redactRecord(record: TraceRecord): JsonObject {
		const result: JsonObject = {};
		for (const [key, value] of Object.entries(record)) {
			if (value === undefined) continue;
			if (record.type === "header" || ENVELOPE_KEYS.has(key)) result[key] = value as Json;
			else if (PSEUDONYM_KINDS[key] && typeof value === "string")
				result[key] = this.pseudonym(PSEUDONYM_KINDS[key], value);
			else if (key === "terminal" && isObject(value)) {
				result.terminal = { reason: value.reason, message: this.redactValue(value.message) };
			} else result[key] = this.redactValue(value, FREE_KEYS.has(key), key);
		}
		return result;
	}
}

function isBasicCredential(token: string): boolean {
	const decoded = Buffer.from(token, "base64");
	if (decoded.toString("base64").replace(/=+$/, "") !== token.replace(/=+$/, "")) return false;
	const text = decoded.toString("utf-8");
	return /^[\x20-\x7e]+$/.test(text) && text.indexOf(":") > 0;
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
