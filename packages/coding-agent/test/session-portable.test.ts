import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { buildSessionContext, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	importPortableSession,
	type PortableSessionDiagnostic,
	PortableSessionError,
	type PortableSessionErrorCode,
	SessionImportIdConflictError,
	serializePortableSession,
} from "../src/core/session-portable.ts";
import {
	buildPortableFixture,
	FIXTURE_IMAGE,
	FIXTURE_SECRETS,
	FIXTURE_TRANSCRIPT_PATH,
	type PortableFixture,
} from "./fixtures/portable-session-fixture.ts";
import { assistantMsg } from "./utilities.ts";

type JsonRecord = Record<string, unknown>;

function obj(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
	return value as JsonRecord;
}

function arr(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("expected an array");
	return value;
}

/** The message of a parsed `message` record. */
function messageOf(record: JsonRecord | undefined): JsonRecord {
	return obj(obj(record).message);
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function parseJsonl(jsonl: string): JsonRecord[] {
	return jsonl
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as JsonRecord);
}

function createFixtureSession(): { sm: SessionManager; fixture: PortableFixture; sourceCwd: string } {
	const sourceCwd = createTempDir("pi-portable-source-");
	const sm = SessionManager.inMemory(sourceCwd);
	const fixture = buildPortableFixture(sm, join(createTempDir("pi-portable-bash-"), "bash-output.log"));
	return { sm, fixture, sourceCwd };
}

function expectedDiagnostics(ids: PortableFixture["ids"]): PortableSessionDiagnostic[] {
	const field = (entryId: string, name: string, message: string): PortableSessionDiagnostic => ({
		code: "excluded_field",
		entryId,
		field: name,
		message,
	});
	const entry = (entryId: string, name: string, message: string): PortableSessionDiagnostic => ({
		code: "excluded_entry",
		entryId,
		field: name,
		message,
	});
	const signature = "provider replay signature";
	return [
		{ code: "excluded_field", field: "header.cwd", message: "machine-specific path" },
		{ code: "inactive_branch", field: "entries", message: "2 entries are not on the active branch" },
		entry(ids.system, "message.system", "source prompt and tool state"),
		field(ids.user, "user.content.textSignature", signature),
		field(ids.assistant, "assistant.responseId", "provider response handle"),
		field(ids.assistant, "assistant.diagnostics", "provider runtime diagnostics"),
		field(ids.assistant, "assistant.content.textSignature", signature),
		field(ids.assistant, "assistant.content.thinkingSignature", signature),
		field(ids.assistant, "assistant.content[thinking:redacted]", "provider-encrypted reasoning"),
		field(ids.assistant, "assistant.content.thoughtSignature", signature),
		field(ids.toolResult, "toolResult.details", "untyped extension data"),
		field(ids.compaction, "compaction.details", "untyped extension data"),
		field(ids.compaction, "compaction.systemMessage", "source prompt and tool state"),
		field(ids.errorAssistant, "assistant.errorMessage", "free-form provider text"),
		field(ids.errorAssistant, "assistant.rawStopReason", "free-form provider text"),
		field(ids.bashExecution, "bashExecution.fullOutputPath", "machine-specific path"),
		entry(ids.retainNoneSystem, "message.system", "source prompt and tool state"),
		field(ids.retainNoneCompaction, "compaction.systemMessage", "source prompt and tool state"),
		{
			code: "remapped_reference",
			entryId: ids.retainNoneCompaction,
			field: "compaction.firstKeptEntryId",
			message: "moved to an exported entry with the same retained context",
		},
		field(ids.editedAssistant, "assistant.content.thinkingSignature", signature),
		field(ids.customMessage, "custom_message.details", "untyped extension data"),
		entry(ids.custom, "custom", "untyped extension state"),
		field(ids.contextEdit, "context_edit.replacement.content.thinkingSignature", signature),
		field(ids.contextEdit, "context_edit.replacement.content[thinking:redacted]", "provider-encrypted reasoning"),
		field(ids.usage, "usage.note", "free-form usage text"),
		entry(ids.deferred, "message.assistant", "unsettled assistant turn (pending or deferred)"),
		entry(ids.droppedLabel, "label", "target entry is not exported"),
	];
}

function withoutParent(record: JsonRecord): JsonRecord {
	const { parentId: _parentId, ...rest } = record;
	return rest;
}

describe("portable session codec", () => {
	it("exports the active branch through the allowlist and reports every exclusion", () => {
		const { sm, fixture, sourceCwd } = createFixtureSession();
		const { ids } = fixture;
		const { jsonl, diagnostics } = serializePortableSession(sm);
		const [header, ...entries] = parseJsonl(jsonl);

		expect(Object.keys(header)).toEqual(["type", "version", "portable", "id", "timestamp"]);
		expect(header).toEqual({
			type: "session",
			version: 3,
			portable: 1,
			id: sm.getSessionId(),
			timestamp: sm.getHeader()!.timestamp,
		});

		const excluded = new Set([ids.system, ids.retainNoneSystem, ids.custom, ids.deferred, ids.droppedLabel]);
		const expectedIds = sm
			.getBranch()
			.map((entry) => entry.id)
			.filter((id) => !excluded.has(id));
		expect(entries.map((entry) => entry.id)).toEqual(expectedIds);
		expect(entries.map((entry) => entry.parentId)).toEqual([null, ...expectedIds.slice(0, -1)]);
		expect(entries.map((entry) => entry.id)).not.toContain(ids.abandoned[0]);

		// Kept fields equal the originals; only parentId and the remapped reference change.
		const sourceById = new Map(sm.getEntries().map((entry) => [entry.id, entry as unknown as JsonRecord]));
		const blockDropping = new Set([ids.assistant, ids.contextEdit, ids.retainNoneCompaction]);
		for (const entry of entries) {
			const id = String(entry.id);
			const source = sourceById.get(id)!;
			expect(entry.timestamp).toBe(source.timestamp);
			if (!blockDropping.has(id)) expect(source).toMatchObject(withoutParent(entry));
		}
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		expect(messageOf(byId.get(ids.assistant)).content).toEqual([
			{ type: "text", text: "Reading the file." },
			{ type: "thinking", thinking: "I should read it." },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: FIXTURE_TRANSCRIPT_PATH } },
		]);
		expect(messageOf(byId.get(ids.user)).content).toEqual([
			{ type: "text", text: `Please review ${FIXTURE_TRANSCRIPT_PATH}` },
			FIXTURE_IMAGE,
		]);
		expect(arr(messageOf(byId.get(ids.toolResult)).content)[1]).toEqual(FIXTURE_IMAGE);
		expect(arr(messageOf(byId.get(ids.attachmentUser)).content)[1]).toEqual(FIXTURE_IMAGE);
		expect(byId.get(ids.contextEdit)!.replacement).toEqual({
			content: [
				{ type: "text", text: "Edited answer." },
				{ type: "thinking", thinking: "Edited reasoning." },
			],
		});
		expect(messageOf(byId.get(ids.errorAssistant)).stopReason).toBe("error");
		expect(messageOf(byId.get(ids.bashExecution)).truncated).toBe(true);
		expect(byId.get(ids.compaction)!.firstKeptEntryId).toBe(ids.user);
		expect(byId.get(ids.retainNoneCompaction)!.firstKeptEntryId).toBe(ids.retainNoneCompaction);
		expect(byId.get(ids.userLabel)!).toMatchObject({ targetId: ids.user, label: "start" });

		expect(diagnostics).toEqual(expectedDiagnostics(ids));

		expect(jsonl).not.toContain('"cwd"');
		expect(jsonl).not.toContain(sourceCwd);
		expect(jsonl).not.toContain("faux-key");
		expect(jsonl).not.toContain('"fullOutputPath"');
		expect(jsonl).not.toMatch(/"(text|thinking|thought)Signature"/);
		expect(jsonl).not.toContain('"details"');
		expect(jsonl).not.toContain('"systemMessage"');
		expect(jsonl).not.toContain('"role":"system"');
		expect(jsonl).not.toContain('"type":"custom"');
		expect(jsonl).not.toContain('"errorMessage"');
		expect(jsonl).not.toContain('"note"');
		for (const secret of [
			FIXTURE_SECRETS.detailsApiKey,
			FIXTURE_SECRETS.errorSecret,
			FIXTURE_SECRETS.noteSecret,
			FIXTURE_SECRETS.errorPath,
			FIXTURE_SECRETS.notePath,
			FIXTURE_SECRETS.extensionPath,
			FIXTURE_SECRETS.systemPromptPath,
			...FIXTURE_SECRETS.signatures,
		]) {
			expect(jsonl).not.toContain(secret);
		}

		// Content boundary: transcript text keeps paths the model already saw.
		expect(obj(arr(messageOf(byId.get(ids.bashToolResult)).content)[0]).text).toContain(
			`Full output: ${fixture.fullOutputPath}`,
		);
		expect(jsonl.split(fixture.fullOutputPath)).toHaveLength(2);
	});

	it("imports into another cwd and session dir with the same identity and context", () => {
		const { sm, fixture } = createFixtureSession();
		const { ids } = fixture;
		const exported = serializePortableSession(sm);
		const inputPath = join(createTempDir("pi-portable-file-"), "portable.jsonl");
		writeFileSync(inputPath, exported.jsonl);
		const destinationCwd = createTempDir("pi-portable-dest-");
		const sessionDir = join(createTempDir("pi-portable-sessions-"), "nested", "sessions");

		const importedPath = importPortableSession(inputPath, { cwd: destinationCwd, sessionDir });

		expect(existsSync(sessionDir)).toBe(true);
		expect(readdirSync(sessionDir)).toEqual([importedPath.slice(sessionDir.length + 1)]);
		expect(importedPath).toMatch(new RegExp(`_${sm.getSessionId()}\\.jsonl$`));
		const [nativeHeader] = parseJsonl(readFileSync(importedPath, "utf8"));
		expect(nativeHeader).toEqual({
			type: "session",
			version: 3,
			id: sm.getSessionId(),
			timestamp: sm.getHeader()!.timestamp,
			cwd: destinationCwd,
		});

		const imported = SessionManager.open(importedPath);
		const exportedEntries = parseJsonl(exported.jsonl).slice(1);
		expect(imported.getSessionId()).toBe(sm.getSessionId());
		expect(imported.getCwd()).toBe(destinationCwd);
		expect(imported.getEntries()).toEqual(exportedEntries);
		expect(imported.getLeafId()).toBe(exportedEntries.at(-1)!.id);
		expect(imported.getLabel(ids.user)).toBe("start");
		expect(imported.getSessionName()).toBe("Portable fixture");

		// The bash message loses only the local-file footer that fullOutputPath produced.
		const bashText = (entries: SessionEntry[]) =>
			JSON.stringify(convertToLlm(buildSessionContext(entries, ids.bashExecution).messages).at(-1));
		expect(bashText(sm.getEntries())).toContain(`[Output truncated. Full output: ${fixture.fullOutputPath}]`);
		expect(bashText(imported.getEntries())).toContain("[Output truncated]");
		expect(bashText(imported.getEntries())).not.toContain(fixture.fullOutputPath);
		expect(bashText(imported.getEntries())).toContain("line 1\\nline 2");

		// Context after the retain-none compaction: its summary, then the entries after it.
		const context = imported.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"custom",
			"branchSummary",
		]);
		expect(context.messages[0]).toMatchObject({ summary: "Built the project." });
		expect(context.messages[1]).toMatchObject({ content: [{ type: "text" }, FIXTURE_IMAGE] });
		expect(context.messages[2]).toMatchObject({
			content: [
				{ type: "text", text: "Edited answer." },
				{ type: "thinking", thinking: "Edited reasoning." },
			],
		});
		// Source context differs only by the excluded system prompt and the unsettled deferred turn.
		const sourceContext = sm.buildSessionContext();
		const portableSourceRoles = sourceContext.messages
			.filter((message) => message.role !== "system")
			.filter((message) => !(message.role === "assistant" && message.stopReason === "deferred"))
			.map((message) => message.role);
		expect(portableSourceRoles).toEqual(context.messages.map((message) => message.role));
		expect(context.model).toEqual(sourceContext.model);
		expect(context.thinkingLevel).toBe("high");

		const reexported = serializePortableSession(imported);
		expect(reexported.jsonl).toBe(exported.jsonl);
		expect(reexported.diagnostics).toEqual([
			{ code: "excluded_field", field: "header.cwd", message: "machine-specific path" },
		]);
	});

	it("remaps an unresolved legacy v1 compaction reference to retain none", () => {
		const dir = createTempDir("pi-portable-v1-");
		const timestamp = new Date().toISOString();
		const v1Path = join(dir, "v1.jsonl");
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "old answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "old-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const records = [
			{ type: "session", id: "legacy-session", timestamp, cwd: dir },
			{ type: "message", timestamp, message: { role: "user", content: "old question", timestamp: 1 } },
			{ type: "message", timestamp, message: assistantMessage },
			{ type: "compaction", timestamp, summary: "Old summary", firstKeptEntryIndex: 99, tokensBefore: 10 },
			{ type: "message", timestamp, message: { role: "user", content: "after compaction", timestamp: 2 } },
		];
		writeFileSync(v1Path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

		const source = SessionManager.open(v1Path);
		const compaction = source.getEntries().find((entry) => entry.type === "compaction")!;
		expect(compaction).not.toHaveProperty("firstKeptEntryId");

		const exported = serializePortableSession(source);
		expect(exported.diagnostics).toEqual([
			{ code: "excluded_field", field: "header.cwd", message: "machine-specific path" },
			{
				code: "remapped_reference",
				entryId: compaction.id,
				field: "compaction.firstKeptEntryId",
				message: "moved to an exported entry with the same retained context",
			},
		]);
		const exportedCompaction = parseJsonl(exported.jsonl).find((record) => record.type === "compaction")!;
		expect(exportedCompaction.firstKeptEntryId).toBe(compaction.id);

		const inputPath = join(dir, "portable.jsonl");
		writeFileSync(inputPath, exported.jsonl);
		const imported = SessionManager.open(
			importPortableSession(inputPath, { cwd: dir, sessionDir: join(dir, "sessions") }),
		);
		expect(imported.buildSessionContext()).toEqual(source.buildSessionContext());
		expect(imported.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
	});

	// Regression test for #2.
	it("reports content it normalizes instead of changing it silently", () => {
		const sm = SessionManager.inMemory(createTempDir("pi-portable-normalize-"));
		// Native loading tolerates these legacy or hand-built shapes.
		const user = sm.appendMessage({ role: "user", content: null, timestamp: 1 } as unknown as UserMessage);
		const assistant = sm.appendMessage({
			...assistantMsg(""),
			content: "plain answer",
		} as unknown as AssistantMessage);
		const toolResult = sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
			timestamp: 3,
		} as unknown as ToolResultMessage);
		const custom = sm.appendCustomMessageEntry("note", null as unknown as string, true);

		const exported = serializePortableSession(sm);

		const normalized = (entryId: string, field: string): PortableSessionDiagnostic => ({
			code: "normalized_value",
			entryId,
			field,
			message: "normalized to an array of content blocks",
		});
		expect(exported.diagnostics).toEqual([
			{ code: "excluded_field", field: "header.cwd", message: "machine-specific path" },
			normalized(user, "user.content"),
			normalized(assistant, "assistant.content"),
			normalized(toolResult, "toolResult.content"),
			normalized(custom, "custom_message.content"),
		]);
		const [, userRecord, assistantRecord, toolResultRecord, customRecord] = parseJsonl(exported.jsonl);
		expect(messageOf(userRecord).content).toEqual([]);
		expect(messageOf(assistantRecord).content).toEqual([{ type: "text", text: "plain answer" }]);
		expect(Object.keys(messageOf(toolResultRecord))).toEqual([
			"role",
			"toolCallId",
			"toolName",
			"content",
			"isError",
			"timestamp",
		]);
		expect(messageOf(toolResultRecord).content).toEqual([]);
		expect(Object.keys(customRecord)).toEqual([
			"type",
			"id",
			"parentId",
			"timestamp",
			"customType",
			"content",
			"display",
		]);

		const inputPath = join(createTempDir("pi-portable-normalize-file-"), "portable.jsonl");
		writeFileSync(inputPath, exported.jsonl);
		const dir = createTempDir("pi-portable-normalize-dest-");
		const imported = SessionManager.open(importPortableSession(inputPath, { cwd: dir, sessionDir: dir }));
		const reexported = serializePortableSession(imported);
		expect(reexported.jsonl).toBe(exported.jsonl);
		expect(reexported.diagnostics).toEqual([
			{ code: "excluded_field", field: "header.cwd", message: "machine-specific path" },
		]);
	});

	describe("import rejections", () => {
		function exportedRecords(): JsonRecord[] {
			return parseJsonl(serializePortableSession(createFixtureSession().sm).jsonl);
		}

		function writeLines(lines: string[]): string {
			const path = join(createTempDir("pi-portable-reject-"), "portable.jsonl");
			writeFileSync(path, `${lines.join("\n")}\n`);
			return path;
		}

		function expectRejected(
			lines: string[],
			code: PortableSessionErrorCode,
			location?: { line?: number; path?: string },
		): PortableSessionError {
			const inputPath = writeLines(lines);
			const sessionDir = join(createTempDir("pi-portable-reject-dest-"), "sessions");
			let caught: unknown;
			try {
				importPortableSession(inputPath, { cwd: tmpdir(), sessionDir });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PortableSessionError);
			const error = caught as PortableSessionError;
			expect(error.code).toBe(code);
			if (location?.line !== undefined) {
				expect(error.line).toBe(location.line);
				expect(error.message).toContain(`line ${location.line}`);
			}
			if (location?.path !== undefined) {
				expect(error.path).toBe(location.path);
				expect(error.message).toContain(location.path);
			}
			expect(existsSync(sessionDir)).toBe(false);
			return error;
		}

		function mutate(change: (records: JsonRecord[]) => void): string[] {
			const records = exportedRecords();
			change(records);
			return records.map((record) => JSON.stringify(record));
		}

		function findMessage(records: JsonRecord[], role: string): JsonRecord {
			return records.find((record) => record.type === "message" && obj(record.message).role === role)!;
		}

		it("rejects malformed JSON with its physical line", () => {
			const lines = mutate(() => {});
			lines.splice(2, 0, "", "{not json");
			expectRejected(lines, "invalid_json", { line: 4 });
		});

		it("rejects native files and invalid headers", () => {
			expectRejected(
				mutate((records) => {
					delete records[0].portable;
					records[0].cwd = tmpdir();
				}),
				"not_portable",
				{ line: 1 },
			);
			expectRejected(
				mutate((records) => {
					records[0].version = 2;
				}),
				"invalid_header",
				{
					line: 1,
					path: "$.version",
				},
			);
			for (const id of ["../escape", "a/b", ".."]) {
				expectRejected(
					mutate((records) => {
						records[0].id = id;
					}),
					"invalid_header",
					{
						line: 1,
						path: "$.id",
					},
				);
			}
			expectRejected(
				mutate((records) => {
					records[0].timestamp = 42;
				}),
				"invalid_header",
				{
					path: "$.timestamp",
				},
			);
			expectRejected(
				mutate((records) => records.splice(2, 0, records[0])),
				"duplicate_header",
				{
					line: 3,
				},
			);
			expectRejected(
				mutate((records) => records.shift()),
				"missing_header",
				{ line: 1 },
			);
		});

		it("rejects unknown types, roles, blocks, and fields", () => {
			expectRejected(
				mutate((records) => {
					records[1].type = "custom";
				}),
				"invalid_entry",
				{ line: 2, path: "$.type" },
			);
			expectRejected(
				mutate((records) => {
					messageOf(findMessage(records, "user")).role = "system";
				}),
				"invalid_entry",
				{ path: "$.message.role" },
			);
			expectRejected(
				mutate((records) => arr(messageOf(findMessage(records, "user")).content).push({ type: "file", uri: "x" })),
				"invalid_entry",
				{ path: "$.message.content[2].type" },
			);
			expectRejected(
				mutate((records) => {
					messageOf(findMessage(records, "toolResult")).details = {};
				}),
				"invalid_entry",
				{ path: "$.message.details" },
			);
			expectRejected(
				mutate((records) => {
					records[1].cwd = "/home/alice";
				}),
				"invalid_entry",
				{ line: 2, path: "$.cwd" },
			);
			expectRejected(
				mutate((records) => {
					records[1]["bad\u001bkey"] = true;
				}),
				"invalid_entry",
				{ line: 2, path: '$["bad\\u001bkey"]' },
			);
		});

		it("rejects broken graphs and references", () => {
			expectRejected(
				mutate((records) => {
					records[2].id = records[1].id;
				}),
				"duplicate_id",
				{ line: 3, path: "$.id" },
			);
			expectRejected(
				mutate((records) => {
					records[3].parentId = records[1].id;
				}),
				"invalid_parent",
				{ line: 4, path: "$.parentId" },
			);
			expectRejected(
				mutate((records) => {
					records.find((record) => record.type === "compaction")!.firstKeptEntryId = "gone";
				}),
				"unresolved_reference",
				{ path: "$.firstKeptEntryId" },
			);
			expectRejected(
				mutate((records) => {
					records.find((record) => record.type === "label")!.targetId = "gone";
				}),
				"unresolved_reference",
				{ path: "$.targetId" },
			);
			expectRejected(
				mutate((records) => {
					records.find((record) => record.type === "context_edit")!.targetId = "gone";
				}),
				"unresolved_reference",
				{ path: "$.targetId" },
			);
		});

		it("rejects context edits that break the target role's content rules", () => {
			const edit = (records: JsonRecord[]) => records.find((record) => record.type === "context_edit")!;
			expectRejected(
				mutate((records) => {
					obj(arr(obj(edit(records).replacement).content)[1]).thinkingSignature = "sig";
				}),
				"invalid_entry",
				{ path: "$.replacement.content[1].thinkingSignature" },
			);
			expectRejected(
				mutate((records) => arr(obj(edit(records).replacement).content).push(FIXTURE_IMAGE)),
				"invalid_entry",
				{ path: "$.replacement.content[2].type" },
			);
		});

		it("rejects unsettled assistants, free-form provider text, and usage notes", () => {
			expectRejected(
				mutate((records) => {
					messageOf(findMessage(records, "assistant")).stopReason = "deferred";
				}),
				"invalid_entry",
				{ path: "$.message.stopReason" },
			);
			expectRejected(
				mutate((records) => {
					messageOf(findMessage(records, "assistant")).errorMessage = "boom";
				}),
				"invalid_entry",
				{ path: "$.message.errorMessage" },
			);
			expectRejected(
				mutate((records) => {
					messageOf(findMessage(records, "assistant")).rawStopReason = "boom";
				}),
				"invalid_entry",
				{ path: "$.message.rawStopReason" },
			);
			expectRejected(
				mutate((records) => {
					records.find((record) => record.type === "usage")!.note = "boom";
				}),
				"invalid_entry",
				{ path: "$.note" },
			);
		});

		it("rejects an id that exists under another cwd in a custom session dir", () => {
			const { sm } = createFixtureSession();
			const sessionDir = createTempDir("pi-portable-conflict-");
			const otherCwd = createTempDir("pi-portable-other-cwd-");
			const nativePath = join(sessionDir, `native_${sm.getSessionId()}.jsonl`);
			writeFileSync(
				nativePath,
				`${JSON.stringify({ type: "session", version: 3, id: sm.getSessionId(), timestamp: "t", cwd: otherCwd })}\n`,
			);
			const inputPath = writeLines([serializePortableSession(sm).jsonl.trim()]);
			const destinationCwd = createTempDir("pi-portable-dest-cwd-");

			// findById() filters by cwd in a custom session dir, so it cannot see this conflict.
			expect(SessionManager.findById(destinationCwd, sm.getSessionId(), sessionDir)).toBeUndefined();
			expect(() => importPortableSession(inputPath, { cwd: destinationCwd, sessionDir })).toThrow(
				SessionImportIdConflictError,
			);
			expect(readdirSync(sessionDir)).toEqual([`native_${sm.getSessionId()}.jsonl`]);
		});

		it("rejects a portable file stored inside the session dir as a conflict with itself", () => {
			const { sm } = createFixtureSession();
			const sessionDir = createTempDir("pi-portable-self-");
			const inputPath = join(sessionDir, "portable.jsonl");
			writeFileSync(inputPath, serializePortableSession(sm).jsonl);

			let caught: unknown;
			try {
				importPortableSession(inputPath, { cwd: tmpdir(), sessionDir });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SessionImportIdConflictError);
			expect((caught as SessionImportIdConflictError).existingPath).toBe(inputPath);
			expect(readdirSync(sessionDir)).toEqual(["portable.jsonl"]);
		});

		it("rejects importing the same file twice", () => {
			const { sm } = createFixtureSession();
			const inputPath = writeLines([serializePortableSession(sm).jsonl.trim()]);
			const sessionDir = join(createTempDir("pi-portable-twice-"), "sessions");
			mkdirSync(sessionDir);
			const first = importPortableSession(inputPath, { cwd: tmpdir(), sessionDir });
			expect(() => importPortableSession(inputPath, { cwd: tmpdir(), sessionDir })).toThrow(
				`Session ${sm.getSessionId()} already exists: ${first}`,
			);
			expect(readdirSync(sessionDir)).toHaveLength(1);
		});
	});
});
