import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getSettingsPath } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";

export type OctoberPermissionMode = "ask" | "accept-edits" | "bypass";
export type OctoberTemporaryPermissionCeiling = "read-only" | "accept-edits" | "inherit";

export interface OctoberPermissionController {
	setTemporaryCeiling(ceiling: OctoberTemporaryPermissionCeiling | undefined): void;
	getTemporaryCeiling(): OctoberTemporaryPermissionCeiling | undefined;
}

export function createOctoberPermissionController(): OctoberPermissionController {
	let temporaryCeiling: OctoberTemporaryPermissionCeiling | undefined;
	return {
		setTemporaryCeiling(ceiling): void {
			temporaryCeiling = ceiling;
		},
		getTemporaryCeiling(): OctoberTemporaryPermissionCeiling | undefined {
			return temporaryCeiling;
		},
	};
}

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

export function resolveOctoberPermissionMode(pi: ExtensionAPI): OctoberPermissionMode {
	const flag = pi.getFlag("permission-mode");
	if (isMode(flag)) return flag;
	const env = process.env.OCTOBER_PERMISSION_MODE?.trim();
	if (isMode(env)) return env;
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

export function registerOctoberPermissions(pi: ExtensionAPI, controller = createOctoberPermissionController()): void {
	pi.registerFlag("permission-mode", {
		type: "string",
		description: "Tool permission mode: ask, accept-edits, or bypass. Default bypass. Not --approve.",
	});

	// Snapshot process-owned policy before a tool can edit settings. Project settings
	// may tighten it, never grant more authority than the user supplied globally.
	let mode = resolveOctoberPermissionMode(pi);
	let locked = false;
	const lockMode = (ctx: ExtensionContext): void => {
		if (locked) return;
		locked = true;
		const flag = pi.getFlag("permission-mode");
		if (isMode(flag)) mode = flag;
		if (!ctx.isProjectTrusted()) return;
		const project = modeFromSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
		const rank = { ask: 0, "accept-edits": 1, bypass: 2 };
		if (project && rank[project] < rank[mode]) mode = project;
	};
	let subscribed = false;
	const subscribe = (): void => {
		if (subscribed) return;
		subscribed = true;
		pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
			lockMode(ctx);
			const toolClass = classifyTool(event.toolName);
			const temporaryCeiling = controller.getTemporaryCeiling();
			if (temporaryCeiling === "read-only" && toolClass !== "read") {
				return {
					block: true,
					reason: "blocked by the read-only ceiling on the active October Bus delegation",
				};
			}
			const effectiveMode = temporaryCeiling === "accept-edits" && mode === "bypass" ? "accept-edits" : mode;
			if (!permissionRequiresPrompt(effectiveMode, toolClass)) return undefined;

			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `blocked by permission mode ${effectiveMode} in non-interactive mode`,
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
		lockMode(ctx);
		subscribe();
	});
}
