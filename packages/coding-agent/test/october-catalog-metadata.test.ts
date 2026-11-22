import type { Model, RefreshModelsContext, UserMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderChatModelConfig } from "../src/core/extensions/types.ts";
import {
	getOctoberPricing,
	octoberModelBadge,
	octoberModelPricingDetail,
	parseOctoberPricing,
	setOctoberPricing,
} from "../src/extensions/october/pricing.ts";
import { OCTOBER_DEFAULT_MODEL_ID, refreshOctoberModels } from "../src/extensions/october/provider.ts";

// Isolate catalogue parsing from login/storage and diagnostic IO. The real refresh, pricing and
// image transformation paths run below; fetch never reaches a provider.
vi.mock("../src/extensions/october/auth.ts", () => ({ OCTOBER_PROVIDER_ID: "october" }));
vi.mock("../src/extensions/october/bus/log.ts", () => ({ logOctoberDebug: vi.fn() }));

async function catalogue(data: unknown[]): Promise<ProviderChatModelConfig[]> {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
	const context: RefreshModelsContext = {
		credential: { type: "api_key", key: "catalogue-fixture" },
		stored: undefined,
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
	};
	return refreshOctoberModels(context);
}

afterEach(() => {
	vi.unstubAllGlobals();
	setOctoberPricing(new Map());
});

describe("October catalogue capabilities", () => {
	it.each(["vision", "image", "images", "image_input", " IMAGE_INPUT "])(
		"keeps image content for an unpriced route advertising %s",
		async (tag) => {
			const [entry] = await catalogue([{ id: "google/new-vision-route", capabilities: [tag] }]);
			expect(entry?.input).toEqual(["text", "image"]);
			const model: Model<"openai-completions"> = {
				...entry!,
				api: "openai-completions",
				provider: "october",
				baseUrl: "http://127.0.0.1/v1",
			};
			const user: UserMessage = {
				role: "user",
				content: [{ type: "image", data: "fixture", mimeType: "image/png" }],
				timestamp: 0,
			};
			expect(transformMessages([user], model)).toEqual([user]);
		},
	);

	it.each([undefined, [], ["text"], ["image_output"], "vision", ["vision", null], { vision: true }])(
		"keeps unknown routes text-only for absent, unrelated or malformed tags: %j",
		async (capabilities) => {
			const [model] = await catalogue([{ id: "groq/unknown", capabilities }]);
			expect(model?.input).toEqual(["text"]);
		},
	);

	it("preserves existing Kimi and Claude image metadata without tags", async () => {
		const models = await catalogue([
			{ id: "october/Kimi-K2.7-Code" },
			{ id: "claude/lite" },
			{ id: "claudette/lite" },
		]);
		expect(models.map((model) => model.input)).toEqual([["text", "image"], ["text", "image"], ["text"]]);
	});

	it("discovers provider IDs verbatim without adding credentials or hardcoded seeds", async () => {
		const ids = ["openrouter/vendor/model:free", "groq/new-model", "google/Some_Model", "inference/new-ad-route"];
		const models = await catalogue(ids.map((id) => ({ id })));
		expect(models.map((model) => model.id)).toEqual(ids);
		expect(models.every((model) => model.input.length === 1)).toBe(true);
	});
});

describe("October catalogue pricing", () => {
	it.each([
		{ wire: { request_usd: 0.002 }, expected: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, requestUsd: 0.002 } },
		{ wire: { input_usd_per_million: 2 }, expected: { inputUsdPerMillion: 2, outputUsdPerMillion: 0 } },
		{ wire: { output_usd_per_million: 3 }, expected: { inputUsdPerMillion: 0, outputUsdPerMillion: 3 } },
	])("retains request-only and one-sided rates: $wire", async ({ wire, expected }) => {
		expect(parseOctoberPricing(wire)).toEqual(expected);
		const models = await catalogue([
			{ id: "paid/route", pricing: wire, capabilities: ["vision"] },
			{ id: "october/free-route", capabilities: ["vision"] },
		]);
		expect(models.map((model) => model.id)).toEqual(["october/free-route", "paid/route"]);
		const paid = { ...models[1]!, provider: "october" };
		expect(paid.input).toEqual(["text"]);
		expect(paid.maxTokens).toBe(16384);
		expect(getOctoberPricing(paid)).toEqual(expected);
		expect(octoberModelBadge(paid)).toContain("Pro/Max");
		expect(octoberModelBadge({ provider: "october", id: "october/free-route" })).toBe("free");
		if (expected.requestUsd) {
			expect(octoberModelBadge(paid)).toContain("+$0.002/req");
			expect(octoberModelPricingDetail(paid)).toContain("$0.002 per request");
		}
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "2", null])(
		"rejects invalid supplied rates without exposing a free model: %s",
		async (value) => {
			for (const field of ["input_usd_per_million", "output_usd_per_million", "request_usd"]) {
				const pricing = { input_usd_per_million: 1, output_usd_per_million: 2, [field]: value };
				expect(parseOctoberPricing(pricing)).toBeNull();
				const models = await catalogue([{ id: "invalid/route", pricing }, { id: "october/free-route" }]);
				expect(models.map((model) => model.id)).toEqual(["october/free-route"]);
				expect(octoberModelBadge({ provider: "october", id: "invalid/route" })).toBe("pricing unavailable");
			}
		},
	);

	it.each(["paid", 3, [], false])("rejects malformed pricing blocks: %j", async (pricing) => {
		expect(parseOctoberPricing(pricing)).toBeNull();
		expect(await catalogue([{ id: "invalid/route", pricing }])).toEqual([]);
	});

	it("does not restore an invalid priced seed as a free fallback", async () => {
		expect(await catalogue([{ id: OCTOBER_DEFAULT_MODEL_ID, pricing: { request_usd: -1 } }])).toEqual([]);
		expect(octoberModelBadge({ provider: "october", id: OCTOBER_DEFAULT_MODEL_ID })).toBe("pricing unavailable");
	});

	it("keeps unknown unpriced routes selectable without claiming free access", async () => {
		const unknownIds = ["claude/pro", "google/new-model", "groq/new-model"];
		const freeIds = ["claude/lite", "october/free-route", "nvidia/model", "openrouter/vendor/model:free"];
		const models = await catalogue([...unknownIds, ...freeIds].map((id) => ({ id })));
		expect(models.map((model) => model.id)).toEqual([...unknownIds, ...freeIds]);
		for (const id of unknownIds) {
			expect(octoberModelBadge({ provider: "october", id })).toBe("pricing unavailable");
		}
		for (const id of freeIds) expect(octoberModelBadge({ provider: "october", id })).toBe("free");
	});

	it.each([false, true])(
		"rejects conflicting duplicate pricing and capabilities (paid first: %s)",
		async (paidFirst) => {
			const duplicate = [
				{ id: "october/duplicate", capabilities: ["vision"] },
				{ id: "october/duplicate", pricing: { request_usd: 0.002 } },
			];
			const models = await catalogue([
				...(paidFirst ? duplicate.reverse() : duplicate),
				{ id: "october/free-route" },
			]);
			expect(models.map((model) => model.id)).toEqual(["october/free-route"]);
			expect(getOctoberPricing({ provider: "october", id: "october/duplicate" })).toBeUndefined();
			expect(octoberModelBadge({ provider: "october", id: "october/duplicate" })).toBe("pricing unavailable");
		},
	);

	it("retains the existing seed fallback for an empty catalogue", async () => {
		expect((await catalogue([])).map((model) => model.id)).toEqual([OCTOBER_DEFAULT_MODEL_ID]);
	});

	it("does not label restored zero-token-cost models free before their request fee is known", async () => {
		const [entry] = await catalogue([{ id: "paid/request-only", pricing: { request_usd: 0.002 } }]);
		const restored = { ...entry!, provider: "october" };
		setOctoberPricing(new Map());
		expect(octoberModelBadge(restored)).toBe("pricing unavailable");
		expect(octoberModelPricingDetail(restored)).not.toContain("Free");
		expect(octoberModelBadge({ provider: "october", id: "paid/token-cost", cost: { input: 1, output: 0 } })).toBe(
			"$1/$0/M · Pro/Max",
		);
	});

	it("does not render negative or nonfinite restored token costs", () => {
		for (const input of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
			expect(octoberModelBadge({ provider: "october", id: "cached/invalid", cost: { input, output: 2 } })).toBe(
				"pricing unavailable",
			);
		}
	});
});
