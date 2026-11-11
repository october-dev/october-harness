import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	importPortableSession,
	type PortableCompatibilityReport,
	PortableSessionError,
	SessionImportError,
	SessionImportIdConflictError,
	SessionImportSelectionRequiredError,
	serializePortableSession,
} from "../../src/core/session-portable.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionAPI, ExtensionFactory, SessionBeforeSwitchEvent, SessionStartEvent } from "../../src/index.ts";
import { createSessionManager } from "../../src/main.ts";
import {
	buildPortableFixture,
	FIXTURE_IMAGE,
	type PortableFixtureModel,
} from "../fixtures/portable-session-fixture.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Export the canonical fixture from a source "machine" and return the portable file path. The fixture's
 * model is the default faux model unless `model` names one the destination has.
 */
function writePortableFixture(model?: PortableFixtureModel): { path: string; sessionId: string; jsonl: string } {
	const source = SessionManager.inMemory(createTempDir("pi-portable-suite-source-"));
	buildPortableFixture(source, join(createTempDir("pi-portable-suite-bash-"), "bash.log"), model);
	const { jsonl } = serializePortableSession(source);
	const path = join(createTempDir("pi-portable-suite-file-"), "portable.jsonl");
	writeFileSync(path, jsonl);
	return { path, sessionId: source.getSessionId(), jsonl };
}

function writePortableFile(sessionManager: SessionManager): string {
	const path = join(createTempDir("pi-portable-suite-custom-"), "portable.jsonl");
	writeFileSync(path, serializePortableSession(sessionManager).jsonl);
	return path;
}

function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** An assistant turn from the given model, with the given content. */
function assistantMessage(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
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

function toolResultMessage(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("portable sessions in a running session", () => {
	// Regression test for #2.
	it("continues an imported session from the exported leaf with destination prompt and tools", async () => {
		const portable = writePortableFixture();
		const destinationCwd = createTempDir("pi-portable-suite-dest-");
		const sessionDir = join(destinationCwd, "sessions");
		const importedPath = importPortableSession(portable.path, { cwd: destinationCwd, sessionDir });
		const sessionManager = SessionManager.open(importedPath, sessionDir);
		const importedLeaf = sessionManager.getLeafId();

		const harness: Harness = await createHarness({ sessionManager });
		cleanups.push(() => harness.cleanup());
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("continued");
			},
		]);

		await harness.session.prompt("continue please");

		const messages: Message[] = request!.messages;
		// The imported transcript carries no system state, so the destination declares its own
		// prompt sections and tools in one system message right before the new prompt.
		const systemMessages = messages.filter((message) => message.role === "system");
		expect(systemMessages).toHaveLength(1);
		const declared = messages.at(-2);
		if (declared?.role !== "system") throw new Error("expected the destination to declare its system prompt");
		expect(Object.keys(declared.sections ?? {}).length).toBeGreaterThan(0);
		expect(declared.toolsAdded?.map((tool) => tool.name)).toEqual(harness.session.getActiveToolNames());

		const texts = messages.map((message) => getMessageText(message));
		expect(texts).toContain(`${COMPACTION_SUMMARY_PREFIX}Built the project.\n</summary>`);
		expect(texts).toContain("Edited answer.");
		expect(texts).not.toContain("Original answer.");
		const attachment = messages.find((message) => getMessageText(message) === "Here is a screenshot.");
		expect(attachment?.content).toEqual([{ type: "text", text: "Here is a screenshot." }, FIXTURE_IMAGE]);
		expect(texts.at(-1)).toBe("continue please");

		const reopened = SessionManager.open(importedPath, sessionDir);
		const appended = reopened.getEntries().slice(portable.jsonl.trim().split("\n").length - 1);
		expect(appended[0]?.parentId).toBe(importedLeaf);
		expect(appended.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(reopened.getSessionId()).toBe(portable.sessionId);
	});
});

describe("AgentSessionRuntime portable import", () => {
	async function createRuntimeForTest(extensionFactory: ExtensionFactory = () => {}, options = { persisted: true }) {
		const tempDir = createTempDir("pi-portable-runtime-");
		const sessionDir = join(tempDir, "sessions");
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one")]);
		cleanups.push(() => faux.unregister());

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: options.persisted
				? SessionManager.create(tempDir, sessionDir)
				: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(() => runtime.dispose());
		await runtime.session.prompt("hello");
		// The model a portable file must name to be compatible with this runtime.
		const portableModel: PortableFixtureModel = {
			api: faux.api,
			provider: faux.getModel().provider,
			model: faux.getModel().id,
		};
		return { runtime, tempDir, sessionDir, portableModel };
	}

	// Regression test for #2.
	it("switches to the imported session in the runtime cwd", async () => {
		const events: Array<SessionBeforeSwitchEvent | SessionStartEvent> = [];
		const { runtime, tempDir, sessionDir, portableModel } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => void events.push(event));
			pi.on("session_start", (event) => void events.push(event));
		});
		const previousSessionFile = runtime.session.sessionFile;
		const portable = writePortableFixture(portableModel);
		events.length = 0;

		const result = await runtime.importPortable(portable.path);
		await runtime.session.bindExtensions({});

		expect(result).toEqual({ cancelled: false });
		const imported = runtime.session.sessionManager;
		expect(runtime.cwd).toBe(tempDir);
		expect(imported.getCwd()).toBe(tempDir);
		expect(imported.getSessionId()).toBe(portable.sessionId);
		expect(runtime.session.sessionFile).toMatch(new RegExp(`^${sessionDir}/.+_${portable.sessionId}\\.jsonl$`));
		expect(JSON.parse(readFileSync(runtime.session.sessionFile!, "utf8").split("\n")[0])).toMatchObject({
			id: portable.sessionId,
			cwd: tempDir,
		});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile },
		]);
	});

	// Regression test for #2.
	it("writes nothing and keeps the session when the switch is cancelled, the file is invalid, or the id exists", async () => {
		let cancel = false;
		const { runtime, sessionDir, portableModel } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
		});
		const originalSession = runtime.session;
		const filesBefore = listFiles(sessionDir);
		const portable = writePortableFixture(portableModel);

		cancel = true;
		expect(await runtime.importPortable(portable.path)).toEqual({ cancelled: true });
		expect(runtime.session).toBe(originalSession);
		expect(listFiles(sessionDir)).toEqual(filesBefore);
		cancel = false;

		const invalidPath = join(createTempDir("pi-portable-invalid-"), "invalid.jsonl");
		writeFileSync(invalidPath, portable.jsonl.replace('"portable":1,', '"portable":1,"cwd":"/home/alice",'));
		await expect(runtime.importPortable(invalidPath)).rejects.toThrow(PortableSessionError);
		expect(runtime.session).toBe(originalSession);
		expect(listFiles(sessionDir)).toEqual(filesBefore);

		await runtime.importPortable(portable.path);
		const importedSession = runtime.session;
		const filesAfterImport = listFiles(sessionDir);
		await expect(runtime.importPortable(portable.path)).rejects.toThrow(SessionImportIdConflictError);
		expect(runtime.session).toBe(importedSession);
		expect(listFiles(sessionDir)).toEqual(filesAfterImport);
	});

	// Regression test for #2.
	it("keeps native /import behavior and routes marked files to the portable importer", async () => {
		const { runtime, tempDir, sessionDir, portableModel } = await createRuntimeForTest();
		const nativeDir = createTempDir("pi-portable-native-");
		const nativePath = join(nativeDir, "native.jsonl");
		const nativeContent = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "native-session",
			timestamp: new Date().toISOString(),
			cwd: nativeDir,
		})}\n`;
		writeFileSync(nativePath, nativeContent);

		const portableError = await runtime.importPortable(nativePath).catch((error: unknown) => error);
		expect(portableError).toBeInstanceOf(PortableSessionError);
		expect((portableError as PortableSessionError).code).toBe("not_portable");

		await runtime.importFromJsonl(nativePath);
		expect(runtime.session.sessionFile).toBe(join(sessionDir, "native.jsonl"));
		// Copied verbatim; runtime creation then appends the restored model and thinking level.
		expect(readFileSync(runtime.session.sessionFile!, "utf8").startsWith(nativeContent)).toBe(true);
		expect(runtime.cwd).toBe(nativeDir);

		const portable = writePortableFixture(portableModel);
		await runtime.importFromJsonl(portable.path, tempDir);
		expect(runtime.session.sessionManager.getSessionId()).toBe(portable.sessionId);
		// Portable files take the runtime cwd; the native cwd override does not apply.
		expect(runtime.session.sessionManager.getCwd()).toBe(nativeDir);
		expect(runtime.session.sessionFile).toMatch(new RegExp(`_${portable.sessionId}\\.jsonl$`));
	});

	// Regression test for #2.
	it("rejects import before switching when session persistence is disabled", async () => {
		const { runtime } = await createRuntimeForTest(undefined, { persisted: false });
		const originalSession = runtime.session;
		const error = await runtime.importPortable(writePortableFixture().path).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SessionImportError);
		expect((error as Error).message).toBe("Cannot import a session while session persistence is disabled");
		expect(runtime.session).toBe(originalSession);
	});

	it("blocks an import whose model is not registered here and writes nothing", async () => {
		const { runtime, sessionDir } = await createRuntimeForTest();
		const originalSession = runtime.session;
		const filesBefore = listFiles(sessionDir);

		// The default fixture model is not registered in this runtime.
		const error = await runtime.importPortable(writePortableFixture().path).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SessionImportSelectionRequiredError);
		const report = (error as SessionImportSelectionRequiredError).report;
		expect(report.blocking).toBe(true);
		expect(report.requirement).toEqual(
			expect.objectContaining({ provider: "faux-provider", modelId: "faux-model", status: "missing" }),
		);
		expect(runtime.session).toBe(originalSession);
		expect(listFiles(sessionDir)).toEqual(filesBefore);
	});

	it("cancels when the model chooser returns nothing, and writes nothing", async () => {
		const { runtime, sessionDir } = await createRuntimeForTest();
		const filesBefore = listFiles(sessionDir);
		const reports: PortableCompatibilityReport[] = [];

		const result = await runtime.importPortable(writePortableFixture().path, {
			chooseModel: async (report) => {
				reports.push(report);
				return undefined;
			},
		});

		expect(result).toEqual({ cancelled: true });
		expect(reports).toHaveLength(1);
		expect(reports[0]!.blocking).toBe(true);
		expect(listFiles(sessionDir)).toEqual(filesBefore);
	});

	it("records a chosen replacement model as the next model change", async () => {
		const { runtime, portableModel } = await createRuntimeForTest();
		const portable = writePortableFixture();

		const result = await runtime.importPortable(portable.path, {
			model: { provider: portableModel.provider, modelId: portableModel.model },
		});

		expect(result).toEqual({ cancelled: false });
		expect(runtime.session.model?.provider).toBe(portableModel.provider);
		expect(runtime.session.model?.id).toBe(portableModel.model);
		expect(runtime.session.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "model_change",
				provider: portableModel.provider,
				modelId: portableModel.model,
			}),
		);
	});

	it("rejects a replacement that is not registered here, before writing", async () => {
		const { runtime, sessionDir } = await createRuntimeForTest();
		const filesBefore = listFiles(sessionDir);

		const error = await runtime
			.importPortable(writePortableFixture().path, { model: { provider: "no-such-provider", modelId: "none" } })
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SessionImportError);
		expect((error as Error).message).toBe("Replacement model no-such-provider/none is not available here (missing)");
		expect(listFiles(sessionDir)).toEqual(filesBefore);
	});

	it("reports a compatible file as available and not blocking, and imports it", async () => {
		const { runtime, sessionDir, portableModel } = await createRuntimeForTest();
		const filesBefore = listFiles(sessionDir);
		const portable = writePortableFixture(portableModel);

		const report = runtime.inspectPortableImport(portable.path);

		expect(report.blocking).toBe(false);
		expect(report.requirement).toEqual(
			expect.objectContaining({
				provider: portableModel.provider,
				modelId: portableModel.model,
				status: "available",
			}),
		);
		expect(report.historicalTools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "read", status: "available" })]),
		);
		// The fixture's custom message type has no renderer in this runtime. It is informational only.
		expect(report.customMessages).toEqual([expect.objectContaining({ name: "review-note", status: "missing" })]);
		expect(listFiles(sessionDir)).toEqual(filesBefore);

		expect(await runtime.importPortable(portable.path)).toEqual({ cancelled: false });
	});

	it("does not block on a tool from history that is not registered here", async () => {
		const { runtime, portableModel } = await createRuntimeForTest();
		const sessionManager = SessionManager.inMemory(createTempDir("pi-portable-suite-tool-"));
		sessionManager.appendModelChange(portableModel.provider, portableModel.model);
		sessionManager.appendMessage(
			assistantMessage({ api: portableModel.api, provider: portableModel.provider, id: portableModel.model }, [
				{ type: "toolCall", id: "call-lookup", name: "ext_lookup", arguments: {} },
			]),
		);
		sessionManager.appendMessage(toolResultMessage("call-lookup", "ext_lookup"));
		const path = writePortableFile(sessionManager);

		const report = runtime.inspectPortableImport(path);

		expect(report.blocking).toBe(false);
		// One tool call and one result name the tool.
		expect(report.historicalTools).toEqual([
			expect.objectContaining({ name: "ext_lookup", status: "missing", count: 2 }),
		]);
		expect(await runtime.importPortable(path)).toEqual({ cancelled: false });
	});

	it("does not block on an earlier model that is no longer available", async () => {
		const { runtime, portableModel } = await createRuntimeForTest();
		const sessionManager = SessionManager.inMemory(createTempDir("pi-portable-suite-history-"));
		sessionManager.appendMessage(
			assistantMessage({ api: portableModel.api, provider: "retired-provider", id: "retired-model" }, [
				{ type: "text", text: "Earlier answer." },
			]),
		);
		sessionManager.appendModelChange(portableModel.provider, portableModel.model);
		const path = writePortableFile(sessionManager);

		const report = runtime.inspectPortableImport(path);

		expect(report.blocking).toBe(false);
		expect(report.historicalModels).toEqual([
			expect.objectContaining({ provider: "retired-provider", modelId: "retired-model", status: "missing" }),
		]);
		expect(await runtime.importPortable(path)).toEqual({ cancelled: false });
	});
});

describe("same-machine sessions across entry points", () => {
	// Regression test for #2.
	it("opens an SDK-persisted session by id through the CLI session resolver", async () => {
		const cwd = createTempDir("pi-portable-same-machine-");
		const sessionDir = join(cwd, "sessions");
		mkdirSync(sessionDir);
		const harness = await createHarness({ sessionManager: SessionManager.create(cwd, sessionDir) });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("persisted")]);
		await harness.session.prompt("persist me");

		const sessionId = harness.sessionManager.getSessionId();
		const opened = await createSessionManager(
			parseArgs(["--session", sessionId]),
			cwd,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(opened.getSessionFile()).toBe(harness.sessionManager.getSessionFile());
		expect(opened.getSessionId()).toBe(sessionId);
		expect(opened.getEntries()).toEqual(harness.sessionManager.getEntries());
		expect(opened.getLeafId()).toBe(harness.sessionManager.getLeafId());
	});
});
