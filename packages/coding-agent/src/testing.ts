import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { FauxModelDefinition, FauxProviderRegistration, FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "./core/agent-session.ts";
import { emitSessionShutdownEvent } from "./core/extensions/runner.ts";
import type { InlineExtension, SessionShutdownEvent } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { type CreateAgentSessionResult, createAgentSession } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { initTheme, theme } from "./modes/interactive/theme/theme.ts";

export interface ExtensionTestHarnessOptions {
	/** Extension factories loaded by October's standard extension runtime. */
	extensions?: InlineExtension[];
	/** Existing workspace to use. The harness never removes or creates this directory. */
	cwd?: string;
	/** Faux model metadata. The harness always uses its own unique faux provider. */
	model?: FauxModelDefinition;
	/** Responses consumed in order by the faux model. */
	responses?: FauxResponseStep[];
}

export interface ExtensionTestHarness {
	readonly cwd: string;
	readonly session: AgentSession;
	readonly events: readonly (AgentSessionEvent | SessionShutdownEvent)[];
	setResponses(responses: FauxResponseStep[]): void;
	appendResponses(responses: FauxResponseStep[]): void;
	prompt(input: string): Promise<void>;
	abort(): Promise<void>;
	/** Abort active work and release resources. Extensions that ignore AbortSignal cannot be forcibly stopped. */
	dispose(): Promise<void>;
}

/** Create an isolated harness for testing extensions with deterministic model responses. */
export async function createExtensionTestHarness(
	options: ExtensionTestHarnessOptions = {},
): Promise<ExtensionTestHarness> {
	const cleanups: Array<() => void | Promise<void>> = [];
	let result: CreateAgentSessionResult | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposal: Promise<void> | undefined;
	const events: Array<AgentSessionEvent | SessionShutdownEvent> = [];
	let provider: FauxProviderRegistration | undefined;

	try {
		try {
			void theme.name;
		} catch {
			initTheme();
		}
		const cwd = options.cwd ? resolve(options.cwd) : await mkdtemp(join(tmpdir(), "october-extension-test-"));
		if (!options.cwd) {
			cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		}

		const providerId = `october-test-${randomUUID()}`;
		const api = `october-test-api-${randomUUID()}`;
		provider = registerFauxProvider({
			api,
			provider: providerId,
			models: [{ id: options.model?.id ?? "test-model", ...options.model }],
		});
		cleanups.push(() => provider?.unregister());
		provider.setResponses(options.responses ?? []);

		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		cleanups.push(() => modelRuntime.unregisterProvider(providerId));
		const model = provider.getModel();
		modelRuntime.registerProvider(providerId, {
			api,
			baseUrl: model.baseUrl,
			apiKey: "faux-test-key",
			models: provider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, ".october-test-agent"),
			settingsManager,
			extensionFactories: options.extensions ?? [],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		result = await createAgentSession({
			cwd,
			agentDir: join(cwd, ".october-test-agent"),
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		});
		unsubscribe = result.session.subscribe((event) => events.push(event));
		cleanups.push(() => unsubscribe?.());
		cleanups.push(async () => {
			if (!result) return;
			await result.session.abortBashAndWait();
			const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
			events.push(event);
			try {
				await emitSessionShutdownEvent(result.session.extensionRunner, event);
			} finally {
				result.session.dispose();
			}
		});
		await result.session.bindExtensions({});

		return {
			cwd,
			session: result.session,
			events,
			setResponses: (responses) => provider?.setResponses(responses),
			appendResponses: (responses) => provider?.appendResponses(responses),
			prompt: (input) => result!.session.prompt(input),
			abort: () => result!.session.abort(),
			async dispose() {
				if (disposal) return disposal;
				disposal = (async () => {
					const errors: unknown[] = [];
					try {
						await result?.session.abort();
					} catch (error) {
						errors.push(error);
					}
					for (const cleanup of cleanups.reverse()) {
						try {
							await cleanup();
						} catch (error) {
							errors.push(error);
						}
					}
					if (errors.length) throw new AggregateError(errors, "Extension test harness cleanup failed");
				})();
				return disposal;
			},
		};
	} catch (error) {
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch {
				// Preserve the construction failure while attempting every cleanup.
			}
		}
		throw error;
	}
}
