import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import {
	InMemorySettingsStorage,
	type SettingsManager,
	SettingsManager as SettingsManagerClass,
} from "../../src/core/settings-manager.ts";
import generalMcpExtension from "../../src/extensions/mcp/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const stdioFixture = fileURLToPath(new URL("../fixtures/general-mcp-stdio-server.mjs", import.meta.url));

function mcpExtensions(settingsManager: SettingsManager): InlineExtension[] {
	return [
		{
			name: "mcp",
			factory: (pi: ExtensionAPI) => generalMcpExtension(pi, () => settingsManager.getSettings().mcpServers),
			hidden: true,
		},
	];
}

function stdioServer() {
	return { transport: "stdio" as const, command: process.execPath, args: [stdioFixture], timeoutMs: 2_000 };
}

describe("general MCP session integration", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	// Regression coverage for october-dev/october-harness#8.
	it("registers a session-owned stdio tool and completes a model tool-call turn", async () => {
		const harness = await createHarness({
			settings: { mcpServers: { fixture: stdioServer() } },
			extensionFactories: mcpExtensions,
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toContain("mcp__fixture__echo");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { text: "session round trip" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the MCP fixture");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(getMessageText(toolResult)).toBe("session round trip");
	});

	// Regression coverage for october-dev/october-harness#8.
	it("blocks every MCP tool when normalized names collide", async () => {
		const harness = await createHarness({
			settings: { mcpServers: { "A B": stdioServer(), a_b: stdioServer() } },
			extensionFactories: mcpExtensions,
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames().filter((name) => name.startsWith("mcp__"))).toEqual([]);
	});

	// Regression coverage for october-dev/october-harness#8.
	it("ignores project MCP servers until project settings are trusted", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ mcpServers: { project: stdioServer() } }, null, 2));
		const untrustedSettings = SettingsManagerClass.fromStorage(storage, { projectTrusted: false });
		const untrustedHarness = await createHarness({
			settingsManager: untrustedSettings,
			extensionFactories: mcpExtensions,
		});
		harnesses.push(untrustedHarness);

		await untrustedHarness.session.bindExtensions({});
		expect(untrustedHarness.session.getActiveToolNames().filter((name) => name.startsWith("mcp__"))).toEqual([]);

		const trustedSettings = SettingsManagerClass.fromStorage(storage, { projectTrusted: true });
		const trustedHarness = await createHarness({
			settingsManager: trustedSettings,
			extensionFactories: mcpExtensions,
		});
		harnesses.push(trustedHarness);

		await trustedHarness.session.bindExtensions({});
		expect(trustedHarness.session.getActiveToolNames()).toContain("mcp__project__echo");
	});
});
