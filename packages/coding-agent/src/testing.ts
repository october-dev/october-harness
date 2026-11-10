import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type FauxModelDefinition,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "./core/agent-session-services.ts";
import { emitSessionShutdownEvent } from "./core/extensions/runner.ts";
import type { ExtensionError, InlineExtension, SessionShutdownEvent } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { initTheme, theme } from "./modes/interactive/theme/theme.ts";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
export type { FauxModelDefinition, FauxResponseFactory, FauxResponseStep };

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
	readonly errors: readonly ExtensionError[];
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
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposal: Promise<void> | undefined;
	const events: Array<AgentSessionEvent | SessionShutdownEvent> = [];
	const errors: ExtensionError[] = [];
	let faux: ReturnType<typeof fauxProvider> | undefined;

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
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		cleanups.push(() => modelRuntime.unregisterProvider(providerId));
		faux = fauxProvider({
			provider: providerId,
			models: [{ ...options.model, id: options.model?.id ?? "test-model" }],
		});
		modelRuntime.registerNativeProvider(faux.provider);
		faux.setResponses(options.responses ?? []);

		const settingsManager = SettingsManager.inMemory();
		const agentDir = join(cwd, ".october-test-agent");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: options.extensions ?? [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionsOverride(base) {
					for (const { path, error } of base.errors) {
						errors.push({ extensionPath: path, event: "load", error });
					}
					return base;
				},
			},
		});
		for (const diagnostic of services.diagnostics) {
			if (diagnostic.type !== "error") continue;
			const extensionPath = /^Extension "([^"]+)" error:/.exec(diagnostic.message)?.[1] ?? "<session>";
			errors.push({ extensionPath, event: "registration", error: diagnostic.message });
		}
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: faux.getModel(),
		});
		session = result.session;
		unsubscribe = session.subscribe((event) => events.push(event));
		cleanups.push(() => unsubscribe?.());
		cleanups.push(async () => {
			if (!session) return;
			await session.abortBashAndWait();
			const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
			events.push(event);
			try {
				await emitSessionShutdownEvent(session.extensionRunner, event);
			} finally {
				session.dispose();
			}
		});
		await session.bindExtensions({ onError: (error) => errors.push(error) });

		return {
			cwd,
			session,
			events,
			errors,
			setResponses: (responses) => faux?.setResponses(responses),
			appendResponses: (responses) => faux?.appendResponses(responses),
			prompt: (input) => session!.prompt(input),
			abort: () => session!.abort(),
			async dispose() {
				if (disposal) return disposal;
				disposal = (async () => {
					const errors: unknown[] = [];
					try {
						await session?.abort();
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
