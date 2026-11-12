import chalk from "chalk";
import {
	CAPABILITY_LOAD_CHOICE,
	CAPABILITY_SKIP_CHOICE,
	type CapabilityPreflightDecision,
	type CapabilityPreflightHandler,
	type CapabilityPreflightHost,
	type CapabilityPreflightItem,
	formatCapabilityDisclosureTitle,
} from "../core/extensions/capability-preflight.ts";
import { writeRawStdout } from "../core/output-guard.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupSelector } from "./startup-ui.ts";

async function discloseStartupCapabilities(
	items: CapabilityPreflightItem[],
	settingsManager: SettingsManager,
): Promise<CapabilityPreflightDecision[]> {
	const decisions: CapabilityPreflightDecision[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!item) continue;
		const selected = await showStartupSelector(settingsManager, formatCapabilityDisclosureTitle(items, index), [
			{ label: CAPABILITY_LOAD_CHOICE, value: true },
			{ label: CAPABILITY_SKIP_CHOICE, value: false },
		]);
		// Esc declines: the extension is skipped without loading its code.
		decisions.push({ path: item.path, accept: selected === true });
	}
	return decisions;
}

function discloseNonInteractiveCapabilities(items: CapabilityPreflightItem[], mode: AppMode): void {
	for (const item of items) {
		if (mode === "json") {
			// Same NDJSON diagnostic channel as startup diagnostics in main.ts.
			writeRawStdout(
				`${JSON.stringify({ type: "diagnostic", level: "info", code: "capability_preflight", message: item.summary })}\n`,
			);
		} else {
			console.error(chalk.yellow(item.summary));
		}
	}
}

/**
 * Host-owned first-load disclosure shared by session startup and package/config commands (#7).
 * Outside the interactive terminal the summary is printed and remembered automatically.
 */
export function createCapabilityPreflightHost(options: {
	settingsManager: SettingsManager;
	getMode: () => AppMode;
}): CapabilityPreflightHost {
	let interactiveHandler: CapabilityPreflightHandler | undefined;
	return {
		setInteractiveHandler(handler) {
			interactiveHandler = handler;
		},
		disclose: async (items) => {
			if (items.length === 0) return [];
			const mode = options.getMode();
			if (mode === "interactive" && interactiveHandler) {
				return interactiveHandler(items);
			}
			if (mode === "interactive") {
				return discloseStartupCapabilities(items, options.settingsManager);
			}
			discloseNonInteractiveCapabilities(items, mode);
			return items.map((item) => ({ path: item.path, accept: true }));
		},
	};
}
