import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getSettingsPath } from "../../config.ts";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "../../core/extensions/types.ts";

export type OctoberPermissionMode = "ask" | "accept-edits" | "bypass";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

export type ToolPermissionClass = "read" | "edit" | "command";

export function classifyTool(toolName: string): ToolPermissionClass {
	if (READ_TOOLS.has(toolName)) return "read";
	if (EDIT_TOOLS.has(toolName)) return "edit";
	return "command";
}

function isMode(value: unknown): value is OctoberPermissionMode {
	return value === "ask" || value === "accept-edits" || value === "bypass";
}

function modeFromSettingsFile(path: string): OctoberPermissionMode | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const value = (parsed as { permissionMode?: unknown }).permissionMode;
		return isMode(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function resolveOctoberPermissionMode(pi: ExtensionAPI, cwd?: string): OctoberPermissionMode {
	const flag = pi.getFlag("permission-mode");
	if (isMode(flag)) return flag;
	const env = process.env.OCTOBER_PERMISSION_MODE?.trim();
	if (isMode(env)) return env;
	if (cwd) {
		const project = modeFromSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json"));
		if (project) return project;
	}
	const global = modeFromSettingsFile(getSettingsPath());
	if (global) return global;
	return "bypass";
}

export function permissionRequiresPrompt(mode: OctoberPermissionMode, toolClass: ToolPermissionClass): boolean {
	if (mode === "bypass" || toolClass === "read") return false;
	if (mode === "accept-edits") return toolClass === "command";
	return true;
}

function argumentPreview(input: unknown): string {
	try {
		const raw = JSON.stringify(input);
		if (!raw) return "";
		return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
	} catch {
		return "";
	}
}

export function registerOctoberPermissions(pi: ExtensionAPI): void {
	pi.registerFlag("permission-mode", {
		type: "string",
		description: "Tool permission mode: ask, accept-edits, or bypass. Default bypass. Not --approve.",
	});

	let subscribed = false;
	const subscribe = (cwd?: string): void => {
		if (subscribed) return;
		if (resolveOctoberPermissionMode(pi, cwd) === "bypass") return;
		subscribed = true;
		pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
			const mode = resolveOctoberPermissionMode(pi, ctx.cwd);
			const toolClass = classifyTool(event.toolName);
			if (!permissionRequiresPrompt(mode, toolClass)) return undefined;

			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `blocked by permission mode ${mode} in non-interactive mode`,
				};
			}

			const preview = argumentPreview(event.input);
			const allowed = await ctx.ui.confirm(`Allow ${event.toolName}?`, preview);
			if (!allowed) {
				return { block: true, reason: "denied by user" };
			}
			return undefined;
		});
	};

	subscribe();
	pi.on("session_start", (_event, ctx) => {
		subscribe(ctx.cwd);
	});
}
