import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	formatPortableCompatibilityReport,
	inspectPortableImport,
	type PortableCapabilities,
	type PortableReferenceStatus,
	type PreparedPortableImport,
	preparePortableImport,
	SessionImportError,
	SessionImportSelectionRequiredError,
	serializePortableSession,
} from "../src/core/session-portable.ts";
import { VIRTUAL_MODEL_API } from "../src/core/virtual-models.ts";

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

function assistant(
	provider: string,
	model: string,
	content: AssistantMessage["content"] = [],
	api = "test-api",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api,
		provider,
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** Export `sm` as a portable file and prepare it for import, as an import call would. */
function prepare(sm: SessionManager): { prepared: PreparedPortableImport; sessionDir: string } {
	const dir = createTempDir("pi-portable-compat-");
	const path = join(dir, "portable.jsonl");
	writeFileSync(path, serializePortableSession(sm).jsonl);
	const sessionDir = join(dir, "sessions");
	return { prepared: preparePortableImport(path, { cwd: dir, sessionDir }), sessionDir };
}

function newSession(): SessionManager {
	return SessionManager.inMemory(createTempDir("pi-portable-compat-source-"));
}

function capabilities(overrides: Partial<PortableCapabilities> = {}): PortableCapabilities {
	return {
		model: () => "available",
		isVirtualModel: () => false,
		tool: () => "available",
		renderer: () => "available",
		...overrides,
	};
}

describe("portable import compatibility", () => {
	describe("next-turn requirement", () => {
		it("is the last model selection", () => {
			const sm = newSession();
			sm.appendMessage(assistant("old", "old-model"));
			sm.appendModelChange("new", "new-model");

			const report = inspectPortableImport(prepare(sm).prepared, capabilities());

			expect(report.requirement).toEqual({ provider: "new", modelId: "new-model", status: "available", count: 1 });
		});

		it("is the last response when it comes after the selection", () => {
			const sm = newSession();
			sm.appendModelChange("chosen", "chosen-model");
			sm.appendMessage(assistant("answered", "answered-model"));

			const report = inspectPortableImport(prepare(sm).prepared, capabilities());

			expect(report.requirement).toMatchObject({ provider: "answered", modelId: "answered-model" });
		});

		it("stays on a virtual selection that later physical responses came from", () => {
			const sm = newSession();
			sm.appendModelChange("router", "auto");
			sm.appendMessage(assistant("physical", "physical-model"));

			const report = inspectPortableImport(
				prepare(sm).prepared,
				capabilities({ isVirtualModel: (provider) => provider === "router" }),
			);

			expect(report.requirement).toMatchObject({ provider: "router", modelId: "auto" });
		});

		it("skips responses that a virtual model produced", () => {
			const sm = newSession();
			sm.appendModelChange("chosen", "chosen-model");
			sm.appendMessage(assistant("router", "auto", [], VIRTUAL_MODEL_API));

			const report = inspectPortableImport(prepare(sm).prepared, capabilities());

			expect(report.requirement).toMatchObject({ provider: "chosen", modelId: "chosen-model" });
		});

		it("is absent when the file names no model, and does not block", () => {
			const sm = newSession();
			sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

			const report = inspectPortableImport(prepare(sm).prepared, capabilities({ model: () => "missing" }));

			expect(report.requirement).toBeUndefined();
			expect(report.blocking).toBe(false);
		});
	});

	describe("blocking", () => {
		it.each<[PortableReferenceStatus, boolean]>([
			["available", false],
			["missing", true],
			["no_auth", true],
			["unknown", true],
		])("with a %s requirement, blocking is %s", (status, blocking) => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");

			const report = inspectPortableImport(prepare(sm).prepared, capabilities({ model: () => status }));

			expect(report.requirement?.status).toBe(status);
			expect(report.blocking).toBe(blocking);
		});

		it("does not block on missing or unknown tools and custom message types", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");
			sm.appendMessage(
				assistant("dest", "dest-model", [{ type: "toolCall", id: "c1", name: "ext_lookup", arguments: {} }]),
			);
			sm.appendMessage(toolResult("c1", "ext_lookup"));
			sm.appendCustomMessageEntry("review-note", [{ type: "text", text: "note" }], true);

			const report = inspectPortableImport(
				prepare(sm).prepared,
				capabilities({ tool: () => "missing", renderer: () => "unknown" }),
			);

			expect(report.blocking).toBe(false);
			expect(report.historicalTools).toEqual([{ name: "ext_lookup", status: "missing", count: 2 }]);
			expect(report.customMessages).toEqual([{ name: "review-note", status: "unknown", count: 1 }]);
		});
	});

	describe("historical references", () => {
		it("lists earlier models other than the requirement, with counts and statuses", () => {
			const sm = newSession();
			sm.appendMessage(assistant("retired", "retired-model"));
			sm.appendMessage(assistant("retired", "retired-model"));
			sm.appendModelChange("dest", "dest-model");

			const report = inspectPortableImport(
				prepare(sm).prepared,
				capabilities({ model: (provider) => (provider === "retired" ? "missing" : "available") }),
			);

			expect(report.blocking).toBe(false);
			expect(report.historicalModels).toEqual([
				{ provider: "retired", modelId: "retired-model", status: "missing", count: 2 },
			]);
			expect(report.historicalModels).not.toContainEqual(expect.objectContaining({ provider: "dest" }));
		});

		it("counts each custom message type once per entry", () => {
			const sm = newSession();
			sm.appendCustomMessageEntry("a-note", [{ type: "text", text: "1" }], true);
			sm.appendCustomMessageEntry("a-note", [{ type: "text", text: "2" }], false);
			sm.appendCustomMessageEntry("b-note", [{ type: "text", text: "3" }], true);

			const report = inspectPortableImport(prepare(sm).prepared, capabilities());

			expect(report.customMessages).toEqual([
				{ name: "a-note", status: "available", count: 2 },
				{ name: "b-note", status: "available", count: 1 },
			]);
		});
	});

	describe("report text", () => {
		it("names the blocked model and gives remediation for each missing reference", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");
			sm.appendMessage(
				assistant("dest", "dest-model", [{ type: "toolCall", id: "c1", name: "ext_lookup", arguments: {} }]),
			);
			sm.appendCustomMessageEntry("review-note", [{ type: "text", text: "note" }], true);
			const report = inspectPortableImport(
				prepare(sm).prepared,
				capabilities({ model: () => "missing", tool: () => "missing", renderer: () => "missing" }),
			);

			const text = formatPortableCompatibilityReport(report).join("\n");

			expect(text).toContain("Next turn model: dest/dest-model (missing)");
			expect(text).toContain("Choose a replacement");
			expect(text).toContain("history tool ext_lookup (1)");
			expect(text).toContain("Enable the extension that provides it");
			expect(text).toContain("custom message review-note (1)");
			expect(text).toContain("default display");
			expect(text).toContain("Blocked: choose a replacement model.");
		});

		it("says a compatible file is not blocked", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");

			const lines = formatPortableCompatibilityReport(inspectPortableImport(prepare(sm).prepared, capabilities()));

			expect(lines).toContain("Next turn model: dest/dest-model (available)");
			expect(lines.at(-1)).toBe("Not blocked.");
		});

		it("gives different remediation for a model without credentials", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");

			const text = formatPortableCompatibilityReport(
				inspectPortableImport(prepare(sm).prepared, capabilities({ model: () => "no_auth" })),
			).join("\n");

			expect(text).toContain("no credentials here");
		});
	});

	describe("inspection", () => {
		it("writes nothing, not even the session directory", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");
			const { prepared, sessionDir } = prepare(sm);

			inspectPortableImport(prepared, capabilities({ model: () => "missing" }));

			expect(existsSync(sessionDir)).toBe(false);
			expect(existsSync(prepared.destination)).toBe(false);
		});
	});

	describe("selection required error", () => {
		it("carries the report and is an import error", () => {
			const sm = newSession();
			sm.appendModelChange("dest", "dest-model");
			const report = inspectPortableImport(prepare(sm).prepared, capabilities({ model: () => "missing" }));

			const error = new SessionImportSelectionRequiredError(report);

			expect(error).toBeInstanceOf(SessionImportError);
			expect(error.report).toBe(report);
			expect(error.message).toContain("needs a replacement model");
		});
	});
});
