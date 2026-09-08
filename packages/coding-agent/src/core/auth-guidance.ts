import { join } from "node:path";
import { APP_NAME, getDocsPath } from "../config.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(surface: "shell" | "interactive" = "shell"): string {
	return [
		`Run \`${surface === "interactive" ? "/login" : `${APP_NAME} login`}\` to connect an October account, another provider account, or an API key. See:`,
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function getNoModelsGuidance(
	runtime: Pick<ModelRuntime, "getError" | "getProviders" | "getProviderAuthStatus">,
	surface: "shell" | "interactive",
): { level: "info" | "warning"; message: string } {
	const error = runtime.getError();
	if (error) return { level: "warning", message: `Could not load models: ${error}` };
	if (runtime.getProviders().some((provider) => runtime.getProviderAuthStatus(provider.id).configured)) {
		return {
			level: "warning",
			message: `Credentials are configured, but no models are available. ${surface === "interactive" ? "Use /model to retry model discovery" : `Run ${APP_NAME} --list-models to retry model discovery`}, and check your provider configuration and connection.`,
		};
	}
	return {
		level: "info",
		message: `Connect a provider to get started. ${surface === "interactive" ? "Type `/login`." : `Run \`${APP_NAME} login\`.`}`,
	};
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
