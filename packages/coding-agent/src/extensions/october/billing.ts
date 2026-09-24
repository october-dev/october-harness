import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { OCTOBER_PROVIDER_ID } from "./auth.ts";
import { logOctoberDebug } from "./bus/log.ts";
import { getOctoberPricing } from "./pricing.ts";
import { OCTOBER_DEFAULT_MODEL_ID, octoberBaseUrl } from "./provider.ts";

const CREDIT_STATUS_KEY = "october-credit";
const PLAN_TIMEOUT_MS = 5_000;

export interface OctoberCreditSnapshot {
	remainingCents: number;
	monthlyCents?: number;
	creditPeriodEnd?: string;
}

/** Plan snapshot lives beside the inference root: https://www.october.dev/api/plan. */
export function octoberPlanUrl(): string {
	return new URL("/api/plan", octoberBaseUrl()).toString();
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseOctoberCredit(body: unknown): OctoberCreditSnapshot | undefined {
	const features = body && typeof body === "object" ? (body as { features?: unknown }).features : undefined;
	const credit =
		features && typeof features === "object" ? (features as { harnessCredit?: unknown }).harnessCredit : undefined;
	if (!credit || typeof credit !== "object") return undefined;
	const fields = credit as Record<string, unknown>;
	const remainingCents = finiteNumber(fields.remainingCents);
	if (remainingCents === undefined) return undefined;
	const monthlyCents = finiteNumber(fields.monthlyCents);
	const creditPeriodEnd = typeof fields.creditPeriodEnd === "string" ? fields.creditPeriodEnd : undefined;
	return {
		remainingCents,
		...(monthlyCents !== undefined ? { monthlyCents } : {}),
		...(creditPeriodEnd ? { creditPeriodEnd } : {}),
	};
}

export async function fetchOctoberCredit(token: string): Promise<OctoberCreditSnapshot | undefined> {
	try {
		const response = await fetch(octoberPlanUrl(), {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
		});
		if (!response.ok) {
			logOctoberDebug(`plan snapshot: HTTP ${response.status}`);
			return undefined;
		}
		return parseOctoberCredit(await response.json());
	} catch (error) {
		logOctoberDebug(`plan snapshot: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export function formatOctoberCredit(snapshot: OctoberCreditSnapshot): string {
	return `October credit $${(Math.max(0, snapshot.remainingCents) / 100).toFixed(2)}`;
}

function formatResetDate(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

interface GatewayError {
	code?: string;
	param?: string;
	message?: string;
}

/**
 * Recover the OpenAI-shaped `{ error: { code, param, message } }` from an assistant errorMessage.
 * The OpenAI SDK surfaces it as `<status>: <inner error JSON>`; fall back to field regexes when the
 * text is not parseable JSON.
 */
export function parseOctoberGatewayError(errorMessage: string): GatewayError | undefined {
	const start = errorMessage.indexOf("{");
	if (start >= 0) {
		try {
			const parsed: unknown = JSON.parse(errorMessage.slice(start));
			if (parsed && typeof parsed === "object") {
				const outer = parsed as Record<string, unknown>;
				const inner = (outer.error && typeof outer.error === "object" ? outer.error : outer) as Record<
					string,
					unknown
				>;
				if (typeof inner.code === "string") {
					return {
						code: inner.code,
						param: typeof inner.param === "string" ? inner.param : undefined,
						message: typeof inner.message === "string" ? inner.message : undefined,
					};
				}
			}
		} catch {
			// Fall through to the regex probe.
		}
	}
	const code = /"code"\s*:\s*"([a-z_]+)"/.exec(errorMessage)?.[1];
	if (!code) return undefined;
	return { code, param: /"param"\s*:\s*"([a-z_]+)"/.exec(errorMessage)?.[1] };
}

const FREE_MODEL_HINT = `switch to a free model with /model (for example ${OCTOBER_DEFAULT_MODEL_ID})`;

/**
 * Replace a gateway error with an actionable message. Wording matters for retry classification:
 * plan and credit errors must stay non-retryable (the credit text includes "billing"), and the
 * capacity error keeps "429" so the normal backoff still applies.
 */
export function describeOctoberGatewayError(error: GatewayError, credit?: OctoberCreditSnapshot): string | undefined {
	const detail = error.message ? ` (${error.message})` : "";
	switch (error.code) {
		case "plan_required":
			return `This model is billed from October Pro or Max credit and is not included in the Free plan. Upgrade to Pro or Max to use it, or ${FREE_MODEL_HINT}.`;
		case "credit_exhausted": {
			const reset = formatResetDate(credit?.creditPeriodEnd);
			const when = reset ? `on ${reset}` : "at the start of your next billing period";
			return `Your October harness credit for this billing period is used up. It resets ${when}. Top up your credit, or ${FREE_MODEL_HINT}.`;
		}
		case "invalid_request":
			if (error.param === "max_tokens") {
				return `The requested output length is above this model's limit${detail}. Choose another model with /model.`;
			}
			if (error.param === "messages") {
				return `Paid October models accept text only${detail}. Remove images from the conversation, or ${FREE_MODEL_HINT}.`;
			}
			return undefined;
		case "model_not_found":
			return `October does not offer this model${detail}. Run /model to pick from the refreshed catalogue.`;
		case "upstream_capacity_exhausted":
			return `October's shared model capacity is temporarily exhausted (429). This is not a problem with your account; the request will be retried.`;
		case "upstream_forbidden":
			return `The upstream model provider refused this request${detail}. This is not a sign-in problem; try again with different input or another model.`;
		default:
			return undefined;
	}
}

/** Fetch the balance and, with a UI, show it in the footer while an October model is active. */
async function refreshCreditStatus(ctx: ExtensionContext): Promise<OctoberCreditSnapshot | undefined> {
	if (ctx.model?.provider !== OCTOBER_PROVIDER_ID) {
		if (ctx.hasUI) ctx.ui.setStatus(CREDIT_STATUS_KEY, undefined);
		return undefined;
	}
	const token = await ctx.modelRegistry.getApiKeyForProvider(OCTOBER_PROVIDER_ID);
	const snapshot = token ? await fetchOctoberCredit(token) : undefined;
	if (ctx.hasUI) {
		// Free plans have no harness credit; show nothing rather than a misleading $0.00.
		const show = snapshot && (snapshot.monthlyCents ?? 0) + Math.max(0, snapshot.remainingCents) > 0;
		ctx.ui.setStatus(CREDIT_STATUS_KEY, show ? formatOctoberCredit(snapshot) : undefined);
	}
	return snapshot;
}

/** Actionable plan/credit errors and a remaining-credit indicator for October's credit-billed models. */
export function registerOctoberBilling(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) void refreshCreditStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		if (ctx.hasUI) void refreshCreditStatus(ctx);
	});
	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== OCTOBER_PROVIDER_ID) return;
		const cost = ctx.model?.id === message.model ? ctx.model.cost : undefined;
		const paid =
			getOctoberPricing({ provider: message.provider, id: message.model }) !== undefined ||
			(cost !== undefined && (cost.input > 0 || cost.output > 0));

		if (message.stopReason !== "error" || !message.errorMessage) {
			// Each paid request is charged when it finishes; refresh the balance without blocking the turn.
			if (paid && ctx.hasUI) void refreshCreditStatus(ctx);
			return;
		}

		const error = parseOctoberGatewayError(message.errorMessage);
		if (!error) return;
		const credit = error.code === "credit_exhausted" ? await refreshCreditStatus(ctx) : undefined;
		const rewritten = describeOctoberGatewayError(error, credit);
		if (!rewritten) return;
		logOctoberDebug(`gateway error: ${error.code}${error.param ? ` param=${error.param}` : ""}`);
		const replacement: AssistantMessage = { ...message, errorMessage: rewritten };
		return { message: replacement };
	});
}
