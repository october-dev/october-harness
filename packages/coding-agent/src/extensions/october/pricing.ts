import { OCTOBER_PROVIDER_ID } from "./auth.ts";

/**
 * Credit-billed pricing from a paid `/v1/models` entry. Free models (october/…, nvidia/…,
 * openrouter/…:free) carry no `pricing` field.
 */
export interface OctoberPricing {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
	/** Only present when the model has a per-request fee. */
	requestUsd?: number;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseOctoberPricing(value: unknown): OctoberPricing | undefined {
	if (!value || typeof value !== "object") return undefined;
	const pricing = value as Record<string, unknown>;
	const input = pricing.input_usd_per_million;
	const output = pricing.output_usd_per_million;
	if (!isNonNegativeNumber(input) || !isNonNegativeNumber(output)) return undefined;
	const request = pricing.request_usd;
	return {
		inputUsdPerMillion: input,
		outputUsdPerMillion: output,
		...(isNonNegativeNumber(request) && request > 0 ? { requestUsd: request } : {}),
	};
}

// Replaced on every successful catalogue refresh. Model cost carries the token rates, but not
// the per-request fee, so the picker reads the full pricing from here.
let pricingById = new Map<string, OctoberPricing>();

export function setOctoberPricing(pricing: Map<string, OctoberPricing>): void {
	pricingById = pricing;
}

export function getOctoberPricing(model: { provider: string; id: string }): OctoberPricing | undefined {
	return model.provider === OCTOBER_PROVIDER_ID ? pricingById.get(model.id) : undefined;
}

function formatUsd(value: number): string {
	return `$${Number(value.toFixed(4))}`;
}

interface PricedModel {
	provider: string;
	id: string;
	cost?: { input: number; output: number };
}

// The catalogue map carries the per-request fee; a model restored before the first refresh still
// carries its token rates in `cost`, so it is never mislabelled as free.
function pricingFor(model: PricedModel): OctoberPricing | undefined {
	const pricing = pricingById.get(model.id);
	if (pricing) return pricing;
	if (model.cost && (model.cost.input > 0 || model.cost.output > 0)) {
		return { inputUsdPerMillion: model.cost.input, outputUsdPerMillion: model.cost.output };
	}
	return undefined;
}

/** Compact picker badge for October models: e.g. "$3/$15/M +$0.001/req · Pro/Max", or "free". */
export function octoberModelBadge(model: PricedModel): string | undefined {
	if (model.provider !== OCTOBER_PROVIDER_ID) return undefined;
	const pricing = pricingFor(model);
	if (!pricing) return "free";
	const request = pricing.requestUsd === undefined ? "" : ` +${formatUsd(pricing.requestUsd)}/req`;
	return `${formatUsd(pricing.inputUsdPerMillion)}/${formatUsd(pricing.outputUsdPerMillion)}/M${request} · Pro/Max`;
}

/** Full pricing sentence for the selected model's detail line. */
export function octoberModelPricingDetail(model: PricedModel): string | undefined {
	if (model.provider !== OCTOBER_PROVIDER_ID) return undefined;
	const pricing = pricingFor(model);
	if (!pricing) return "Free with October sign-in";
	const request = pricing.requestUsd === undefined ? "" : ` + ${formatUsd(pricing.requestUsd)} per request`;
	return `${formatUsd(pricing.inputUsdPerMillion)} input / ${formatUsd(pricing.outputUsdPerMillion)} output per 1M tokens${request}, billed at cost from October Pro/Max credit`;
}
