import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDebugLogPath } from "../../../config.ts";

/** Append one line to the agent debug log. Never throws. */
export function logOctoberDebug(message: string): void {
	try {
		const path = getDebugLogPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// An unreachable October must not fail the session.
	}
}
