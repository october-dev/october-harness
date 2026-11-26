import { getAgentDir } from "../config.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { SessionManager } from "../core/session-manager.ts";
import {
	commitPortableImport,
	formatPortableCompatibilityReport,
	inspectPortableImport,
	type PortableCapabilities,
	type PortableCompatibilityReport,
	type PortableModelChoice,
	preparePortableImport,
	SessionImportError,
	SessionImportSelectionRequiredError,
} from "../core/session-portable.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { allToolNames } from "../core/tools/index.ts";
import { isVirtualModel } from "../core/virtual-models.ts";
import type { Args } from "./args.ts";
import { createInspectionModelRuntime } from "./doctor.ts";
import { showStartupModelSelector } from "./startup-ui.ts";

/** Parse `provider/id`. Splits at the first slash, since model ids may contain slashes. */
export function parseModelChoice(value: string): PortableModelChoice {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new SessionImportError(`--import-model expects provider/id, got "${value}"`);
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

type ModelFlags = Pick<Args, "model" | "provider" | "apiKey" | "importModel">;

async function createCliCapabilities(flags: ModelFlags) {
	const modelRuntime = await createInspectionModelRuntime(getAgentDir());
	const cliModel = flags.model
		? resolveCliModel({
				cliProvider: flags.provider,
				cliModel: flags.model,
				inlineApiKey: Boolean(flags.apiKey),
				modelRuntime,
			})
		: undefined;
	if (cliModel?.error) throw new SessionImportError(cliModel.error);
	const selected = cliModel?.model;
	const replacement = flags.importModel
		? parseModelChoice(flags.importModel)
		: selected
			? { provider: selected.provider, modelId: selected.id }
			: undefined;
	if (flags.apiKey) {
		const provider = selected?.provider ?? replacement?.provider;
		if (!provider) throw new SessionImportError("--api-key requires --model or --import-model");
		await modelRuntime.setRuntimeApiKey(provider, flags.apiKey);
	}
	const knownTools: ReadonlySet<string> = allToolNames;
	const capabilities: PortableCapabilities = {
		model: (provider, modelId) => {
			if (!modelRuntime.getModel(provider, modelId)) return "unknown";
			return modelRuntime.hasConfiguredAuth(provider) ? "available" : "no_auth";
		},
		isVirtualModel: (provider, modelId) => {
			const model = modelRuntime.getModel(provider, modelId);
			return model !== undefined && isVirtualModel(model);
		},
		tool: (name) => (knownTools.has(name) ? "available" : "unknown"),
		renderer: () => "unknown",
	};
	return { modelRuntime, capabilities, replacement };
}

/** Compare a portable file with the destination. Reads the file and the model catalog only. */
export async function inspectPortableFileForCli(
	inputPath: string,
	cwd: string,
	sessionDir: string,
	flags: ModelFlags,
): Promise<PortableCompatibilityReport> {
	const prepared = preparePortableImport(inputPath, { cwd, sessionDir });
	const { capabilities, replacement } = await createCliCapabilities(flags);
	return inspectPortableImport(prepared, capabilities, replacement);
}

export interface PortableImportForCliOptions {
	cwd: string;
	sessionDir: string;
	flags: ModelFlags;
	/** True when a terminal can show the model picker. Otherwise a blocked import fails. */
	interactive: boolean;
	settingsManager: SettingsManager;
}

async function chooseReplacementInTerminal(
	report: PortableCompatibilityReport,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): Promise<PortableModelChoice | undefined> {
	if (modelRuntime.getAvailableSnapshot().length === 0) throw new SessionImportSelectionRequiredError(report);
	return showStartupModelSelector(settingsManager, formatPortableCompatibilityReport(report), modelRuntime);
}

/**
 * Import a portable file as a new native session for `cwd`. Validation and the model check run before
 * anything is written. Returns undefined when the user cancels the model choice; nothing is written then.
 * A chosen replacement is recorded as a model change in the new session.
 *
 * @throws {SessionImportSelectionRequiredError} When the import is blocked and no model was given outside a terminal.
 * @throws {SessionImportError} When the chosen replacement is not available in the CLI check.
 */
export async function importPortableForCli(
	inputPath: string,
	options: PortableImportForCliOptions,
): Promise<SessionManager | undefined> {
	const prepared = preparePortableImport(inputPath, { cwd: options.cwd, sessionDir: options.sessionDir });
	const { modelRuntime, capabilities, replacement: explicit } = await createCliCapabilities(options.flags);
	const report = inspectPortableImport(prepared, capabilities);

	let replacement = explicit;
	if (!replacement && report.blocking) {
		if (!options.interactive) throw new SessionImportSelectionRequiredError(report);
		replacement = await chooseReplacementInTerminal(report, modelRuntime, options.settingsManager);
		if (!replacement) return undefined;
	}
	if (replacement) {
		const status = capabilities.model(replacement.provider, replacement.modelId);
		if (status !== "available") {
			const hint = status === "unknown" ? " Extension models can be chosen through RPC or the SDK." : "";
			throw new SessionImportError(
				`Replacement model ${replacement.provider}/${replacement.modelId} is not available here (${status}).${hint}`,
			);
		}
	}

	const destination = commitPortableImport(prepared);
	const sessionManager = SessionManager.open(destination, options.sessionDir);
	if (replacement) sessionManager.appendModelChange(replacement.provider, replacement.modelId);
	return sessionManager;
}
