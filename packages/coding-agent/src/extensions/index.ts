import type { InlineExtension } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import { createMcpExtension } from "./mcp/index.ts";
import settingsMcpExtension from "./mcp/settings-extension.ts";
import octoberExtension from "./october/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export function createBuiltInExtensions(
	settingsManager: SettingsManager,
	options: { noMcp?: boolean } = {},
): InlineExtension[] {
	let settingsMcpStatus: (() => string | undefined) | undefined;
	return [
		{
			name: "october-mcp",
			factory: (pi) => {
				if (options.noMcp) return;
				settingsMcpStatus = settingsMcpExtension(pi, () => settingsManager.getSettings().mcpServers, {
					commandName: "mcp-settings",
				});
			},
			hidden: true,
		},
		{ name: "llama.cpp", factory: llamaExtension, builtin: true },
		{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
		{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
		{
			name: "mcp",
			factory: createMcpExtension({ additionalStatus: () => settingsMcpStatus?.() }),
			replaceable: true,
			builtin: true,
		},
		{ name: "october", factory: octoberExtension, hidden: true },
	];
}
