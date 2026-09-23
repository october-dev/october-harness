import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type AssistantMessage, isRetryableAssistantError, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, MessageEndEventResult } from "../src/core/extensions/types.ts";
import {
	describeOctoberGatewayError,
	parseOctoberCredit,
	parseOctoberGatewayError,
	registerOctoberBilling,
} from "../src/extensions/october/billing.ts";
import {
	getOctoberPricing,
	octoberModelBadge,
	octoberModelPricingDetail,
	parseOctoberPricing,
} from "../src/extensions/october/pricing.ts";
import {
	OCTOBER_DEFAULT_MODEL_ID,
	OCTOBER_PROVIDER_ID,
	OCTOBER_SEED_MODELS,
	refreshOctoberModels,
} from "../src/extensions/october/provider.ts";

const PAID_ID = "openrouter/anthropic/claude-sonnet-5";
const PAID_PRICING = {
	billing: "october_credit",
	input_usd_per_million: 3,
	output_usd_per_million: 15,
	request_usd: 0.001,
};

const servers: Server[] = [];

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

function refreshContext(): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "test-token" },
		stored: undefined,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal: new AbortController().signal,
	};
}

function errorMessage(model: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: OCTOBER_PROVIDER_ID,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	};
}

type MessageEndHandler = (
	event: { type: "message_end"; message: AssistantMessage },
	ctx: ExtensionContext,
) => Promise<MessageEndEventResult | undefined>;

function registerBilling(): Map<string, MessageEndHandler> {
	const handlers = new Map<string, MessageEndHandler>();
	const pi = { on: (event: string, handler: MessageEndHandler) => handlers.set(event, handler) };
	registerOctoberBilling(pi as unknown as ExtensionAPI);
	return handlers;
}

function fakeContext(model: string, setStatus = vi.fn()): ExtensionContext {
	return {
		hasUI: true,
		model: { provider: OCTOBER_PROVIDER_ID, id: model },
		modelRegistry: { getApiKeyForProvider: async () => "test-token" },
		ui: { setStatus },
	} as unknown as ExtensionContext;
}

async function loadPaidCatalogue(url: string): Promise<void> {
	process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
	await refreshOctoberModels(refreshContext());
}

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env.OCTOBER_INFERENCE_BASE_URL;
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("october credit-billed models", () => {
	it("parses catalogue pricing and ignores free entries", () => {
		expect(parseOctoberPricing(PAID_PRICING)).toEqual({
			inputUsdPerMillion: 3,
			outputUsdPerMillion: 15,
			requestUsd: 0.001,
		});
		expect(
			parseOctoberPricing({ billing: "october_credit", input_usd_per_million: 1, output_usd_per_million: 2 }),
		).toEqual({ inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
		expect(parseOctoberPricing(undefined)).toBeUndefined();
		expect(parseOctoberPricing({ billing: "october_credit" })).toBeUndefined();
	});

	it("exposes paid models as text-only, priced, and after free models", async () => {
		const { url } = await listen((_request, response) =>
			json(response, {
				data: [
					{ id: PAID_ID, context_window: 200000, pricing: PAID_PRICING },
					{
						id: "openrouter/openai/gpt-6-luna",
						max_output_tokens: 8192,
						pricing: { ...PAID_PRICING, request_usd: undefined },
					},
					{ id: "nvidia/mistralai/mistral-nemotron" },
					{ id: OCTOBER_DEFAULT_MODEL_ID },
				],
			}),
		);
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		const models = await refreshOctoberModels(refreshContext());

		expect(models.map((model) => model.id)).toEqual([
			OCTOBER_DEFAULT_MODEL_ID,
			"nvidia/mistralai/mistral-nemotron",
			PAID_ID,
			"openrouter/openai/gpt-6-luna",
		]);
		const paid = models[2]!;
		expect(paid.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
		expect(paid.input).toEqual(["text"]);
		expect(paid.contextWindow).toBe(200000);
		expect(paid.maxTokens).toBe(16384);
		expect(models[3]?.maxTokens).toBe(8192);
		expect(models[0]?.cost.input).toBe(0);

		expect(octoberModelBadge({ provider: OCTOBER_PROVIDER_ID, id: PAID_ID })).toBe("$3/$15/M +$0.001/req · Pro/Max");
		expect(octoberModelBadge({ provider: OCTOBER_PROVIDER_ID, id: "openrouter/openai/gpt-6-luna" })).toBe(
			"$3/$15/M · Pro/Max",
		);
		expect(octoberModelBadge({ provider: OCTOBER_PROVIDER_ID, id: OCTOBER_DEFAULT_MODEL_ID })).toBe("free");
		expect(octoberModelBadge({ provider: "anthropic", id: PAID_ID })).toBeUndefined();
		// A cached paid model restored before the catalogue refresh is still labelled by its cost.
		expect(
			octoberModelBadge({
				provider: OCTOBER_PROVIDER_ID,
				id: "openrouter/x/uncached",
				cost: { input: 1, output: 2 },
			}),
		).toBe("$1/$2/M · Pro/Max");
		expect(octoberModelPricingDetail({ provider: OCTOBER_PROVIDER_ID, id: PAID_ID })).toBe(
			"$3 input / $15 output per 1M tokens + $0.001 per request, billed at cost from October Pro/Max credit",
		);
	});

	it("recovers the gateway error code from a real openai-completions error", async () => {
		const { url } = await listen((_request, response) =>
			json(
				response,
				{
					error: {
						message: "Paid models require October Pro or Max.",
						type: "permission_error",
						param: null,
						code: "plan_required",
					},
				},
				403,
			),
		);
		const seed = OCTOBER_SEED_MODELS[0]!;
		const message = await streamSimple(
			{ ...seed, id: PAID_ID, api: "openai-completions", provider: OCTOBER_PROVIDER_ID, baseUrl: `${url}/v1` },
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-token", maxRetries: 0 },
		).result();

		expect(message.stopReason).toBe("error");
		expect(parseOctoberGatewayError(message.errorMessage ?? "")).toMatchObject({ code: "plan_required" });
	});

	it("keeps plan and credit errors non-retryable and capacity errors retryable", () => {
		const plan = describeOctoberGatewayError({ code: "plan_required" })!;
		const credit = describeOctoberGatewayError(
			{ code: "credit_exhausted" },
			{ remainingCents: 0, monthlyCents: 2000, creditPeriodEnd: "2026-10-01T00:00:00.000Z" },
		)!;
		const capacity = describeOctoberGatewayError({ code: "upstream_capacity_exhausted" })!;

		expect(plan).toContain("Upgrade to Pro or Max");
		expect(plan).toContain(OCTOBER_DEFAULT_MODEL_ID);
		expect(credit).toContain("resets on Oct 1, 2026");
		expect(credit).toContain("Top up");
		expect(isRetryableAssistantError(errorMessage(PAID_ID, plan))).toBe(false);
		expect(isRetryableAssistantError(errorMessage(PAID_ID, credit))).toBe(false);
		expect(isRetryableAssistantError(errorMessage(PAID_ID, capacity))).toBe(true);
		expect(describeOctoberGatewayError({ code: "invalid_api_key" })).toBeUndefined();
	});

	it("parses the remaining harness credit from the plan snapshot", () => {
		expect(
			parseOctoberCredit({
				features: { harnessCredit: { remainingCents: 1234, monthlyCents: 2000, creditPeriodEnd: null } },
			}),
		).toEqual({ remainingCents: 1234, monthlyCents: 2000 });
		expect(parseOctoberCredit({ features: {} })).toBeUndefined();
	});

	it("rewrites credit exhaustion with the reset date and refreshes the credit indicator", async () => {
		const seenPaths: string[] = [];
		const { url } = await listen((request, response) => {
			seenPaths.push(String(request.url));
			if (request.url === "/v1/models") {
				json(response, { data: [{ id: PAID_ID, pricing: PAID_PRICING }] });
				return;
			}
			if (request.url === "/api/plan") {
				expect(request.headers.authorization).toBe("Bearer test-token");
				json(response, {
					features: {
						harnessCredit: { remainingCents: 0, monthlyCents: 6000, creditPeriodEnd: "2026-10-01T00:00:00.000Z" },
					},
				});
				return;
			}
			response.writeHead(404).end();
		});
		await loadPaidCatalogue(url);
		expect(getOctoberPricing({ provider: OCTOBER_PROVIDER_ID, id: PAID_ID })).toBeDefined();

		const setStatus = vi.fn();
		const handler = registerBilling().get("message_end")!;
		const raw =
			'402: {"message":"No harness credit left.","type":"insufficient_quota","param":null,"code":"credit_exhausted"}';
		const result = await handler(
			{ type: "message_end", message: errorMessage(PAID_ID, raw) },
			fakeContext(PAID_ID, setStatus),
		);

		const rewritten = (result?.message as AssistantMessage | undefined)?.errorMessage;
		expect(rewritten).toContain("credit for this billing period is used up");
		expect(rewritten).toContain("Oct 1, 2026");
		expect(setStatus).toHaveBeenCalledWith("october-credit", "October credit $0.00");
		expect(seenPaths).toContain("/api/plan");
	});

	it("leaves authentication and unrelated errors untouched", async () => {
		const handler = registerBilling().get("message_end")!;
		const ctx = fakeContext(OCTOBER_DEFAULT_MODEL_ID);
		const auth =
			'401: {"message":"Missing or invalid October credential.","type":"authentication_error","param":null,"code":"invalid_api_key"}';
		expect(
			await handler({ type: "message_end", message: errorMessage(OCTOBER_DEFAULT_MODEL_ID, auth) }, ctx),
		).toBeUndefined();
		expect(
			await handler({ type: "message_end", message: errorMessage(OCTOBER_DEFAULT_MODEL_ID, "fetch failed") }, ctx),
		).toBeUndefined();
	});
});
