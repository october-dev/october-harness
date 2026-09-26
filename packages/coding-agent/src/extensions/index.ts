import type { InlineExtension } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import octoberExtension from "./october/index.ts";

export function createBuiltInExtensions(settingsManager: SettingsManager): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, hidden: true },
		{
			name: "mcp",
			factory: (pi) => mcpExtension(pi, () => settingsManager.getSettings().mcpServers),
			hidden: true,
		},
		{ name: "october", factory: octoberExtension, hidden: true },
	];
}
