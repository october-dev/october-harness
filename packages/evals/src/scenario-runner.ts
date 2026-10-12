import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type Api,
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
	type JsonObject,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@october-dev/october";
// The October permission gate and Bus tools are not public exports; the runner loads them from source
// exactly as the `october` extension registers them.
import { parseOctoberBusEnv } from "../../coding-agent/src/extensions/october/bus/env.ts";
import { registerOctoberBusTools } from "../../coding-agent/src/extensions/october/bus/tools.ts";
import {
	createOctoberPermissionController,
	registerOctoberPermissions,
} from "../../coding-agent/src/extensions/october/permissions.ts";
import { applyIsolatedEnvironment, hasPricing, resolveEvalModel } from "./harness.ts";
import type { FauxStep, LoadedScenario } from "./scenario.ts";
import { type ScenarioBus, startScenarioBus } from "./scenario-bus.ts";
import {
	type CheckResult,
	type Compaction,
	evaluateChecks,
	scoreChecks,
	type ToolExecution,
} from "./scenario-checks.ts";

export type ScenarioModelSelection = { provider: string; id: string };

export type RunScenarioOptions = {
	/** Run against this real model instead of the scenario's `faux` script. */
	model?: ScenarioModelSelection;
	/** A prepared runtime for `model`; by default one is built from the host's stored credentials. */
	modelRuntime?: ModelRuntime;
};

export type ScenarioResult = {
	id: string;
	mode: "faux" | "model";
	/** `provider/id` of the model that ran. */
	model: string;
	score: number;
	passed: boolean;
	checks: CheckResult[];
	/** Problems with the run itself (for example an unconsumed faux script), separate from failed checks. */
	errors: string[];
	/** The model's assistant messages as faux steps, so a real run can be saved and replayed. */
	transcript: FauxStep[];
	metrics: {
		turns: number;
		toolCalls: number;
		toolErrors: number;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		/** Only reported for a priced real model; faux usage is estimated and unpriced. */
		costUsd: number | null;
		durationMs: number;
	};
};

type PreparedModel = {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	/** Faux steps never requested, or undefined for a real model. */
	pendingSteps: () => number | undefined;
};

function toAssistantMessage(step: FauxStep): AssistantMessage {
	if ("toolCall" in step) {
		return fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.args as JsonObject)], {
			stopReason: "toolUse",
		});
	}
	if ("toolCalls" in step) {
		const calls = step.toolCalls.map((call) => fauxToolCall(call.name, call.args as JsonObject));
		return fauxAssistantMessage(step.text ? [fauxText(step.text), ...calls] : calls, { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([fauxText(step.text)]);
}

/** Convert one assistant message to a faux step. Thinking is dropped; an empty message has no step. */
export function toFauxStep(message: AgentSession["messages"][number]): FauxStep | undefined {
	if (message.role !== "assistant") return undefined;
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const toolCalls = message.content
		.filter((part) => part.type === "toolCall")
		.map((part) => ({ name: part.name, args: part.arguments as Record<string, unknown> }));
	if (toolCalls.length === 1 && !text) return { toolCall: toolCalls[0] };
	if (toolCalls.length > 0) return text ? { text, toolCalls } : { toolCalls };
	return text ? { text } : undefined;
}

async function prepareModel(
	scenario: LoadedScenario,
	options: RunScenarioOptions,
	hostAgentDir: string,
): Promise<PreparedModel> {
	if (!options.model) {
		const faux = fauxProvider({
			api: "faux",
			provider: "faux",
			models: scenario.model ? [{ id: "faux-1", ...scenario.model }] : undefined,
		});
		faux.setResponses(scenario.faux.map(toAssistantMessage));
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("faux", async () => ({ type: "api_key", key: "scenario-only" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		return { modelRuntime, model: faux.getModel(), pendingSteps: () => faux.getPendingResponseCount() };
	}
	const { modelRuntime, model } = await resolveEvalModel(options.model, hostAgentDir, {
		label: "Scenario",
		modelRuntime: options.modelRuntime,
	});
	return { modelRuntime, model, pendingSteps: () => undefined };
}

/**
 * Environment variables a run may see. Everything else, including provider keys, is hidden from tools
 * during the run; credentials are resolved into the model runtime before it starts.
 */
const RUN_ENVIRONMENT = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"OCTOBER_CODING_AGENT_DIR",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"SHELL",
	"SystemRoot",
	"ComSpec",
	"PATHEXT",
];

/** Reduce `process.env` to `RUN_ENVIRONMENT`; the returned function restores the full environment. */
function restrictEnvironment(): () => void {
	const saved = { ...process.env };
	for (const name of Object.keys(process.env)) {
		if (!RUN_ENVIRONMENT.includes(name)) delete process.env[name];
	}
	return () => {
		for (const name of Object.keys(process.env)) delete process.env[name];
		Object.assign(process.env, saved);
	};
}

/** A failed result for a scenario that could not load or run, so one failure does not hide the others. */
export function erroredResult(id: string, error: unknown, model?: ScenarioModelSelection): ScenarioResult {
	return {
		id,
		mode: model ? "model" : "faux",
		model: model ? `${model.provider}/${model.id}` : "faux/faux",
		score: 0,
		passed: false,
		checks: [],
		errors: [`Scenario could not run: ${error instanceof Error ? error.message : String(error)}`],
		transcript: [],
		metrics: {
			turns: 0,
			toolCalls: 0,
			toolErrors: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: null,
			durationMs: 0,
		},
	};
}

/** Inline extensions for the scenario's permission mode and fake Bus. */
function scenarioExtensions(scenario: LoadedScenario, bus: ScenarioBus | undefined): InlineExtension[] {
	const extensions: InlineExtension[] = [];
	if (scenario.permissionMode) {
		const mode = scenario.permissionMode;
		extensions.push({
			name: "scenario-permissions",
			hidden: true,
			factory: (pi) => registerOctoberPermissions(pi, createOctoberPermissionController(), { mode }),
		});
	}
	if (bus) {
		const env = parseOctoberBusEnv({
			OCTOBER_BUS_PORT: String(bus.port),
			OCTOBER_BUS_CANVAS: "scenario-canvas",
			OCTOBER_BUS_NODE: "scenario-node",
		});
		if (!env) throw new Error("Fake Bus environment was not recognized.");
		extensions.push({ name: "scenario-bus", hidden: true, factory: (pi) => registerOctoberBusTools(pi, env) });
	}
	return extensions;
}

/**
 * Run one scenario in an isolated temp workspace and home. By default the scenario's scripted faux model
 * runs with no credentials or network; `options.model` runs a real model against the same checks instead.
 *
 * Runs change the global `process.env` while they execute, so run scenarios one at a time, never in parallel.
 */
export async function runScenario(scenario: LoadedScenario, options: RunScenarioOptions = {}): Promise<ScenarioResult> {
	// Read before isolating the environment, which points the agent dir at the temp home.
	const hostAgentDir = getAgentDir();
	const root = await mkdtemp(join(tmpdir(), "pi-scenario-"));
	const workspace = join(root, "workspace");
	const home = join(root, "home");
	const agentDir = join(home, CONFIG_DIR_NAME, "agent");
	const restoreEnvironment = applyIsolatedEnvironment(home, agentDir);
	let restoreRunEnvironment: (() => void) | undefined;
	let session: AgentSession | undefined;
	let bus: ScenarioBus | undefined;
	const compactions: Compaction[] = [];
	// Every model request in order: assistant messages and compaction summaries, which are not session messages.
	const transcript: FauxStep[] = [];
	const toolExecutions: ToolExecution[] = [];
	const errors: string[] = [];
	let turns = 0;
	try {
		if (scenario.workspaceDirectory) await cp(scenario.workspaceDirectory, workspace, { recursive: true });
		else await mkdir(workspace);
		await mkdir(agentDir, { recursive: true });

		const { modelRuntime, model, pendingSteps } = await prepareModel(scenario, options, hostAgentDir);
		restoreRunEnvironment = restrictEnvironment();
		if (scenario.bus) bus = await startScenarioBus(scenario.bus.tools);
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: scenario.compaction ? { enabled: true, ...scenario.compaction } : { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: scenarioExtensions(scenario, bus),
		});
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			model,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(workspace),
			settingsManager,
			thinkingLevel: "off",
			tools: scenario.tools,
		}));
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end") toolExecutions.push({ name: event.toolName, isError: event.isError });
			if (event.type === "turn_end") turns++;
			if (event.type === "message_end") {
				const step = toFauxStep(event.message);
				if (step) transcript.push(step);
			}
			if (event.type === "compaction_end") {
				compactions.push({ reason: event.reason, ok: !event.aborted && event.errorMessage === undefined });
				if (event.result) transcript.push({ text: event.result.summary });
			}
		});

		const startedAt = performance.now();
		try {
			await session.prompt(scenario.prompt);
		} finally {
			unsubscribe();
		}
		const durationMs = performance.now() - startedAt;

		const pending = pendingSteps();
		if (pending) errors.push(`${pending} faux step(s) were never requested; the run ended early.`);
		const last = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			errors.push(`Run ended with an error: ${last.errorMessage ?? "unknown"}`);
		}

		const checks = await evaluateChecks(scenario.expect, {
			workspace,
			toolExecutions,
			finalText: session.getLastAssistantText() ?? "",
			turns,
			compactions,
			busCalls: bus?.calls ?? [],
		});
		const stats = session.getSessionStats();
		return {
			id: scenario.id,
			mode: options.model ? "model" : "faux",
			model: `${model.provider}/${model.id}`,
			score: scoreChecks(checks),
			passed: errors.length === 0 && checks.every((check) => check.passed),
			checks,
			errors,
			transcript,
			metrics: {
				turns,
				toolCalls: toolExecutions.length,
				toolErrors: toolExecutions.filter((execution) => execution.isError).length,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				costUsd: options.model && hasPricing(model) ? stats.cost : null,
				durationMs: Math.round(durationMs),
			},
		};
	} finally {
		session?.dispose();
		await bus?.close();
		restoreRunEnvironment?.();
		restoreEnvironment();
		await rm(root, { recursive: true, force: true });
	}
}
