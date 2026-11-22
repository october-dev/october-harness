/**
 * PenHarness, as a native october capability.
 *
 * Upstream PenHarness (https://github.com/harshsaver/penharness) is a white-hat security hunt
 * harness built on opencode: a methodology skill, a Python `fleet.py` that dispatches opencode
 * workers over HTTP, and an idle "continue the hunt" loop plugin. This extension re-implements the
 * same capability on october's own seams so a user can trigger a fleet-scaled hunt with `/hunt`
 * from a stock october, no opencode and no Python:
 *
 *   - `/hunt`, `/hunt-status`, `/hunt-pause`, `/hunt-resume`, `/hunt-stop` (commands.ts)
 *   - `hunt_dispatch` / `hunt_status` tools that fan hypotheses out to isolated october workers
 *     (fleet.ts) — the october-native replacement for the opencode worker fleet
 *   - the idle loop that keeps the lead hunting (loop.ts), october's `agent_settled` in place of
 *     the opencode `hunt-loop.js` plugin
 *
 * The extension registers triggers unconditionally (they are opt-in) and the loop stays inert until
 * a hunt is engaged, so a plain october session is unchanged.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerHuntCommands } from "./commands.ts";
import { registerHuntFleet } from "./fleet.ts";
import { registerHuntLoop } from "./loop.ts";

export default function penharnessExtension(pi: ExtensionAPI): void {
	registerHuntFleet(pi);
	registerHuntCommands(pi);
	registerHuntLoop(pi);
}
