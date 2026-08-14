import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "../../core/extensions/types.ts";
import { buildOctoberOAuth, OCTOBER_PROVIDER_ID } from "./auth.ts";

export { OCTOBER_PROVIDER_ID };
/** Production OpenAI-compatible root. Overridable via OCTOBER_INFERENCE_BASE_URL for tests. */
export const DEFAULT_OCTOBER_BASE_URL = "https://www.october.dev/v1";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 131072;
const REASONING_MAX_TOKENS = 32768;

function isLoopbackUrl(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.toLowerCase();
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Production root, or a test override. The override is honored only for loopback
 * hosts: a stored October credential must never be sent to an attacker-controlled
 * external host via an injected OCTOBER_INFERENCE_BASE_URL.
 */
export function octoberBaseUrl(): string {
	const override = process.env.OCTOBER_INFERENCE_BASE_URL?.trim();
	if (override && override.length > 0 && isLoopbackUrl(override)) {
		return override.replace(/\/$/, "");
	}
	return DEFAULT_OCTOBER_BASE_URL;
}

export function resolveOctoberToken(): string | undefined {
	const token = process.env.OCTOBER_INFERENCE_TOKEN?.trim();
	return token && token.length > 0 ? token : undefined;
}

function seedModel(id: string, name: string): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: REASONING_MAX_TOKENS,
	};
}

/** Static baseline so `--provider october` works before the first /models refresh. Kimi is first. */
export const OCTOBER_SEED_MODELS: ProviderModelConfig[] = [
	seedModel("hetzner/kimi-k2", "Kimi K2 (recommended: fast, reliable tool calling)"),
	seedModel("hetzner/glm-4.7", "GLM 4.7 (unreliable: timeouts observed)"),
	seedModel("hetzner/qwen3-coder", "Qwen3 Coder (slow, intermittent 502s)"),
];

function tokenFromRefreshContext(context: RefreshModelsContext): string | undefined {
	const credential = context.credential;
	if (credential?.type === "api_key") {
		const key = credential.key?.trim();
		if (key) return key;
	}
	if (credential?.type === "oauth") {
		const access = typeof credential.access === "string" ? credential.access.trim() : "";
		if (access) return access;
	}
	return resolveOctoberToken();
}

function contextWindowFromEntry(entry: Record<string, unknown>): number {
	for (const key of ["context_window", "context_length", "max_model_len", "max_context_length"] as const) {
		const value = entry[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return DEFAULT_CONTEXT_WINDOW;
}

function seedNameById(): Map<string, string> {
	return new Map(OCTOBER_SEED_MODELS.map((model) => [model.id, model.name]));
}

function modelFromLiveId(id: string, contextWindow: number, names: Map<string, string>): ProviderModelConfig {
	return {
		id,
		name: names.get(id) ?? id,
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens: REASONING_MAX_TOKENS,
	};
}

/**
 * Discover models from `${baseUrl}/models`. Ids are taken verbatim — no
 * lowercasing, prefix stripping, or slash rewriting. Skip the network when no
 * token is resolvable.
 */
export async function refreshOctoberModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const token = tokenFromRefreshContext(context);
	if (!token || !context.allowNetwork || context.signal.aborted) {
		return OCTOBER_SEED_MODELS;
	}

	try {
		const response = await fetch(`${octoberBaseUrl()}/models`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			signal: context.signal,
		});
		if (!response.ok) {
			return OCTOBER_SEED_MODELS;
		}
		const body: unknown = await response.json();
		const data =
			body && typeof body === "object" && "data" in body && Array.isArray((body as { data: unknown }).data)
				? (body as { data: unknown[] }).data
				: undefined;
		if (!data) {
			return OCTOBER_SEED_MODELS;
		}

		const names = seedNameById();
		const live: ProviderModelConfig[] = [];
		for (const entry of data) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id !== "string" || id.length === 0) continue;
			live.push(modelFromLiveId(id, contextWindowFromEntry(entry as Record<string, unknown>), names));
		}

		const byId = new Map(live.map((model) => [model.id, model]));
		const ordered: ProviderModelConfig[] = [];
		for (const seed of OCTOBER_SEED_MODELS) {
			const match = byId.get(seed.id);
			if (match) {
				ordered.push(match);
				byId.delete(seed.id);
			}
		}
		for (const model of live) {
			if (byId.has(model.id)) {
				ordered.push(model);
			}
		}
		return ordered;
	} catch {
		return OCTOBER_SEED_MODELS;
	}
}

export function createOctoberProviderConfig(): ProviderConfig {
	return {
		name: "October",
		baseUrl: octoberBaseUrl(),
		// Primary auth is the signed-in user's Supabase session (oauth, below). The static env token
		// stays as a fallback for tests and non-app use; when neither is present the provider is
		// unauthenticated and pi filters it out of the picker.
		apiKey: "$OCTOBER_INFERENCE_TOKEN",
		oauth: buildOctoberOAuth(),
		api: "openai-completions",
		models: OCTOBER_SEED_MODELS,
		refreshModels: refreshOctoberModels,
	};
}

export function registerOctoberProvider(pi: ExtensionAPI): void {
	pi.registerProvider(OCTOBER_PROVIDER_ID, createOctoberProviderConfig());
}
