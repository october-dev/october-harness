import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../src/core/extensions/types.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createExtensionTestHarness, type ExtensionTestHarness } from "../src/testing.ts";

const harnesses: ExtensionTestHarness[] = [];

async function createHarness(options: Parameters<typeof createExtensionTestHarness>[0] = {}) {
	const harness = await createExtensionTestHarness(options);
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.dispose();
});

describe("public extension testing harness", () => {
	it("waits for extension startup and captures session events emitted during startup", async () => {
		let finishStartup!: () => void;
		let startupDidStart = false;
		let startupFinished = false;
		let creationFinished = false;
		const startupGate = new Promise<void>((resolve) => {
			finishStartup = resolve;
		});
		const creation = createExtensionTestHarness({
			extensions: [
				(pi) => {
					pi.on("session_start", async () => {
						startupDidStart = true;
						await startupGate;
						pi.appendEntry("testing-startup", { ready: true });
						startupFinished = true;
					});
				},
			],
		});
		void creation.then(
			() => {
				creationFinished = true;
			},
			() => {},
		);
		let harness: ExtensionTestHarness | undefined;

		try {
			await vi.waitFor(() => expect(startupDidStart).toBe(true));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(creationFinished).toBe(false);
			finishStartup();
			harness = await creation;

			expect(startupFinished).toBe(true);
			expect(
				harness.events.some(
					(event) =>
						event.type === "entry_appended" &&
						event.entry.type === "custom" &&
						event.entry.customType === "testing-startup",
				),
			).toBe(true);
		} finally {
			finishStartup();
			const createdHarness = harness ?? (await creation.catch(() => undefined));
			await createdHarness?.dispose();
		}
	});

	it("loads factories, invokes a registered tool, and captures session events", async () => {
		let executions = 0;
		const harness = await createHarness({
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "greet",
						label: "Greet",
						description: "Return a greeting",
						parameters: Type.Object({ name: Type.String() }),
						async execute(_id, params) {
							executions++;
							return { content: [{ type: "text", text: `Hello ${params.name}` }], details: {} };
						},
					});
				},
			],
			responses: [
				fauxAssistantMessage(fauxToolCall("greet", { name: "Ada" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});

		await harness.prompt("greet Ada");

		expect(executions).toBe(1);
		expect(harness.events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(harness.events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(harness.events.some((event) => event.type === "agent_settled")).toBe(true);
	});

	it("uses deterministic responses, supports response updates, and does not need credentials", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Unexpected network request in extension test harness");
		});
		try {
			const harness = await createHarness({ responses: [fauxAssistantMessage("first")] });
			await harness.prompt("one");
			harness.appendResponses([fauxAssistantMessage("second")]);
			await harness.prompt("two");
			expect(harness.session.getLastAssistantText()).toBe("second");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});

	it("reports extension tool failures as tool execution events", async () => {
		const harness = await createHarness({
			extensions: [
				(pi) =>
					pi.registerTool({
						name: "fail",
						label: "Fail",
						description: "Fails deliberately",
						parameters: Type.Object({}),
						async execute() {
							throw new Error("expected failure");
						},
					}),
			],
			responses: [
				fauxAssistantMessage(fauxToolCall("fail", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("handled"),
			],
		});

		await harness.prompt("fail");
		expect(harness.events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("blocks an extension tool call before execution", async () => {
		let executions = 0;
		const harness = await createHarness({
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "blocked_tool",
						label: "Blocked tool",
						description: "A tool blocked by the test extension",
						parameters: Type.Object({}),
						async execute() {
							executions++;
							return { content: [{ type: "text", text: "executed" }], details: {} };
						},
					});
					pi.on("tool_call", (event) =>
						event.toolName === "blocked_tool" ? { block: true, reason: "denied by test" } : undefined,
					);
				},
			],
			responses: [
				fauxAssistantMessage(fauxToolCall("blocked_tool", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("handled"),
			],
		});

		await harness.prompt("try the blocked tool");

		expect(executions).toBe(0);
		const endEvent = harness.events.find(
			(event) => event.type === "tool_execution_end" && event.toolName === "blocked_tool",
		);
		expect(endEvent).toBeDefined();
		if (!endEvent || endEvent.type !== "tool_execution_end") throw new Error("Missing blocked tool end event");
		expect(endEvent.isError).toBe(true);
		expect(endEvent.result.content).toContainEqual({ type: "text", text: "denied by test" });
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "toolResult" && message.toolCallId === endEvent.toolCallId && message.isError === true,
			),
		).toBe(true);
	});

	it("propagates cancellation to a running extension tool and supports repeated disposal", async () => {
		let signal: AbortSignal | undefined;
		let started!: () => void;
		const executionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const harness = await createHarness({
			extensions: [
				(pi) =>
					pi.registerTool({
						name: "wait",
						label: "Wait",
						description: "Wait for cancellation",
						parameters: Type.Object({}),
						execute(_id, _params, toolSignal) {
							signal = toolSignal;
							started();
							return new Promise<AgentToolResult>((resolve) =>
								toolSignal?.addEventListener(
									"abort",
									() =>
										resolve({
											content: [{ type: "text", text: "aborted" }],
											details: {},
										}),
									{ once: true },
								),
							);
						},
					}),
			],
			responses: [fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })],
		});

		const prompt = harness.prompt("wait");
		await executionStarted;
		await harness.abort();
		await prompt;
		expect(signal?.aborted).toBe(true);
		await harness.dispose();
		await harness.dispose();
	});

	it("removes only helper-owned workspaces", async () => {
		const owned = await createHarness();
		const ownedCwd = owned.cwd;
		await owned.dispose();
		expect(existsSync(ownedCwd)).toBe(false);

		const callerCwd = mkdtempSync(join(tmpdir(), "october-caller-workspace-"));
		writeFileSync(join(callerCwd, "keep.txt"), "keep");
		const caller = await createHarness({ cwd: callerCwd });
		await caller.dispose();
		expect(existsSync(join(callerCwd, "keep.txt"))).toBe(true);
		rmSync(callerCwd, { recursive: true, force: true });
	});

	it("loads supplied factories without discovering workspace extensions", async () => {
		const callerCwd = mkdtempSync(join(tmpdir(), "october-extension-test-workspace-"));
		let harness: ExtensionTestHarness | undefined;
		try {
			const extensionDir = join(callerCwd, ".october", "extensions");
			mkdirSync(extensionDir, { recursive: true });
			writeFileSync(
				join(extensionDir, "workspace-extension.ts"),
				`import { Type } from "typebox";
export default (pi) => pi.registerTool({
	name: "workspace_only",
	label: "Workspace only",
	description: "Must not be auto-discovered by the test harness",
	parameters: Type.Object({}),
	async execute() { return { content: [{ type: "text", text: "unexpected" }], details: {} }; },
});
`,
			);
			harness = await createHarness({
				cwd: callerCwd,
				extensions: [
					(pi) =>
						pi.registerTool({
							name: "provided_factory",
							label: "Provided factory",
							description: "Explicitly supplied to the harness",
							parameters: Type.Object({}),
							async execute() {
								return { content: [{ type: "text", text: "provided" }], details: {} };
							},
						}),
				],
			});

			expect(harness.session.getActiveToolNames()).toContain("provided_factory");
			expect(harness.session.getActiveToolNames()).not.toContain("workspace_only");
		} finally {
			try {
				await harness?.dispose();
			} finally {
				rmSync(callerCwd, { recursive: true, force: true });
			}
		}
	});

	it("waits for active Bash work before removing its workspace", async () => {
		const harness = await createHarness();
		const workspace = harness.cwd;
		let started!: () => void;
		let aborted!: () => void;
		let finish!: () => void;
		let workspaceExistedWhenBashSettled: boolean | undefined;
		const bashStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const bashAborted = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const operations: BashOperations = {
			exec: (_command, cwd, { signal }) =>
				new Promise((resolve) => {
					started();
					signal?.addEventListener("abort", () => aborted(), { once: true });
					finish = () => {
						workspaceExistedWhenBashSettled = existsSync(cwd);
						resolve({ exitCode: 0 });
					};
				}),
		};
		const bash = harness.session.executeBash("held", undefined, { operations });
		await bashStarted;

		const disposing = harness.dispose();
		await bashAborted;
		expect(existsSync(workspace)).toBe(true);
		finish();
		await Promise.all([bash, disposing]);

		expect(workspaceExistedWhenBashSettled).toBe(true);
		expect(existsSync(workspace)).toBe(false);
	});

	it("cleans helper-owned resources after construction fails", async () => {
		const existing = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("october-extension-test-")));
		await expect(
			createExtensionTestHarness({
				get responses(): never {
					throw new Error("response setup failed");
				},
			}),
		).rejects.toThrow("response setup failed");
		const remaining = readdirSync(tmpdir()).filter(
			(name) => name.startsWith("october-extension-test-") && !existing.has(name),
		);
		expect(remaining).toEqual([]);
	});

	it("captures the extension shutdown event during disposal", async () => {
		let shutdownReason: string | undefined;
		const harness = await createHarness({
			extensions: [
				(pi) => {
					pi.on("session_shutdown", (event) => {
						shutdownReason = event.reason;
					});
				},
			],
		});

		await harness.dispose();

		expect(shutdownReason).toBe("quit");
		expect(harness.events).toContainEqual({ type: "session_shutdown", reason: "quit" });
	});
});
