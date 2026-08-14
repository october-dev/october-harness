import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import { registerOctoberPermissions } from "../src/extensions/october/permissions.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

function dummyTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: `${name}-ok` }],
			details: {},
		}),
	};
}

function permissionExtension(mode: "ask" | "accept-edits" | "bypass") {
	return (pi: Parameters<typeof registerOctoberPermissions>[0]) => {
		process.env.OCTOBER_PERMISSION_MODE = mode;
		registerOctoberPermissions(pi);
	};
}

async function runTool(mode: "ask" | "accept-edits" | "bypass", toolName: string): Promise<Harness> {
	process.env.OCTOBER_PERMISSION_MODE = mode;
	const harness = await createHarness({
		tools: [dummyTool("read"), dummyTool("edit"), dummyTool("bash")],
		extensionFactories: [permissionExtension(mode)],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return harness;
}

function toolResult(harness: Harness) {
	return harness.session.messages.find((message) => message.role === "toolResult");
}

afterEach(() => {
	delete process.env.OCTOBER_PERMISSION_MODE;
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("october permission modes", () => {
	it("ask allows read and blocks edit/bash in headless mode", async () => {
		const read = await runTool("ask", "read");
		expect(toolResult(read)?.role === "toolResult" && toolResult(read)?.isError).toBeFalsy();

		const edit = await runTool("ask", "edit");
		expect(toolResult(edit)?.role === "toolResult" && toolResult(edit)?.isError).toBe(true);
		expect(
			toolResult(edit)?.role === "toolResult" &&
				toolResult(edit).content.some(
					(part) =>
						part.type === "text" && part.text.includes("blocked by permission mode ask in non-interactive mode"),
				),
		).toBe(true);

		const bash = await runTool("ask", "bash");
		expect(toolResult(bash)?.role === "toolResult" && toolResult(bash)?.isError).toBe(true);
	});

	it("accept-edits allows read and edit, blocks bash in headless mode", async () => {
		const read = await runTool("accept-edits", "read");
		expect(toolResult(read)?.role === "toolResult" && toolResult(read)?.isError).toBeFalsy();

		const edit = await runTool("accept-edits", "edit");
		expect(toolResult(edit)?.role === "toolResult" && toolResult(edit)?.isError).toBeFalsy();

		const bash = await runTool("accept-edits", "bash");
		expect(toolResult(bash)?.role === "toolResult" && toolResult(bash)?.isError).toBe(true);
		expect(
			toolResult(bash)?.role === "toolResult" &&
				toolResult(bash).content.some(
					(part) =>
						part.type === "text" &&
						part.text.includes("blocked by permission mode accept-edits in non-interactive mode"),
				),
		).toBe(true);
	});

	it("bypass allows read, edit, and bash without a tool_call subscription", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				delete process.env.OCTOBER_PERMISSION_MODE;
				registerOctoberPermissions(pi);
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:october-permissions>",
		);
		expect(extension.handlers.has("tool_call")).toBe(false);

		const read = await runTool("bypass", "read");
		const edit = await runTool("bypass", "edit");
		const bash = await runTool("bypass", "bash");
		expect(toolResult(read)?.role === "toolResult" && toolResult(read)?.isError).toBeFalsy();
		expect(toolResult(edit)?.role === "toolResult" && toolResult(edit)?.isError).toBeFalsy();
		expect(toolResult(bash)?.role === "toolResult" && toolResult(bash)?.isError).toBeFalsy();
	});

	it("does not subscribe to tool_call when the built-in extension stays in bypass", async () => {
		delete process.env.OCTOBER_PERMISSION_MODE;
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			octoberExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:october>",
		);
		expect(extension.handlers.has("tool_call")).toBe(false);
	});
});
