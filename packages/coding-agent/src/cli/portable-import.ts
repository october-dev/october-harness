/**
 * CLI import of portable sessions. Runs before any runtime exists, so the destination is checked against the
 * built-in catalog and models.json only. A model that is not there is `unknown`, since an extension may provide
 * it, and an unknown model blocks the import. Tools and renderers are always unknown here. SDK and RPC imports
 * check against the loaded runtime instead.
 */

import { ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
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
import { isVirtualModel } from "../core/virtual-models.ts";
import { showStartupSelector } from "./startup-ui.ts";

/** Parse `provider/id`. Splits at the first slash, since model ids may contain slashes. */
export function parseModelChoice(value: string): PortableModelChoice {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new SessionImportError(`--import-model expects provider/id, got "${value}"`);
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

async function createCliCapabilities(): Promise<{ modelRuntime: ModelRuntime; capabilities: PortableCapabilities }> {
	// No network, no refresh, and read-only credentials: the default store creates auth.json on first read,
	// and inspection must not write anything.
	const modelRuntime = await ModelRuntime.create({
		credentials: new ReadOnlyAuthStorage(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const capabilities: PortableCapabilities = {
		model: (provider, modelId) => {
			if (!modelRuntime.getModel(provider, modelId)) return "unknown";
			return modelRuntime.hasConfiguredAuth(provider) ? "available" : "no_auth";
		},
		isVirtualModel: (provider, modelId) => {
			const model = modelRuntime.getModel(provider, modelId);
			return model !== undefined && isVirtualModel(model);
		},
		tool: () => "unknown",
		renderer: () => "unknown",
	};
	return { modelRuntime, capabilities };
}

/** Compare a portable file with the destination. Reads the file and the model catalog only. */
export async function inspectPortableFileForCli(
	inputPath: string,
	cwd: string,
	sessionDir: string,
): Promise<PortableCompatibilityReport> {
	const prepared = preparePortableImport(inputPath, { cwd, sessionDir });
	const { capabilities } = await createCliCapabilities();
	return inspectPortableImport(prepared, capabilities);
}

export interface PortableImportForCliOptions {
	cwd: string;
	sessionDir: string;
	/** Replacement chosen with --import-model, as provider/id. */
	model?: string;
	/** True when a terminal can show the model picker. Otherwise a blocked import fails. */
	interactive: boolean;
	settingsManager: SettingsManager;
}

async function chooseReplacementInTerminal(
	report: PortableCompatibilityReport,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): Promise<PortableModelChoice | undefined> {
	const options = modelRuntime.getAvailableSnapshot().map((model) => ({
		label: `${model.provider}/${model.id}`,
		value: { provider: model.provider, modelId: model.id },
	}));
	if (options.length === 0) throw new SessionImportSelectionRequiredError(report);
	const title = [...formatPortableCompatibilityReport(report), "Choose a replacement model"].join("\n");
	return showStartupSelector(settingsManager, title, options);
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
	const { modelRuntime, capabilities } = await createCliCapabilities();
	const report = inspectPortableImport(prepared, capabilities);

	let replacement = options.model !== undefined ? parseModelChoice(options.model) : undefined;
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
