import { expect, it, vi } from "vitest";
import { createCapabilityPreflightHost } from "../src/cli/capability-preflight.ts";
import { showStartupSelector } from "../src/cli/startup-ui.ts";
import type { CapabilityPreflightItem } from "../src/core/extensions/capability-preflight.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("../src/cli/startup-ui.ts", () => ({ showStartupSelector: vi.fn() }));

it("prints one startup roster and warning while preserving each extension choice and declared manifest", async () => {
	const items: CapabilityPreflightItem[] = Array.from({ length: 6 }, (_, index) => ({
		identity: `package-${index}`,
		path: `/extension-${index}.ts`,
		reason: "installed",
		disclosure: { status: "unclassified" },
		fingerprint: "test",
		summary: "unclassified",
		details: "Repeated missing manifest warning",
	}));
	items.push({
		...items[0]!,
		identity: "declared",
		path: "/declared.ts",
		disclosure: { status: "declared", source: "test", manifest: { manifestVersion: 1, shell: true } },
		details: "Declared shell access",
	});
	const host = createCapabilityPreflightHost({
		getMode: () => "interactive",
		settingsManager: SettingsManager.inMemory(),
	});
	const selector = vi.mocked(showStartupSelector);
	selector.mockResolvedValue(true).mockResolvedValueOnce(undefined);
	const output = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await host.disclose(items)).toEqual(
			items.map((item, index) => ({ path: item.path, accept: index !== 0 })),
		);
		expect(output).toHaveBeenCalledTimes(2);
		const overview = String(output.mock.calls[0]?.[0]);
		expect(overview).toContain("unknown capabilities");
		for (const [index, item] of items.entries()) {
			expect(overview).toContain(item.identity);
			expect(selector.mock.calls[index]?.[1]).toContain(item.identity);
		}
		expect(output).toHaveBeenLastCalledWith("Declared shell access");
	} finally {
		output.mockRestore();
	}
});
