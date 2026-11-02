import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
	"fireworks/accounts/fireworks/models/gpt-oss-120b",
	"fireworks/accounts/fireworks/models/qwen3p8-max",
	"anthropic/claude-haiku-5-5",
	"minimax/MiniMax-M3.1-Flash",
	"minimax-cn/MiniMax-M3.1-Flash",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter(
				(modelId) =>
					// Regression for #9323: Fireworks uses catalog effort metadata and
					// verified fallbacks, not a fixed set of adaptive model names.
					modelId.startsWith("fireworks/") ||
					/^openrouter\/~anthropic\/claude-(fable|haiku|opus|sonnet)-latest$/.test(modelId) ||
					/(opus[-.](4[-.][678]|5)|sonnet[-.]4[-.]6|sonnet[-.]5|fable[-.]5|haiku[-.]5|MiniMax-M3)/.test(modelId),
			),
		);
	});

	it("uses the upstream Chat Completions reasoning format for Kimi Coding", () => {
		const models = getModels("kimi-coding");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.api === "openai-completions" && model.reasoning)).toBe(true);
	});
});
