import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getSettingsPath } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";
import { registerSessionPermissionInfoProvider } from "../../core/session-permission-info.ts";

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

/**
 * Where the permission mode came from. `host` is a mode passed to `registerOctoberPermissions` by an
 * application that runs the gate programmatically; the rest are the process sources in precedence order.
 */
export type OctoberPermissionModeSource = "host" | "flag" | "environment" | "global settings" | "default";

const SOURCE_LABEL: Record<OctoberPermissionModeSource, string> = {
	host: "the host application",
	flag: "--permission-mode",
	environment: "OCTOBER_PERMISSION_MODE",
	"global settings": "global settings",
	default: "the default",
};

export function resolveOctoberPermissionModeWithSource(pi: ExtensionAPI): {
	mode: OctoberPermissionMode;
	source: OctoberPermissionModeSource;
} {
	const flag = pi.getFlag("permission-mode");
	if (isMode(flag)) return { mode: flag, source: "flag" };
	const env = process.env.OCTOBER_PERMISSION_MODE?.trim();
	if (isMode(env)) return { mode: env, source: "environment" };
	const global = modeFromSettingsFile(getSettingsPath());
	if (global) return { mode: global, source: "global settings" };
	return { mode: "bypass", source: "default" };
}

export function permissionRequiresPrompt(mode: OctoberPermissionMode, toolClass: ToolPermissionClass): boolean {
	if (mode === "bypass" || toolClass === "read") return false;
	if (mode === "accept-edits") return toolClass === "command";
	return true;
}

/** The session policy as locked at startup, plus the delegation ceiling active right now. */
export interface OctoberPermissionPolicy {
	/** False until the session snapshot is taken (first session start or tool call). */
	locked: boolean;
	selected: { mode: OctoberPermissionMode; source: OctoberPermissionModeSource };
	/** `trusted` is null before the snapshot. `setting` is only read for a trusted project. */
	project: { trusted: boolean | null; setting: OctoberPermissionMode | null; tightened: boolean };
	delegationCeiling: OctoberTemporaryPermissionCeiling | null;
	/** The mode tools are checked against: the session mode, lowered by an `accept-edits` ceiling. */
	effectiveMode: OctoberPermissionMode;
}

export type OctoberToolDecision = { outcome: "allow" | "ask" | "block"; reason: string };

export interface OctoberPermissionExplanation extends OctoberPermissionPolicy {
	interactive: boolean;
	tools: Record<ToolPermissionClass, OctoberToolDecision>;
}

/** Which layer set the effective mode, in words, for decisions and explanations. */
function modeOrigin(policy: OctoberPermissionPolicy): string {
	// A trusted project that tightened the session wins: the ceiling only lowers an unrestricted (bypass) session.
	if (policy.project.tightened) return "trusted project settings";
	if (policy.delegationCeiling === "accept-edits" && policy.selected.mode === "bypass") {
		return "the accept-edits ceiling on the active October Bus delegation";
	}
	return SOURCE_LABEL[policy.selected.source];
}

/**
 * The single decision used by the tool gate and by explanations, so a denial names the layer that
 * applied. Read-only: it never changes the policy.
 */
export function decideToolPermission(
	policy: OctoberPermissionPolicy,
	toolClass: ToolPermissionClass,
	interactive: boolean,
): OctoberToolDecision {
	if (policy.delegationCeiling === "read-only" && toolClass !== "read") {
		return { outcome: "block", reason: "blocked by the read-only ceiling on the active October Bus delegation" };
	}
	const mode = policy.effectiveMode;
	const origin = modeOrigin(policy);
	if (!permissionRequiresPrompt(mode, toolClass)) {
		return { outcome: "allow", reason: `allowed by permission mode ${mode} (from ${origin})` };
	}
	if (!interactive) {
		return {
			outcome: "block",
			reason: `blocked by permission mode ${mode} in non-interactive mode (from ${origin}); nobody can approve it`,
		};
	}
	return { outcome: "ask", reason: `permission mode ${mode} (from ${origin}) asks before ${toolClass} tools` };
}

export function explainOctoberPermissions(
	policy: OctoberPermissionPolicy,
	interactive: boolean,
): OctoberPermissionExplanation {
	const classes: ToolPermissionClass[] = ["read", "edit", "command"];
	return {
		...policy,
		interactive,
		tools: Object.fromEntries(
			classes.map((toolClass) => [toolClass, decideToolPermission(policy, toolClass, interactive)]),
		) as Record<ToolPermissionClass, OctoberToolDecision>,
	};
}

export function formatOctoberPermissionExplanation(explanation: OctoberPermissionExplanation): string {
	const { selected, project } = explanation;
	const projectLine =
		project.trusted === null
			? "not checked yet"
			: !project.trusted
				? "untrusted, so its settings are ignored"
				: project.setting === null
					? "trusted, no permissionMode set"
					: project.tightened
						? `trusted, permissionMode ${project.setting} tightened the session`
						: `trusted, permissionMode ${project.setting} is not stricter, so it has no effect`;
	const tool = (toolClass: ToolPermissionClass, label: string) => {
		const decision = explanation.tools[toolClass];
		return `- ${label}: ${decision.outcome}, ${decision.reason}`;
	};
	return [
		`Permission mode: ${explanation.effectiveMode}`,
		`- Selected: ${selected.mode} from ${SOURCE_LABEL[selected.source]}${explanation.locked ? ", locked for this session" : ""}`,
		`- Project: ${projectLine}`,
		`- Delegation ceiling: ${explanation.delegationCeiling === "inherit" ? "inherit (adds no restriction)" : (explanation.delegationCeiling ?? "none")}`,
		`- Session: ${explanation.interactive ? "interactive, so asked tools prompt you" : "non-interactive, so tools that would ask are blocked"}`,
		"",
		"Tools:",
		tool("read", "read, grep, find, ls"),
		tool("edit", "edit, write"),
		tool("command", "bash and other tools"),
		"",
		"Project trust only decides which project files October loads; it is not a sandbox. The permission mode decides whether a tool may run. Where an allowed command runs is set by the shellRunner setting, which is this machine unless configured otherwise.",
		"Settings edited after startup do not change this session; restart with an explicit mode to change it.",
	].join("\n");
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

/**
 * Register the permission gate. `options.mode` replaces the process-level mode (flag, environment, global
 * settings) for hosts that run the gate programmatically; trusted project settings may still tighten it.
 */
export function registerOctoberPermissions(
	pi: ExtensionAPI,
	controller = createOctoberPermissionController(),
	options: { mode?: OctoberPermissionMode } = {},
): void {
	pi.registerFlag("permission-mode", {
		type: "string",
		description: "Tool permission mode: ask, accept-edits, or bypass. Default bypass. Not --approve.",
	});

	// Snapshot process-owned policy before a tool can edit settings. Project settings
	// may tighten it, never grant more authority than the user supplied globally.
	let selected: OctoberPermissionPolicy["selected"] =
		options.mode !== undefined ? { mode: options.mode, source: "host" } : resolveOctoberPermissionModeWithSource(pi);
	let mode = selected.mode;
	let locked = false;
	const project: OctoberPermissionPolicy["project"] = { trusted: null, setting: null, tightened: false };
	const lockMode = (ctx: ExtensionContext): void => {
		if (locked) return;
		locked = true;
		const flag = pi.getFlag("permission-mode");
		if (options.mode === undefined && isMode(flag)) selected = { mode: flag, source: "flag" };
		mode = selected.mode;
		project.trusted = ctx.isProjectTrusted();
		if (!project.trusted) return;
		const setting = modeFromSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
		project.setting = setting ?? null;
		const rank = { ask: 0, "accept-edits": 1, bypass: 2 };
		if (setting && rank[setting] < rank[mode]) {
			mode = setting;
			project.tightened = true;
		}
	};
	// Built from the snapshot only; it never re-reads settings, so edits after startup cannot misreport it.
	const policy = (): OctoberPermissionPolicy => {
		const ceiling = controller.getTemporaryCeiling();
		return {
			locked,
			selected: { ...selected },
			project: { ...project },
			delegationCeiling: ceiling ?? null,
			effectiveMode: ceiling === "accept-edits" && mode === "bypass" ? "accept-edits" : mode,
		};
	};
	let unregisterPermissionInfo = () => {};
	let permissionInfoSession: object | undefined;
	const registerPermissionInfo = (ctx: ExtensionContext): void => {
		if (permissionInfoSession === ctx.sessionManager) return;
		unregisterPermissionInfo();
		permissionInfoSession = ctx.sessionManager;
		unregisterPermissionInfo = registerSessionPermissionInfoProvider(ctx.sessionManager, (hasUI) =>
			locked ? explainOctoberPermissions(policy(), hasUI) : undefined,
		);
	};
	let subscribed = false;
	const subscribe = (): void => {
		if (subscribed) return;
		subscribed = true;
		pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
			lockMode(ctx);
			registerPermissionInfo(ctx);
			const decision = decideToolPermission(policy(), classifyTool(event.toolName), ctx.hasUI);
			if (decision.outcome === "allow") return undefined;
			if (decision.outcome === "block") return { block: true, reason: decision.reason };

			const preview = argumentPreview(event.input);
			const allowed = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				preview ? `${decision.reason}\n${preview}` : decision.reason,
			);
			if (!allowed) {
				return { block: true, reason: "denied by user" };
			}
			return undefined;
		});
	};

	subscribe();
	pi.on("session_start", (_event, ctx) => {
		lockMode(ctx);
		registerPermissionInfo(ctx);
		subscribe();
	});
	pi.on("session_shutdown", () => {
		unregisterPermissionInfo();
		unregisterPermissionInfo = () => {};
		permissionInfoSession = undefined;
	});
	pi.registerCommand("permissions", {
		description: "Explain the tool permission policy for this session and which layer set it",
		handler: async (_args, ctx) => {
			// Inspection is read-only: only session_start and the first tool call lock the policy.
			if (!locked) {
				ctx.ui.notify(
					"The tool permission policy is not locked yet. It locks when the session finishes starting or on the first tool call; run /permissions again after that.",
					"info",
				);
				return;
			}
			ctx.ui.notify(formatOctoberPermissionExplanation(explainOctoberPermissions(policy(), ctx.hasUI)), "info");
		},
	});
}
