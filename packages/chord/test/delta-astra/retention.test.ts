import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("astra overlay retention", () => {
	it.each([
		"aborted",
		"dropped-prepared",
		"settled-change",
		"stale-unprepared",
		"stale-held",
		"held-revoked",
		"registry-churn",
	])(
		"releases or invalidates %s",
		(scenario) => {
			const child = spawnSync(
				process.execPath,
				["--expose-gc", fileURLToPath(new URL("./retention.worker.ts", import.meta.url)), scenario],
				{ encoding: "utf8", timeout: 60_000 },
			);
			expect(child.error, child.stderr).toBeUndefined();
			expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
		},
		65_000,
	);
});
