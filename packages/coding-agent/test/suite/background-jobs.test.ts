// october-dev/october-harness#16: reference background jobs extension, harness integration.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundJobs from "../../examples/extensions/background-jobs/index.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { readCapabilityManifest } from "../../src/core/extensions/capabilities.ts";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createOctoberPermissionController,
	registerOctoberPermissions,
} from "../../src/extensions/october/permissions.ts";
import type { ResourceLoader } from "../../src/index.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// Examples import the public package name; resolve it to this checkout's source.
vi.mock("@earendil-works/pi-coding-agent", () => vi.importActual("../../src/index.ts"));

const EXAMPLE = join(import.meta.dirname, "..", "..", "examples", "extensions", "background-jobs", "index.ts");
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "background-jobs.mjs");
const isWindows = process.platform === "win32";

function quote(value: string): string {
	const normalized = isWindows ? value.replaceAll("\\", "/") : value;
	return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function fixture(...args: string[]): string {
	return [process.execPath, FIXTURE, ...args].map(quote).join(" ");
}

const harnesses: Harness[] = [];
const cleanups: Array<() => Promise<void>> = [];
const fixturePids = new Set<number>();

afterEach(async () => {
	// Dispose jobs before the synchronous harness cleanup.
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	while (cleanups.length > 0) await cleanups.pop()?.();
	for (const pid of fixturePids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	fixturePids.clear();
});

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await delay(10);
	}
}

function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (process.platform !== "linux") return false;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

function createUiContext(options: { confirm?: boolean; notes?: string[] }): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => options.confirm ?? false,
		input: async () => undefined,
		notify: (message) => options.notes?.push(message),
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

async function setup(extensionFactories: ExtensionFactory[] = [backgroundJobs]): Promise<Harness> {
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	return harness;
}

interface ToolOutcome {
	text: string;
	isError: boolean;
}

async function callTool(harness: Harness, args: Parameters<typeof fauxToolCall>[1]): Promise<ToolOutcome> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("background_jobs", args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	await harness.session.prompt("go");
	const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
	if (result?.role !== "toolResult") throw new Error("missing tool result");
	return { text: getMessageText(result), isError: result.isError };
}

async function startJob(harness: Harness, command: string): Promise<{ id: string; pid: number }> {
	const result = await callTool(harness, { action: "start", command });
	expect(result.isError).toBe(false);
	const match = /^Started (job-[0-9a-f-]{36}) \(pid (\d+)\)/.exec(result.text);
	if (!match) throw new Error(`unexpected start result: ${result.text}`);
	fixturePids.add(Number(match[2]));
	return { id: match[1], pid: Number(match[2]) };
}

/** Run a /jobs command headlessly and return what it printed. */
async function jobsCommand(harness: Harness, args: string): Promise<string> {
	const writes: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		writes.push(String(chunk));
		return true;
	});
	try {
		await harness.session.prompt(`/jobs${args ? ` ${args}` : ""}`);
	} finally {
		spy.mockRestore();
	}
	return writes.join("");
}

describe("background jobs extension", () => {
	it("declares a valid shell capability sidecar and loads through the extension loader", async () => {
		expect(readCapabilityManifest(EXAMPLE)).toMatchObject({
			status: "declared",
			manifest: { manifestVersion: 1, shell: true },
		});
		const result = await loadExtensions([EXAMPLE], tmpdir());
		expect(result.errors).toEqual([]);
		expect([...result.extensions[0].tools.keys()]).toEqual(["background_jobs"]);
		expect([...result.extensions[0].commands.keys()]).toEqual(["jobs"]);
	});

	it("returns a job ID while the job runs and lets the next turn complete", async () => {
		const harness = await setup();
		expect(harness.session.getActiveToolNames()).toContain("background_jobs");
		const job = await startJob(harness, fixture("wait"));

		harness.setResponses([fauxAssistantMessage("still talking")]);
		await harness.session.prompt("anything else?");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("still talking");
		expect(processGone(job.pid)).toBe(false);

		const status = await callTool(harness, { action: "status", id: job.id });
		expect(status.text).toContain(`${job.id}: running`);
		const cancelled = await callTool(harness, { action: "cancel", id: job.id });
		expect(cancelled.text).toContain(`${job.id}: cancelled`);
		await until(() => processGone(job.pid));
	});

	it("reports invalid fields and unknown IDs as tool errors", async () => {
		const harness = await setup();
		expect(await callTool(harness, { action: "start", command: "true", id: "x" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("id is not used by start"),
		});
		expect(await callTool(harness, { action: "status" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("status requires id"),
		});
		expect(await callTool(harness, { action: "start" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("start requires command"),
		});
		expect(await callTool(harness, { action: "log", id: "job-missing" })).toMatchObject({
			isError: true,
			text: expect.stringContaining('Unknown job ID "job-missing"'),
		});
	});

	it("reports a failed start with its reason", async () => {
		const harness = await setup();
		rmSync(harness.tempDir, { recursive: true, force: true });
		const result = await callTool(harness, { action: "start", command: "true" });
		mkdirSync(harness.tempDir, { recursive: true });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/Job job-.* failed to start: Working directory does not exist/);
	});

	it("keeps log responses within 50KB and 2000 lines including metadata, defaulting to 100 lines", async () => {
		const harness = await setup();
		const many = await startJob(harness, fixture("lines", "3000"));
		const flood = await startJob(harness, fixture("flood", String(1024 * 1024)));
		for (const job of [many, flood]) {
			await until(async () => (await jobsCommand(harness, `status ${job.id}`)).includes(": exited"));
		}

		const defaultTail = await callTool(harness, { action: "log", id: many.id });
		const outputLines = defaultTail.text.split("\n").filter((line) => line.startsWith("line "));
		expect(outputLines).toHaveLength(100);
		expect(outputLines[0]).toBe("line 2901");

		const byLines = await callTool(harness, { action: "log", id: many.id, tail: 2000 });
		expect(byLines.text.split("\n").length).toBeLessThanOrEqual(2000);
		expect(byLines.text).toMatch(/\[omitted UTF-16 code units: \d+ outside the 2000-line tail/);

		const byBytes = await callTool(harness, { action: "log", id: flood.id, tail: 2000 });
		expect(Buffer.byteLength(byBytes.text)).toBeLessThanOrEqual(50 * 1024);
		expect(byBytes.text.split("\n").length).toBeLessThanOrEqual(2000);

		const next = Number(/\| next (\d+)\]/.exec(byBytes.text)?.[1]);
		const again = await callTool(harness, { action: "log", id: flood.id, since: next });
		expect(again.text).toContain("(no new output)");
	});

	it("adds one completion message during streaming without triggering a turn or logs", async () => {
		const harness = await setup();
		let completionSent!: () => void;
		const completion = new Promise<void>((resolve) => {
			completionSent = resolve;
		});
		const original = harness.session.sendCustomMessage.bind(harness.session);
		const calls: unknown[] = [];
		vi.spyOn(harness.session, "sendCustomMessage").mockImplementation(async (message, options) => {
			calls.push(options);
			await original(message, options);
			completionSent();
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("background_jobs", { action: "start", command: fixture("exit", "0") })], {
				stopReason: "toolUse",
			}),
			async () => {
				await completion;
				return fauxAssistantMessage("finished streaming");
			},
		]);
		await harness.session.prompt("start it");

		expect(calls).toEqual([{ triggerTurn: false }]);
		expect(harness.getPendingResponseCount()).toBe(0);
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles.filter((role) => role === "assistant")).toHaveLength(2);
		const notices = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "background-job",
		);
		expect(notices).toHaveLength(1);
		const notice = getMessageText(notices[0]);
		expect(notice).toMatch(/^Background job job-.* exited \(code 0\)/);
		expect(notice).not.toContain("exiting with 0");
		expect(notice.length).toBeLessThan(600);
	});
});

describe("background jobs permissions", () => {
	afterEach(() => {
		delete process.env.OCTOBER_PERMISSION_MODE;
	});

	async function permissionHarness(
		mode: "ask" | "accept-edits" | "bypass",
		extra: ExtensionFactory[] = [],
	): Promise<{ harness: Harness; marker: string }> {
		process.env.OCTOBER_PERMISSION_MODE = mode;
		const controller = createOctoberPermissionController();
		const harness = await setup([(pi) => registerOctoberPermissions(pi, controller), ...extra, backgroundJobs]);
		return { harness, marker: join(harness.tempDir, "marker.txt") };
	}

	it.each(["ask", "accept-edits"] as const)("blocks starts in headless %s mode before spawning", async (mode) => {
		const { harness, marker } = await permissionHarness(mode);
		const result = await callTool(harness, { action: "start", command: fixture("marker", marker) });
		expect(result).toMatchObject({
			isError: true,
			text: expect.stringContaining(`blocked by permission mode ${mode}`),
		});
		expect(await jobsCommand(harness, "")).toContain("No background jobs.");
		await delay(200);
		expect(existsSync(marker)).toBe(false);
	});

	it("blocks starts denied by a tool_call hook", async () => {
		const block = (pi: ExtensionAPI) => {
			pi.on("tool_call", (event) =>
				event.toolName === "background_jobs" ? { block: true, reason: "no jobs" } : undefined,
			);
		};
		const { harness, marker } = await permissionHarness("bypass", [block]);
		const result = await callTool(harness, { action: "start", command: fixture("marker", marker) });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("no jobs") });
		expect(await jobsCommand(harness, "")).toContain("No background jobs.");
	});

	it("blocks starts under a read-only delegation ceiling", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const controller = createOctoberPermissionController();
		const harness = await setup([(pi) => registerOctoberPermissions(pi, controller), backgroundJobs]);
		controller.setTemporaryCeiling("read-only");
		const result = await callTool(harness, { action: "start", command: "true" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("read-only ceiling") });
		expect(await jobsCommand(harness, "")).toContain("No background jobs.");
	});

	it.each([true, false])("asks in UI ask mode (approved=%s)", async (approved) => {
		const { harness, marker } = await permissionHarness("ask");
		await harness.session.bindExtensions({ uiContext: createUiContext({ confirm: approved }), mode: "tui" });
		const result = await callTool(harness, { action: "start", command: fixture("marker", marker) });
		expect(result.isError).toBe(!approved);
		if (approved) await until(() => existsSync(marker));
		else expect(result.text).toContain("denied by user");
	});

	it("allows starts in bypass mode", async () => {
		const { harness, marker } = await permissionHarness("bypass");
		const job = await startJob(harness, fixture("marker", marker));
		await until(() => existsSync(marker));
		expect(job.id).toMatch(/^job-/);
	});
});

describe("/jobs command", () => {
	it("inspects and cancels jobs without a model call and cannot start jobs", async () => {
		const harness = await setup();
		const job = await startJob(harness, fixture("wait"));
		const messageCount = harness.session.messages.length;

		expect(await jobsCommand(harness, "")).toContain(`${job.id} running`);
		expect(await jobsCommand(harness, `status ${job.id}`)).toContain(`${job.id}: running`);
		await until(async () => (await jobsCommand(harness, `log ${job.id}`)).includes("ready"));
		expect(await jobsCommand(harness, "start sleep 30")).toContain("/jobs cannot start processes");
		expect(await jobsCommand(harness, "status job-nope")).toContain('Unknown job ID "job-nope"');
		expect(await jobsCommand(harness, `cancel ${job.id}`)).toContain(`${job.id}: cancelled`);
		await until(() => processGone(job.pid));

		expect(harness.session.messages).toHaveLength(messageCount);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect((await jobsCommand(harness, "")).match(/job-/g)).toHaveLength(1);
	});

	it("shows output through the UI when one is bound", async () => {
		const harness = await setup();
		const notes: string[] = [];
		await harness.session.bindExtensions({ uiContext: createUiContext({ notes }), mode: "tui" });
		await harness.session.prompt("/jobs");
		expect(notes).toEqual(["No background jobs."]);
	});
});

describe("background jobs shutdown", () => {
	it.each(["quit", "reload", "new", "resume", "fork"] as const)(
		"cleans up and rejects starts on %s",
		async (reason) => {
			const harness = await setup();
			const job = await startJob(harness, fixture("wait"));
			const started = Date.now();
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason });
			expect(Date.now() - started).toBeLessThan(2000);
			expect(processGone(job.pid)).toBe(true);
			const result = await callTool(harness, { action: "start", command: "true" });
			expect(result).toMatchObject({ isError: true, text: expect.stringContaining("shutting down") });
		},
	);

	describe.skipIf(isWindows)("unconfirmed cleanup", () => {
		async function escapedJob(harness: Harness): Promise<number> {
			const job = await startJob(harness, fixture("escape"));
			let output = "";
			await until(async () => {
				output = await jobsCommand(harness, `log ${job.id}`);
				return /pids \d+ \d+/.test(output);
			});
			const escaped = Number(/pids \d+ (\d+)/.exec(output)?.[1]);
			fixturePids.add(escaped);
			return escaped;
		}

		it("reports unconfirmed cleanup on stderr in headless mode", async () => {
			const harness = await setup();
			await escapedJob(harness);
			const writes: string[] = [];
			const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
				writes.push(String(chunk));
				return true;
			});
			const started = Date.now();
			try {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
			} finally {
				spy.mockRestore();
			}
			expect(Date.now() - started).toBeLessThan(3000);
			expect(writes.join("")).toMatch(
				/cleanup was not confirmed within 2000 ms for 1 job\(s\)[\s\S]*output pipes did not close/,
			);

			// A repeated shutdown is harmless and does not report again.
			expect(await jobsCommand(harness, "")).toContain("unreachable");
			const repeated = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				expect(repeated).not.toHaveBeenCalled();
			} finally {
				repeated.mockRestore();
			}
		});

		it("reports unconfirmed cleanup through the UI when one is bound", async () => {
			const harness = await setup();
			await escapedJob(harness);
			const notes: string[] = [];
			await harness.session.bindExtensions({ uiContext: createUiContext({ notes }), mode: "tui" });
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			expect(notes.at(-1)).toMatch(/cleanup was not confirmed within 2000 ms for 1 job\(s\)/);
		});
	});
});

describe("background jobs across runtime replacement", () => {
	it("gives a reloaded runtime a fresh registry and kills jobs from the old one", async () => {
		const result = await createTestExtensionsResult([backgroundJobs]);
		let current = result;
		const loader: ResourceLoader = {
			...createTestResourceLoader({ extensionsResult: result }),
			getExtensions: () => current,
			reload: async () => {
				current = await createTestExtensionsResult([backgroundJobs]);
			},
		};
		const harness = await createHarness({ resourceLoader: loader });
		harnesses.push(harness);
		const job = await startJob(harness, fixture("wait"));

		await harness.session.reload();
		expect(processGone(job.pid)).toBe(true);
		// The old runtime still holds the cancelled record, so an unknown ID proves the new registry is fresh.
		expect(await jobsCommand(harness, `status ${job.id}`)).toContain(`Unknown job ID "${job.id}"`);
		expect(await jobsCommand(harness, "")).toContain("No background jobs.");
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	async function createRuntime(extensions: ExtensionFactory[]) {
		vi.stubEnv("OCTOBER_PERMISSION_MODE", "bypass");
		const tempDir = join(tmpdir(), `pi-background-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		const registerFaux = (pi: ExtensionAPI) => {
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
		};
		const createRuntimeResult: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				resourceLoaderOptions: {
					extensionFactories: [registerFaux, ...extensions],
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
		const runtime = await createAgentSessionRuntime(createRuntimeResult, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const start = async (command: string) => {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("background_jobs", { action: "start", command })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ok"),
			]);
			await runtime.session.prompt("start");
			const result = runtime.session.messages.filter((message) => message.role === "toolResult").at(-1);
			const pid = Number(/\(pid (\d+)\)/.exec(getMessageText(result))?.[1]);
			fixturePids.add(pid);
			return pid;
		};
		return { runtime, start };
	}

	it("cleans up on session replacement and leaves jobs running after a cancelled switch", async () => {
		let cancelSwitch = true;
		const guard = (pi: ExtensionAPI) => {
			pi.on("session_before_switch", () => ({ cancel: cancelSwitch }));
		};
		const { runtime, start } = await createRuntime([guard, backgroundJobs]);
		const pid = await start(fixture("wait"));

		expect((await runtime.newSession()).cancelled).toBe(true);
		await delay(100);
		expect(processGone(pid)).toBe(false);

		cancelSwitch = false;
		expect((await runtime.newSession()).cancelled).toBe(false);
		expect(processGone(pid)).toBe(true);
		expect(runtime.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("cleans up when the runtime is disposed", async () => {
		const { runtime, start } = await createRuntime([backgroundJobs]);
		const pid = await start(fixture("wait"));
		await runtime.dispose();
		expect(processGone(pid)).toBe(true);
	});
});
