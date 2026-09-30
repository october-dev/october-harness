import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { resolveShellRunner, type ShellRunnerSelection } from "../../src/core/shell-runner.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { registerOctoberPermissions } from "../../src/extensions/october/permissions.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { installFakeDocker } from "../fake-docker-cli.ts";
import { createFakeShellRunner, type FakeShellRunner } from "../fake-shell-runner.ts";
import { createHarness, type Harness } from "./harness.ts";

// issue #17: shell runner routing, permission order and fixed selection across session replacement.

const describeUnix = process.platform === "win32" ? describe.skip : describe;

function createUiContext(confirm: boolean): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => confirm,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function customSelection(fake: FakeShellRunner): ShellRunnerSelection {
	return { kind: "custom", notice: "Shell runner: fake.", operations: fake.operations };
}

function toolResultText(harness: Harness): string {
	const result = harness.session.messages.find((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") return "";
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describeUnix("shell runner routing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		delete process.env.OCTOBER_PERMISSION_MODE;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(
		fake: FakeShellRunner,
		options: { mode?: "ask" | "bypass"; blockAll?: boolean; userBash?: BashOperations } = {},
	): Promise<Harness> {
		process.env.OCTOBER_PERMISSION_MODE = options.mode ?? "bypass";
		const harness = await createHarness({
			shellRunner: customSelection(fake),
			extensionFactories: [
				registerOctoberPermissions,
				(pi: ExtensionAPI) => {
					if (options.blockAll) pi.on("tool_call", () => ({ block: true, reason: "blocked by test" }));
					if (options.userBash) {
						const operations = options.userBash;
						pi.on("user_bash", () => ({ operations }));
					}
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	async function promptBash(harness: Harness): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 0" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run it");
	}

	it("never calls the runner when a tool_call handler blocks", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake, { blockAll: true });
		await promptBash(harness);
		expect(fake.calls).toEqual([]);
		expect(toolResultText(harness)).toContain("blocked by test");
	});

	it("never calls the runner when the October permission prompt is denied", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake, { mode: "ask" });
		await harness.session.bindExtensions({ uiContext: createUiContext(false) });
		await promptBash(harness);
		expect(fake.calls).toEqual([]);
		expect(toolResultText(harness)).toContain("denied by user");
	});

	it("never calls the runner when a headless session refuses the permission", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake, { mode: "ask" });
		await promptBash(harness);
		expect(fake.calls).toEqual([]);
		expect(toolResultText(harness)).toContain("non-interactive mode");
	});

	it("runs an allowed model bash call once in the runner, without PI_* session variables", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake, { mode: "ask" });
		await harness.session.bindExtensions({ uiContext: createUiContext(true) });
		await promptBash(harness);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].command).toBe("exit 0");
		expect(fake.calls[0].env?.PI_SESSION_ID).toBeUndefined();
		expect(harness.session.systemPrompt).not.toContain("PI_* environment variables");
	});

	it("routes ! and !! commands through the runner unless a user_bash extension supplies operations", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake);
		await harness.session.executeBash("exit 0");
		await harness.session.executeBash("exit 0", undefined, { excludeFromContext: true });
		expect(fake.calls.map((call) => call.command)).toEqual(["exit 0", "exit 0"]);

		const extensionOwned = createFakeShellRunner();
		const withUserBash = await harnessWith(createFakeShellRunner(), { userBash: extensionOwned.operations });
		// Same flow as interactive ! and RPC bash: the user_bash result decides the operations.
		const eventResult = await withUserBash.session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "exit 0",
			excludeFromContext: false,
			cwd: withUserBash.session.sessionManager.getCwd(),
		});
		await withUserBash.session.executeBash("exit 0", undefined, { operations: eventResult?.operations });
		expect(extensionOwned.calls).toHaveLength(1);
	});

	it("reports an invalid runner through ! commands instead of running on the host", async () => {
		const harness = await createHarness({
			shellRunner: await resolveShellRunner(
				{ error: "Global settings file x could not be loaded: Unexpected end of JSON input" },
				"/",
			),
		});
		harnesses.push(harness);
		const sentinel = join(harness.tempDir, "sentinel");
		await expect(harness.session.executeBash(`touch ${sentinel}`)).rejects.toThrow(/Shell runner: blocked/);
		expect(existsSync(sentinel)).toBe(false);
	});

	it.each<[string, () => Promise<ShellRunnerSelection | undefined>, boolean]>([
		["docker-like custom", async () => customSelection(createFakeShellRunner()), true],
		["invalid", () => resolveShellRunner({ error: "broken" }, "/"), true],
		["no setting", async () => undefined, false],
		["explicit host", () => resolveShellRunner({ settings: { type: "host" } }, "/"), false],
	])("guards the powershell tool for a %s selection", async (_name, select, rejected) => {
		const harness = await createHarness({ shellRunner: await select() });
		harnesses.push(harness);
		const powershell = harness.session.getToolDefinition("powershell");
		expect(powershell).toBeDefined();
		const run = powershell!.execute("call", { command: "Write-Output hi" }, undefined, undefined, undefined as never);
		if (rejected) {
			await expect(run).rejects.toThrow("The powershell tool is not available when a shell runner is configured.");
		} else if (process.platform !== "win32") {
			await expect(run).rejects.toThrow("The powershell tool is only available on Windows.");
		}
	});

	it("keeps the selection across reload after the global settings change", async () => {
		const fake = createFakeShellRunner();
		const harness = await harnessWith(fake);
		await harness.session.reload();
		await harness.session.executeBash("exit 0");
		expect(fake.calls).toHaveLength(1);
	});
});

describeUnix("shell runner selection across runtime replacement", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		vi.unstubAllEnvs();
	});

	async function createRuntime(globalSettings: Record<string, unknown>, extension?: (pi: ExtensionAPI) => void) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "shell-runner-runtime-")));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".october"), { recursive: true });
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(globalPath, JSON.stringify(globalSettings));
		// A project file cannot select the runner.
		writeFileSync(
			join(cwd, ".october", "settings.json"),
			JSON.stringify({ shellRunner: { type: "docker", image: "project:ignored" } }),
		);
		const docker = installFakeDocker(root);
		vi.stubEnv("PATH", `${docker.binDir}:${process.env.PATH}`);
		vi.stubEnv("FAKE_DOCKER_STATE", docker.stateDir);
		vi.stubEnv("DOCKER_HOST", undefined);
		vi.stubEnv("DOCKER_CONTEXT", undefined);

		const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
		// Mirrors main.ts: resolve once from the startup settings manager, reuse for every runtime.
		const shellRunner = await resolveShellRunner(
			SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getShellRunnerSettings(),
			cwd,
		);
		const createRuntimeFactory: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
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
							extension?.(pi);
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
					shellRunner,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntimeFactory, {
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		});
		await runtime.session.bindExtensions({});
		const state = { disposed: false };
		cleanups.push(async () => {
			if (!state.disposed) await runtime.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});
		return { runtime, faux, docker, globalPath, cwd, shellRunner, state };
	}

	async function exerciseReplacements(
		setup: Awaited<ReturnType<typeof createRuntime>>,
		check: (label: string) => Promise<void>,
	): Promise<void> {
		const { runtime, faux } = setup;
		await check("startup");
		await runtime.session.reload();
		await check("reload");
		faux.setResponses([fauxAssistantMessage("persisted")]);
		await runtime.session.prompt("persist the session");
		const firstSession = runtime.session.sessionFile!;
		await runtime.newSession();
		await check("new");
		await runtime.switchSession(firstSession);
		await check("resume");
		const userEntry = runtime.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		await runtime.fork(userEntry!.id);
		await check("fork");
	}

	it("keeps host after the global file switches to Docker mid-process", async () => {
		const setup = await createRuntime({});
		expect(setup.shellRunner).toEqual({ kind: "host" });
		writeFileSync(setup.globalPath, JSON.stringify({ shellRunner: { type: "docker", image: "shell:test" } }));
		await exerciseReplacements(setup, async (label) => {
			const sentinel = join(setup.cwd, `host-${label}`);
			await setup.runtime.session.executeBash(`touch ${sentinel}`);
			expect(existsSync(sentinel), label).toBe(true);
		});
		expect(setup.docker.calls("run")).toEqual([]);
	});

	it("keeps Docker after the global file switches to host mid-process, with the startup cwd as default mount", async () => {
		const setup = await createRuntime({ shellRunner: { type: "docker", image: "shell:test" } });
		expect(setup.shellRunner.kind).toBe("docker");
		expect(setup.shellRunner.notice).toContain(`Mounts: ${setup.cwd} (read-write).`);
		writeFileSync(setup.globalPath, JSON.stringify({ shellRunner: { type: "host" } }));
		let runs = 0;
		await exerciseReplacements(setup, async (label) => {
			await setup.runtime.session.executeBash("true");
			runs++;
			expect(setup.docker.calls("run"), label).toHaveLength(runs);
		});
	});

	it.each(["user command", "model call"])(
		"waits for in-flight model and user commands (%s released first); quit does not wait",
		async (first) => {
			let releaseTool!: () => void;
			let toolStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				toolStarted = resolve;
			});
			const setup = await createRuntime({}, (pi) => {
				pi.registerTool({
					name: "hold",
					label: "Hold",
					description: "Holds until aborted, then settles later",
					parameters: Type.Object({}),
					execute: (_id, _params, signal) =>
						new Promise<AgentToolResult<unknown>>((resolve) => {
							toolStarted();
							signal?.addEventListener("abort", () => {
								releaseTool = () => resolve({ content: [{ type: "text", text: "held" }], details: {} });
							});
						}),
				});
			});
			const { runtime, faux } = setup;
			let releaseUser!: () => void;
			let userAborted = false;
			const heldUserBash: BashOperations = {
				exec: (_command, _cwd, { onData, signal }) =>
					new Promise((_resolve, reject) => {
						onData(Buffer.from("partial output\n"));
						signal?.addEventListener("abort", () => {
							userAborted = true;
							releaseUser = () => reject(new Error("aborted"));
						});
					}),
			};

			faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]);
			const outgoing = runtime.session;
			const prompt = outgoing.prompt("hold");
			await started;
			const userCommand = outgoing.executeBash("held", undefined, { operations: heldUserBash });

			let replaced = false;
			const replacement = runtime.newSession().then(() => {
				replaced = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(userAborted).toBe(true);
			expect(replaced).toBe(false);
			const [releaseFirst, releaseSecond] =
				first === "user command" ? [releaseUser, releaseTool] : [releaseTool, releaseUser];
			releaseFirst();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(replaced).toBe(false);
			releaseSecond();
			await replacement;
			await prompt;
			const result = await userCommand;
			expect(result.cancelled).toBe(true);
			const persisted = outgoing.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "bashExecution");
			expect(persisted).toHaveLength(1);

			// Quit starts cancellation and returns without waiting.
			let quitRelease: (() => void) | undefined;
			const quitOperations: BashOperations = {
				exec: (_command, _cwd, { signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							quitRelease = () => reject(new Error("aborted"));
						});
					}),
			};
			const pendingQuitCommand = runtime.session.executeBash("held", undefined, { operations: quitOperations });
			setup.state.disposed = true;
			await runtime.dispose();
			expect(quitRelease).toBeDefined();
			quitRelease!();
			await pendingQuitCommand;
		},
	);
});
