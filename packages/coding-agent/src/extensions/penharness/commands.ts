/**
 * User-facing triggers for the hunt. `/hunt <target>` is the native entry point: it scaffolds (or
 * resumes) a hunt workspace, engages the loop, and injects the methodology to kick the lead off.
 * The rest toggle and inspect the loop.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import {
	findHunt,
	pauseLoop,
	resumeLoop,
	scaffoldHunt,
	scopeLooksAuthorized,
	stopLoop,
	summarizeLedger,
} from "./hunt.ts";
import { HUNT_CONTINUE_PROMPT, LEAD_METHODOLOGY } from "./methodology.ts";

function kickoffText(huntDir: string): string {
	const authorized = scopeLooksAuthorized(huntDir);
	const posture = authorized
		? "scope.md is filled in. You are authorized for exactly the targets it names; obey its limits and the Red list."
		: "scope.md is NOT yet filled in. Stay in research-and-planning mode (public surface mapping, reading the target's open-source code, drafting hypotheses) and do NOT actively probe the target until the user authorizes it.";
	return [LEAD_METHODOLOGY, "---", `Hunt directory: ${huntDir}`, posture, "", summarizeLedger(huntDir)].join("\n");
}

export function registerHuntCommands(pi: ExtensionAPI): void {
	pi.registerCommand("hunt", {
		description:
			"Start or resume a whitehat security hunt against a target (scaffolds the workspace and engages the loop)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let target = args.trim();
			if (!target) {
				const existing = findHunt(ctx.cwd);
				if (existing) {
					resumeLoop(existing);
					ctx.ui.setStatus("penharness", "hunt: active (/hunt-pause to stop)");
					pi.sendUserMessage(kickoffText(existing));
					return;
				}
				if (ctx.hasUI) {
					const entered = await ctx.ui.input("Hunt target", "e.g. example.com or a product name");
					target = (entered ?? "").trim();
				}
				if (!target) {
					ctx.ui.notify("Usage: /hunt <target>. Names the engagement; creates hunts/<target>/.", "warning");
					return;
				}
			}

			const huntDir = scaffoldHunt(ctx.cwd, target);
			ctx.ui.setStatus("penharness", "hunt: active (/hunt-pause to stop)");
			if (!scopeLooksAuthorized(huntDir)) {
				ctx.ui.notify(`Hunt scaffolded at ${huntDir}. Fill in scope.md to authorize active probing.`, "info");
			} else {
				ctx.ui.notify(`Hunt engaged at ${huntDir}.`, "info");
			}
			pi.sendUserMessage(kickoffText(huntDir));
		},
	});

	pi.registerCommand("hunt-status", {
		description: "Show the current hunt's ledger (findings by status/severity, confirmed headlines, dead ends)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const huntDir = findHunt(ctx.cwd);
			if (!huntDir) {
				ctx.ui.notify("No hunt found here. Run /hunt <target> first.", "warning");
				return;
			}
			ctx.ui.notify(summarizeLedger(huntDir), "info");
		},
	});

	pi.registerCommand("hunt-pause", {
		description: "Pause the hunt loop (stop auto-continuing on idle). Resume with /hunt-resume",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const huntDir = findHunt(ctx.cwd);
			if (!huntDir) {
				ctx.ui.notify("No hunt found here.", "warning");
				return;
			}
			pauseLoop(huntDir);
			ctx.ui.setStatus("penharness", "hunt: paused (/hunt-resume)");
			ctx.ui.notify("Hunt loop paused. The session stays open; /hunt-resume to continue.", "info");
		},
	});

	pi.registerCommand("hunt-resume", {
		description: "Resume a paused hunt loop and continue hunting",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const huntDir = findHunt(ctx.cwd);
			if (!huntDir) {
				ctx.ui.notify("No hunt found here. Run /hunt <target> first.", "warning");
				return;
			}
			resumeLoop(huntDir);
			ctx.ui.setStatus("penharness", "hunt: active (/hunt-pause to stop)");
			pi.sendUserMessage(HUNT_CONTINUE_PROMPT);
		},
	});

	pi.registerCommand("hunt-stop", {
		description: "Disengage the hunt loop for this workspace (keeps all findings)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const huntDir = findHunt(ctx.cwd);
			if (!huntDir) {
				ctx.ui.notify("No hunt found here.", "warning");
				return;
			}
			stopLoop(huntDir);
			ctx.ui.setStatus("penharness", undefined);
			ctx.ui.notify(`Hunt loop disengaged. Ledger kept at ${huntDir}.`, "info");
		},
	});
}
