import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { setOctoberPricing } from "../src/extensions/october/pricing.ts";

afterEach(() => {
	setOctoberPricing(new Map());
	vi.restoreAllMocks();
});

const known = {
	provider: "october",
	id: "october/Qwen/Qwen3.6-35B-A3B-FP8",
	contextWindow: 128000,
	maxTokens: 32000,
	reasoning: true,
	input: ["text"],
} as unknown as Model<Api>;

describe("listModels availability timeout", () => {
	it("distinguishes a gateway route from the same model on a direct OpenRouter account", async () => {
		const id = "example/model:free";
		const charged = "openrouter/aaa:free";
		setOctoberPricing(new Map([[charged, { inputUsdPerMillion: 0, outputUsdPerMillion: 0, requestUsd: 0.01 }]]), [
			`openrouter/${id}`,
			known.id,
		]);
		const runtime = {
			getAvailable: async () => [
				known,
				{ ...known, id: charged },
				{ ...known, id: "openrouter/unverified:free" },
				{ ...known, id: `openrouter/${id}` },
				{ ...known, provider: "openrouter", id },
			],
		} as unknown as ModelRuntime;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await listModels(runtime);
		const rows = log.mock.calls.flat().map(String);
		expect(rows[1]).toMatch(/openrouter\/example\/model:free.*\bFREE\s+October account via OpenRouter$/);
		expect(rows.filter((row) => row.includes("FREE"))).toHaveLength(1);
		expect(rows.find((row) => row.includes(charged))).toContain("$0.01/req");
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^october\s+october\/Qwen.*October account$/),
				expect.stringMatching(/^october\s+openrouter\/example\/model:free.*October account via OpenRouter$/),
				expect.stringMatching(/^openrouter\s+example\/model:free.*OpenRouter account$/),
			]),
		);
	});

	it("lists the last known models when the availability check exceeds its deadline", async () => {
		const runtime = {
			getError: () => undefined,
			// Stands in for an auth check that never answers: settles only when the caller aborts.
			getAvailable: (_provider: string | undefined, options?: { signal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
				}),
			getAvailableSnapshot: () => [known],
		} as unknown as ModelRuntime;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const started = Date.now();
		await listModels(runtime, undefined, AbortSignal.timeout(50));

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(error.mock.calls.flat().join("\n")).toContain("timed out");
		expect(log.mock.calls.flat().join("\n")).toContain("october/Qwen/Qwen3.6-35B-A3B-FP8");
	});

	it("still surfaces a non-timeout availability failure", async () => {
		const runtime = {
			getError: () => undefined,
			getAvailable: async () => {
				throw new Error("broken auth store");
			},
			getAvailableSnapshot: () => [known],
		} as unknown as ModelRuntime;

		await expect(listModels(runtime, undefined, AbortSignal.timeout(5_000))).rejects.toThrow("broken auth store");
	});
});
