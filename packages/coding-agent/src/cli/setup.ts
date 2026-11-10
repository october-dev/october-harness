import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export interface SetupCliOptions {
	/**
	 * Configure the global HTTP dispatcher now (default true). `october doctor` passes false: the
	 * dispatcher parses HTTP(S)_PROXY eagerly and throws on a malformed value, so doctor sets it up
	 * itself, only under --probe, where the failure becomes a report entry instead of a crash.
	 */
	http?: boolean;
}

export function setupCli(options: SetupCliOptions = {}): void {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.OCTOBER_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	if (options.http !== false) configureHttpDispatcher();
}
