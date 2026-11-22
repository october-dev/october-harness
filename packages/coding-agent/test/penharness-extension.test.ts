import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import penharnessExtension from "../src/extensions/penharness/index.ts";

const tempDirs: string[] = [];

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penharness-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function loadExtension() {
	const runtime = createExtensionRuntime();
	return loadExtensionFromFactory(
		penharnessExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:penharness>",
	);
}

describe("penharness extension registration", () => {
	it("registers the hunt commands and tools", async () => {
		const extension = await loadExtension();
		for (const command of ["hunt", "hunt-status", "hunt-pause", "hunt-resume", "hunt-stop"]) {
			expect(extension.commands.has(command)).toBe(true);
		}
		expect(extension.tools.has("hunt_dispatch")).toBe(true);
		expect(extension.tools.has("hunt_status")).toBe(true);
	});

	it("hunt_dispatch refuses to spawn when there is no hunt in cwd", async () => {
		const extension = await loadExtension();
		const base = makeWorkspace();
		const dispatch = extension.tools.get("hunt_dispatch");
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		await expect(
			dispatch.definition.execute("call-1", { lane: "cve", hypotheses: ["probe one thing"] }, undefined, undefined, {
				cwd: base,
			} as unknown as ExtensionToolContext),
		).rejects.toThrow("/hunt");
	});
});
