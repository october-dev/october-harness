import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";

describe("October integrations with upstream built-in extensions", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "october-upstream-"));
		for (const name of Object.keys(process.env)) {
			if (name.startsWith("OCTOBER_")) vi.stubEnv(name, "");
		}
		vi.stubEnv("OCTOBER_CODING_AGENT_DIR", directory);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	async function load(options: { noExtensions?: boolean; noMcp?: boolean; replacement?: InlineExtension } = {}) {
		const settingsManager = SettingsManager.inMemory({ packages: [] });
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			noExtensions: options.noExtensions,
			disabledBuiltinExtensions: options.noMcp ? ["mcp"] : undefined,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				...createBuiltInExtensions(settingsManager, { noMcp: options.noMcp }),
				...(options.replacement ? [options.replacement] : []),
			],
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		return result.extensions;
	}

	it("retains October permissions and settings MCP with --no-extensions", async () => {
		const extensions = await load({ noExtensions: true });
		expect(extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
		expect(extensions.find((extension) => extension.path === "<inline:october>")?.handlers.has("tool_call")).toBe(
			true,
		);
		expect(
			extensions.find((extension) => extension.path === "<inline:october-mcp>")?.handlers.has("session_start"),
		).toBe(true);
	});

	it("retains settings MCP when an extension replaces upstream MCP", async () => {
		const extensions = await load({
			replacement: {
				name: "mcp-replacement",
				factory(pi) {
					pi.registerCommand("mcp", { description: "Replacement", handler: async () => {} });
				},
			},
		});
		expect(extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
		expect(
			extensions.find((extension) => extension.path === "<inline:october-mcp>")?.commands.has("mcp-settings"),
		).toBe(true);
		expect(extensions.find((extension) => extension.path === "<inline:october>")?.handlers.has("tool_call")).toBe(
			true,
		);
	});

	it("disables both MCP configurations with --no-mcp while retaining October permissions", async () => {
		const extensions = await load({ noMcp: true });
		expect(extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
		expect(extensions.find((extension) => extension.path === "<inline:october-mcp>")?.handlers.size).toBe(0);
		expect(extensions.find((extension) => extension.path === "<inline:october>")?.handlers.has("tool_call")).toBe(
			true,
		);
	});
});
