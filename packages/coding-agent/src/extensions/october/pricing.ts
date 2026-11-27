import { OCTOBER_PROVIDER_ID } from "./auth.ts";

/** The credential used for a route. Its account is independent of the model's price. */
export function modelAccountLabel(model: { provider: string; id: string }): string | undefined {
	if (model.provider === OCTOBER_PROVIDER_ID) {
		return model.id.startsWith("openrouter/") ? "October account via OpenRouter" : "October account";
	}
	if (model.provider === "openrouter") return "OpenRouter account";
	return undefined;
}

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

/** Undefined means no rates were supplied; null means supplied pricing is invalid. */
export function parseOctoberPricing(value: unknown): OctoberPricing | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const pricing = value as Record<string, unknown>;
	const input = pricing.input_usd_per_million;
	const output = pricing.output_usd_per_million;
	const request = pricing.request_usd;
	if (
		(input !== undefined && !isNonNegativeNumber(input)) ||
		(output !== undefined && !isNonNegativeNumber(output)) ||
		(request !== undefined && !isNonNegativeNumber(request))
	) {
		return null;
	}
	if (input === undefined && output === undefined && (request === undefined || request === 0)) return undefined;
	return {
		inputUsdPerMillion: input ?? 0,
		outputUsdPerMillion: output ?? 0,
		...(request !== undefined && request > 0 ? { requestUsd: request } : {}),
	};
}

// Replaced on every successful catalogue refresh. Model cost carries the token rates, but not
// the per-request fee, so the picker reads the full pricing from here.
let pricingById = new Map<string, OctoberPricing>();
let freeModelIds = new Set<string>();

export function setOctoberPricing(pricing: Map<string, OctoberPricing>, unpricedIds: Iterable<string> = []): void {
	pricingById = pricing;
	// Match Desktop's known free routes. An unknown unpriced route, including claude/pro, does not
	// establish free access merely by omitting token prices from the gateway catalogue.
	freeModelIds = new Set(
		Array.from(unpricedIds).filter((id) => {
			const lower = id.trim().toLowerCase();
			return lower === "claude/lite" || lower.endsWith(":free") || /^(october|nvidia)\//.test(lower);
		}),
	);
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

// Cached models retain token rates, but not request fees. Zero token cost alone cannot prove that
// a restored model is free; require the live catalogue before making that claim.
function pricingFor(model: PricedModel): OctoberPricing | undefined | null {
	const pricing = pricingById.get(model.id);
	if (pricing) return pricing;
	if (
		model.cost &&
		(!Number.isFinite(model.cost.input) ||
			model.cost.input < 0 ||
			!Number.isFinite(model.cost.output) ||
			model.cost.output < 0)
	) {
		return null;
	}
	if (model.cost && (model.cost.input > 0 || model.cost.output > 0)) {
		return { inputUsdPerMillion: model.cost.input, outputUsdPerMillion: model.cost.output };
	}
	return freeModelIds.has(model.id) ? undefined : null;
}

/** Only promote gateway OpenRouter routes confirmed free by the live October catalog. */
export function isFreeOctoberOpenRouterModel(model: PricedModel): boolean {
	return (
		model.provider === OCTOBER_PROVIDER_ID &&
		model.id.startsWith("openrouter/") &&
		model.id.endsWith(":free") &&
		pricingFor(model) === undefined
	);
}

/** Compact picker badge for October models: e.g. "$3/$15/M +$0.001/req · Pro/Max", or "free". */
export function octoberModelBadge(model: PricedModel): string | undefined {
	if (model.provider !== OCTOBER_PROVIDER_ID) return undefined;
	const pricing = pricingFor(model);
	if (pricing === null) return "pricing unavailable";
	if (!pricing) return "free";
	const request = pricing.requestUsd === undefined ? "" : ` +${formatUsd(pricing.requestUsd)}/req`;
	return `${formatUsd(pricing.inputUsdPerMillion)}/${formatUsd(pricing.outputUsdPerMillion)}/M${request} · Pro/Max`;
}

/** Full pricing sentence for the selected model's detail line. */
export function octoberModelPricingDetail(model: PricedModel): string | undefined {
	if (model.provider !== OCTOBER_PROVIDER_ID) return undefined;
	const pricing = pricingFor(model);
	if (pricing === null) return "Price not listed for this model";
	if (!pricing) return "Free with October sign-in";
	const request = pricing.requestUsd === undefined ? "" : ` + ${formatUsd(pricing.requestUsd)} per request`;
	return `${formatUsd(pricing.inputUsdPerMillion)} input / ${formatUsd(pricing.outputUsdPerMillion)} output per 1M tokens${request}, billed at cost from October Pro/Max credit`;
}
