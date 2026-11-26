import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type ContextSnapshot, formatContextSnapshot } from "../src/core/context-snapshot.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { isTruncatedToolResult } from "../src/core/tools/render-utils.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
	return {
		requestId: "3",
		createdAt: 0,
		estimator: "chars/4",
		totalEstTokens: 1500,
		items: [
			{
				index: 0,
				kind: "instructions",
				sourceId: "section:preamble",
				label: "section:preamble",
				role: "system",
				attributed: true,
				estTokens: 1000,
			},
			{
				index: 1,
				kind: "instructions",
				sourceId: "/proj/AGENTS.md",
				label: "/proj/AGENTS.md",
				role: "system",
				attributed: true,
				estTokens: 100,
				content: "SECRET FILE TEXT",
			},
			{
				index: 2,
				kind: "extension",
				sourceId: "section:mcp_servers",
				label: "section:mcp_servers",
				role: "system",
				attributed: false,
				estTokens: 50,
			},
			{
				index: 3,
				kind: "conversation",
				sourceId: "entry-1",
				label: "bashExecution",
				role: "bashExecution",
				attributed: true,
				estTokens: 350,
				truncated: { reason: "bash_output_truncated" },
			},
		],
		groups: [
			{ kind: "instructions", itemCount: 2, estTokens: 1100 },
			{ kind: "extension", itemCount: 1, estTokens: 50 },
			{ kind: "conversation", itemCount: 1, estTokens: 350 },
		],
		omitted: [
			{ kind: "conversation", reason: "compacted", count: 12, estTokens: 3400 },
			{ kind: "instructions", reason: "skill_hidden_from_model", sourceId: "hidden" },
		],
		transforms: [{ extensionPath: "/ext/notes.ts", event: "context", added: 1, removed: 2 }],
		...overrides,
	};
}

describe("formatContextSnapshot", () => {
	it("labels the request and that sizes are estimates", () => {
		const text = formatContextSnapshot(createSnapshot());

		expect(text).toContain("request 3");
		expect(text).toContain("estimated");
		expect(text).toContain("chars/4");
		expect(text).toContain("~1,500 tokens");
	});

	it("lists groups in order with their items, sizes and inclusion index", () => {
		const text = formatContextSnapshot(createSnapshot());

		expect(text).toContain("Instructions (2 items, ~1,100 tokens)");
		expect(text).toContain("Conversation (1 item, ~350 tokens)");
		expect(text.indexOf("Instructions")).toBeLessThan(text.indexOf("Extensions"));
		expect(text.indexOf("Extensions")).toBeLessThan(text.indexOf("Conversation"));
		expect(text).toMatch(/#0\s+section:preamble\s+~1,000 tokens/);
		expect(text).toMatch(/#1\s+\/proj\/AGENTS\.md\s+~100 tokens/);
	});

	it("marks unattributed and truncated items explicitly", () => {
		const text = formatContextSnapshot(createSnapshot());

		expect(text).toMatch(/#2\s+section:mcp_servers.*\[unattributed\]/);
		expect(text).toMatch(/#3\s+bashExecution.*\[truncated: bash_output_truncated\]/);
		expect(text).not.toMatch(/#0.*\[unattributed\]/);
	});

	it("lists omissions with their reasons and extension transforms", () => {
		const text = formatContextSnapshot(createSnapshot());

		expect(text).toContain("Omitted (2)");
		expect(text).toMatch(/compacted.*12 conversation items.*~3,400 tokens/);
		expect(text).toMatch(/skill_hidden_from_model.*hidden/);
		expect(text).toContain("Extension changes");
		expect(text).toMatch(/\/ext\/notes\.ts.*context.*\+1.*-2/);
	});

	it("never prints item content", () => {
		expect(formatContextSnapshot(createSnapshot())).not.toContain("SECRET FILE TEXT");
	});

	it("omits the omitted and extension sections when there are none", () => {
		const text = formatContextSnapshot(createSnapshot({ omitted: [], transforms: [] }));

		expect(text).not.toContain("Omitted");
		expect(text).not.toContain("Extension changes");
	});
});

describe("/context command", () => {
	// Regression test for #47.
	it("cleans terminal controls, bounds a reveal and explains invalid selections", () => {
		initTheme("dark");
		const snapshot = createSnapshot();
		snapshot.items[0]!.label = "lab\x1b[2Jel\r\x07";
		const view: Component[] = [];
		const ctx = {
			session: {
				getContextSnapshot: () => snapshot,
				getContextItemContent: () => `con\x1b[2Jtent\r\x07\n${"z".repeat(100_000)}SECRET_SUFFIX`,
			},
			showStatus: vi.fn(),
			chatContainer: { addChild: (item: Component) => view.push(item) },
			ui: { requestRender: () => {} },
		};
		const { handleContextCommand } = InteractiveMode.prototype as unknown as {
			handleContextCommand(this: typeof ctx, text: string): void;
		};
		handleContextCommand.call(ctx, "/context reveal bad");
		expect(ctx.showStatus).toHaveBeenLastCalledWith("Usage: /context [reveal <index>]");
		handleContextCommand.call(ctx, "/context reveal 999");
		expect(ctx.showStatus).toHaveBeenLastCalledWith("Request 3 has no context item #999.");
		handleContextCommand.call(ctx, "/context");
		expect(view.at(-1)?.render(160).join("\n")).toContain("label");
		handleContextCommand.call(ctx, "/context reveal 0");
		const revealed = view.at(-1)!.render(160).join("\n");
		expect(revealed).toContain("label");
		expect(revealed).toContain("content");
		expect(revealed).toContain("100,000");
		expect(revealed).not.toMatch(/SECRET_SUFFIX|\x1b\[2J|\r|\x07/);
	});

	it.each([
		[{ truncation: { truncated: true } }, true],
		[{ linesTruncated: true }, true],
		[{ matchLimitReached: 100 }, true],
		[{ resultLimitReached: 10 }, true],
		[{ entryLimitReached: 50 }, true],
		[{ truncation: { truncated: false } }, false],
	] as const)("reads the tool result limit signal %j", (details, expected) => {
		expect(isTruncatedToolResult(details)).toBe(expected);
	});
	it("is a built-in slash command that mentions reveal", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "context");

		expect(command).toBeDefined();
		expect(command?.argumentHint).toContain("reveal");
	});
});
