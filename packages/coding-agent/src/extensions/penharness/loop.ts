/**
 * The hunt loop. Upstream PenHarness ships an opencode plugin (`hunt-loop.js`) that, on every idle
 * of the lead session, re-prompts the SAME session with "continue the hunt" — one continuous
 * conversation that keeps working, deliberately the opposite of restart-style loops. This is that
 * behavior on october's lifecycle: when the lead session settles idle inside an engaged hunt, it
 * re-injects the continue prompt.
 *
 * Gating (all must hold, or the loop stays silent):
 *   - interactive TUI only — dispatched workers run in json/print mode and must never loop;
 *   - an engaged hunt is reachable from cwd (scope.md + `.hunt-active`, no `.hunt-loop-pause`);
 *   - no user message is queued (the user's input always wins);
 *   - a minimum interval has elapsed since the last auto-prompt (leaves a window to interject).
 *
 * A safety cap auto-pauses the loop after a run of uninterrupted auto-ticks so a wedged hunt cannot
 * burn inference forever; the user resumes with `/hunt-resume`.
 */

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { findActiveHunt, isActive, isPaused, pauseLoop } from "./hunt.ts";
import { HUNT_CONTINUE_PROMPT } from "./methodology.ts";

/** Minimum gap between auto-prompts. Also the window in which a user can start typing to take over. */
const MIN_TICK_MS = 8000;
/** Auto-pause after this many uninterrupted auto-ticks. Reset by any user-initiated turn. */
const SAFETY_MAX_CONSECUTIVE = 40;

export function registerHuntLoop(pi: ExtensionAPI): void {
	let lastTickAt = 0;
	let consecutiveAuto = 0;
	let expectingAutoTurn = false;
	let scheduled: ReturnType<typeof setTimeout> | undefined;

	// Distinguish our own auto-turns from user-initiated ones: a turn we did not schedule means the
	// user (or a tool) drove it, so the safety counter resets.
	pi.on("turn_start", () => {
		if (expectingAutoTurn) {
			expectingAutoTurn = false;
		} else {
			consecutiveAuto = 0;
		}
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return; // workers and headless runs never loop
		if (ctx.hasPendingMessages()) {
			consecutiveAuto = 0;
			return;
		}
		const huntDir = findActiveHunt(ctx.cwd);
		if (!huntDir) {
			ctx.ui.setStatus("penharness", undefined);
			return;
		}

		const now = Date.now();
		const wait = Math.max(0, MIN_TICK_MS - (now - lastTickAt));
		if (scheduled) clearTimeout(scheduled);
		scheduled = setTimeout(() => {
			scheduled = undefined;
			// Re-check everything at fire time: the world may have moved while we waited.
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				consecutiveAuto = 0;
				return;
			}
			if (!isActive(huntDir) || isPaused(huntDir)) {
				ctx.ui.setStatus("penharness", undefined);
				return;
			}
			if (consecutiveAuto >= SAFETY_MAX_CONSECUTIVE) {
				pauseLoop(huntDir);
				ctx.ui.setStatus("penharness", "hunt: paused (safety)");
				ctx.ui.notify(
					`Hunt loop auto-paused after ${SAFETY_MAX_CONSECUTIVE} ticks without user input. Review progress, then /hunt-resume.`,
					"warning",
				);
				return;
			}
			lastTickAt = Date.now();
			consecutiveAuto++;
			expectingAutoTurn = true;
			ctx.ui.setStatus("penharness", "hunt: active (/hunt-pause to stop)");
			pi.sendUserMessage(HUNT_CONTINUE_PROMPT);
		}, wait);
	});
}
