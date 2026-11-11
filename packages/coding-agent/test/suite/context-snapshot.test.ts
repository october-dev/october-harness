import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextItem, ContextSnapshot } from "../../src/core/context-snapshot.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import type { ResourceLoader, Skill } from "../../src/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const ROOT_AGENTS = { path: "/proj/AGENTS.md", content: "root rules" };
const PKG_AGENTS = { path: "/proj/pkg/AGENTS.md", content: "package rules" };

function createSkill(name: string, disableModelInvocation: boolean): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation,
	};
}

function createLoader(overrides: Partial<ResourceLoader> = {}): ResourceLoader {
	return { ...createTestResourceLoader(), ...overrides };
}

function requireSnapshot(harness: Harness, requestId?: string): ContextSnapshot {
	const snapshot = harness.session.getContextSnapshot({ requestId });
	if (!snapshot) throw new Error("expected a context snapshot");
	return snapshot;
}

function itemsOfKind(snapshot: ContextSnapshot, kind: ContextItem["kind"]): ContextItem[] {
	return snapshot.items.filter((item) => item.kind === kind);
}

/** Capture the request the provider receives for the next prompt. */
function captureRequest(harness: Harness): () => TranscriptContext {
	let request: TranscriptContext | undefined;
	harness.setResponses([
		(context) => {
			request = context;
			return fauxAssistantMessage("ok");
		},
	]);
	return () => {
		if (!request) throw new Error("expected a provider request");
		return request;
	};
}

describe("context snapshot", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createTestHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	describe("known source contributions", () => {
		it("has no snapshot before the first request", async () => {
			const harness = await createTestHarness();

			expect(harness.session.getContextSnapshot()).toBeUndefined();
		});

		it("groups instructions, tools and conversation in inclusion order with sizes", async () => {
			const harness = await createTestHarness({
				resourceLoader: createLoader({
					getAgentsFiles: () => ({ agentsFiles: [ROOT_AGENTS, PKG_AGENTS] }),
					getSkills: () => ({ skills: [createSkill("visible", false)], diagnostics: [] }),
				}),
			});
			const getRequest = captureRequest(harness);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			expect(snapshot.items.map((item) => item.index)).toEqual(snapshot.items.map((_, index) => index));

			const instructions = itemsOfKind(snapshot, "instructions");
			expect(instructions.map((item) => item.sourceId)).toEqual(
				expect.arrayContaining([ROOT_AGENTS.path, PKG_AGENTS.path, "section:preamble", "section:skills"]),
			);
			const files = instructions.filter((item) => item.sourceId?.startsWith("/proj/"));
			expect(files.map((item) => item.sourceId)).toEqual([ROOT_AGENTS.path, PKG_AGENTS.path]);
			expect(files.every((item) => item.attributed)).toBe(true);

			const tools = itemsOfKind(snapshot, "tools");
			expect(tools.map((item) => item.sourceId)).toEqual(
				getCurrentTools(getRequest().messages).map((tool) => tool.name),
			);

			const conversation = itemsOfKind(snapshot, "conversation");
			expect(conversation).toHaveLength(1);
			expect(conversation[0]).toMatchObject({ role: "user", attributed: true });
			expect(conversation[0]?.sourceId).toBe(
				harness.sessionManager
					.getBranch()
					.find((entry) => entry.type === "message" && entry.message.role === "user")?.id,
			);

			// Instructions precede tools, tools precede the conversation.
			const lastInstruction = Math.max(...instructions.map((item) => item.index));
			const firstTool = Math.min(...tools.map((item) => item.index));
			expect(lastInstruction).toBeLessThan(firstTool);
			expect(Math.max(...tools.map((item) => item.index))).toBeLessThan(conversation[0]!.index);

			// Sizes are chars/4 estimates that add up. A context file counts as the block the model receives.
			for (const item of snapshot.items) {
				expect(item.estTokens).toBeGreaterThan(0);
			}
			const rootFile = files[0];
			const rootBlock = `<project_instructions path="${ROOT_AGENTS.path}">\n${ROOT_AGENTS.content}\n</project_instructions>`;
			expect(rootFile?.estTokens).toBe(Math.ceil(rootBlock.length / 4));
			expect(snapshot.totalEstTokens).toBe(snapshot.items.reduce((sum, item) => sum + item.estTokens, 0));
			expect(snapshot.estimator).toBe("chars/4");

			expect(snapshot.groups.map((group) => group.kind)).toEqual(["instructions", "tools", "conversation"]);
			expect(snapshot.groups.find((group) => group.kind === "instructions")?.itemCount).toBe(instructions.length);
		});

		it("describes the same context the provider received", async () => {
			const harness = await createTestHarness();
			const getRequest = captureRequest(harness);

			await harness.session.prompt("hello");

			const request = getRequest();
			const snapshot = requireSnapshot(harness);
			const sentMessages = request.messages.filter((message) => message.role !== "system");
			const described = snapshot.items.filter((item) => item.kind !== "instructions" && item.kind !== "tools");
			expect(described).toHaveLength(sentMessages.length);
			expect(itemsOfKind(snapshot, "tools").map((item) => item.sourceId)).toEqual(
				getCurrentTools(request.messages).map((tool) => tool.name),
			);
		});

		it("attributes bus and extension messages to their custom type", async () => {
			const harness = await createTestHarness();
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.sendCustomMessage({
				customType: "october-bus",
				content: "peer says hi",
				display: false,
			});
			await harness.session.sendCustomMessage({
				customType: "plan-note",
				content: "remember the plan",
				display: false,
			});
			await harness.session.prompt("go");

			const snapshot = requireSnapshot(harness);
			expect(itemsOfKind(snapshot, "bus")).toEqual([
				expect.objectContaining({ role: "custom", sourceId: "october-bus", attributed: true }),
			]);
			expect(itemsOfKind(snapshot, "extension")).toEqual([
				expect.objectContaining({ role: "custom", sourceId: "plan-note", attributed: true }),
			]);
		});
	});

	describe("inspection does not touch sources or the model", () => {
		it("reads the stored snapshot without reloading resources or calling the provider", async () => {
			const getAgentsFiles = vi.fn(() => ({ agentsFiles: [ROOT_AGENTS] }));
			const harness = await createTestHarness({ resourceLoader: createLoader({ getAgentsFiles }) });
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			const loaderCalls = getAgentsFiles.mock.calls.length;
			const providerCalls = harness.faux.state.callCount;

			const first = harness.session.getContextSnapshot();
			const revealed = harness.session.getContextSnapshot({ includeContent: true });
			const second = harness.session.getContextSnapshot();

			expect(first).toEqual(second);
			expect(revealed?.requestId).toBe(first?.requestId);
			expect(getAgentsFiles.mock.calls.length).toBe(loaderCalls);
			expect(harness.faux.state.callCount).toBe(providerCalls);
		});

		it("keeps one snapshot per request and only the most recent five", async () => {
			const harness = await createTestHarness();
			harness.setResponses(Array.from({ length: 7 }, () => fauxAssistantMessage("ok")));
			for (let turn = 1; turn <= 7; turn++) await harness.session.prompt(`turn ${turn}`);

			expect(harness.session.getContextSnapshot()?.requestId).toBe("7");
			expect(harness.session.getContextSnapshot({ requestId: "3" })?.requestId).toBe("3");
			expect(harness.session.getContextSnapshot({ requestId: "2" })).toBeUndefined();
			expect(harness.session.getContextSnapshot({ requestId: "1" })).toBeUndefined();
		});
	});

	describe("content reveal", () => {
		it("returns metadata only unless content is requested explicitly", async () => {
			const harness = await createTestHarness({
				resourceLoader: createLoader({ getAgentsFiles: () => ({ agentsFiles: [ROOT_AGENTS] }) }),
			});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("secret question");

			const metadata = requireSnapshot(harness);
			expect(metadata.items.every((item) => !("content" in item))).toBe(true);
			expect(JSON.stringify(metadata)).not.toContain("secret question");
			expect(JSON.stringify(metadata)).not.toContain("root rules");

			const revealed = harness.session.getContextSnapshot({ includeContent: true });
			const file = revealed?.items.find((item) => item.sourceId === ROOT_AGENTS.path);
			expect(file?.content).toContain("root rules");
			const user = revealed?.items.find((item) => item.kind === "conversation");
			expect(user?.content).toContain("secret question");
		});
	});

	describe("compaction", () => {
		it("reports the summary as one item and the summarized history as omitted", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "test" },
							},
						}));
					},
				],
			});
			harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			await harness.session.compact();
			harness.setResponses([fauxAssistantMessage("three")]);

			await harness.session.prompt("third");

			const snapshot = requireSnapshot(harness);
			const summaries = itemsOfKind(snapshot, "compaction");
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).toMatchObject({ role: "compactionSummary", attributed: true });
			const omitted = snapshot.omitted.find((entry) => entry.reason === "compacted");
			expect(omitted).toMatchObject({ kind: "conversation", reason: "compacted" });
			expect(omitted?.count).toBeGreaterThan(0);
			expect(omitted?.estTokens).toBeGreaterThan(0);
			expect(snapshot.groups.map((group) => group.kind)).toContain("compaction");
		});
	});

	describe("extension changes", () => {
		it("attributes a message a context handler adds to that extension", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("context", async (event) => ({
							messages: [
								...event.messages,
								{ role: "user", content: [{ type: "text", text: "injected by extension" }], timestamp: 0 },
							],
						}));
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			const injected = itemsOfKind(snapshot, "extension");
			expect(injected).toHaveLength(1);
			expect(injected[0]).toMatchObject({ role: "user", attributed: true });
			expect(snapshot.transforms).toEqual([
				expect.objectContaining({ event: "context", extensionPath: injected[0]?.sourceId, added: 1, removed: 0 }),
			]);
			// The original prompt is still attributed to the conversation.
			expect(itemsOfKind(snapshot, "conversation")).toHaveLength(1);
		});

		it("records a message a handler removes without listing it as an item", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("context", async (event) => ({
							messages: event.messages.filter((message: AgentMessage) => message.role !== "user"),
						}));
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			expect(itemsOfKind(snapshot, "conversation")).toHaveLength(0);
			expect(snapshot.transforms).toEqual([expect.objectContaining({ event: "context", added: 0, removed: 1 })]);
		});

		it("marks a prompt section from an unidentified extension as unattributed", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.sections.mcp_servers = "server list";
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const section = requireSnapshot(harness).items.find((item) => item.sourceId === "section:mcp_servers");
			expect(section).toMatchObject({ kind: "extension", attributed: false });
		});
	});

	describe("omitted content", () => {
		it("explains a skill hidden from the model", async () => {
			const harness = await createTestHarness({
				resourceLoader: createLoader({
					getSkills: () => ({
						skills: [createSkill("shown", false), createSkill("hidden", true)],
						diagnostics: [],
					}),
				}),
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			expect(snapshot.omitted).toContainEqual(
				expect.objectContaining({ kind: "instructions", sourceId: "hidden", reason: "skill_hidden_from_model" }),
			);
			expect(snapshot.omitted.some((entry) => entry.sourceId === "shown")).toBe(false);
		});

		it("explains a bash message excluded from context and flags truncated bash output", async () => {
			const harness = await createTestHarness();
			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "echo hidden",
				output: "hidden output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: Date.now(),
			});
			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "seq 1 100000",
				output: "1\n2\n3",
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/full.log",
				timestamp: Date.now(),
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			expect(snapshot.omitted).toContainEqual(
				expect.objectContaining({ kind: "conversation", reason: "excluded_from_context" }),
			);
			const bashItems = snapshot.items.filter((item) => item.role === "bashExecution");
			expect(bashItems).toHaveLength(1);
			expect(bashItems[0]?.truncated).toEqual({ reason: "bash_output_truncated" });
		});

		it("explains a message removed by a context edit", async () => {
			const harness = await createTestHarness();
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("first");
			const firstUser = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!firstUser) throw new Error("expected the first user entry");
			harness.sessionManager.appendContextEdit(firstUser.id, null);

			await harness.session.prompt("second");

			const snapshot = requireSnapshot(harness);
			expect(snapshot.omitted).toContainEqual(
				expect.objectContaining({ sourceId: firstUser.id, reason: "context_edit", kind: "conversation" }),
			);
			expect(snapshot.items.some((item) => item.sourceId === firstUser.id)).toBe(false);
		});
	});

	describe("context_with_system handlers", () => {
		it("attributes a message a context_with_system handler adds to that extension", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("context_with_system", async (event) => ({
							messages: [
								...event.messages,
								{ role: "user", content: [{ type: "text", text: "added with system" }], timestamp: 0 },
							],
						}));
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			const added = itemsOfKind(snapshot, "extension");
			expect(added).toHaveLength(1);
			expect(snapshot.transforms).toEqual([
				expect.objectContaining({ event: "context_with_system", extensionPath: added[0]?.sourceId, added: 1 }),
			]);
		});
	});

	describe("messages that cannot be serialized", () => {
		it("does not break the request and still reports the message", async () => {
			const harness = await createTestHarness({
				extensionFactories: [
					(pi) => {
						pi.on("context", async (event) => ({ messages: [...event.messages] }));
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.sendCustomMessage({
				customType: "plan-note",
				content: "has a bigint",
				display: false,
				details: { size: 10n },
			});

			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			expect(itemsOfKind(snapshot, "extension")).toEqual([
				expect.objectContaining({ role: "custom", sourceId: "plan-note" }),
			]);
			expect(itemsOfKind(snapshot, "conversation")).toHaveLength(1);
		});
	});

	describe("revealing one item", () => {
		it("returns the content of only the requested item", async () => {
			const harness = await createTestHarness({
				resourceLoader: createLoader({ getAgentsFiles: () => ({ agentsFiles: [ROOT_AGENTS] }) }),
			});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");

			const snapshot = requireSnapshot(harness);
			const file = snapshot.items.find((item) => item.sourceId === ROOT_AGENTS.path);
			if (!file) throw new Error("expected the context file item");

			expect(harness.session.getContextItemContent(file.index)).toContain("root rules");
			expect(harness.session.getContextItemContent(file.index, snapshot.requestId)).toContain("root rules");
			expect(harness.session.getContextItemContent(snapshot.items.length)).toBeUndefined();
			expect(harness.session.getContextItemContent(0, "999")).toBeUndefined();
		});
	});
});
