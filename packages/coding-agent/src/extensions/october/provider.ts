import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "../../core/extensions/types.ts";
import { buildOctoberOAuth, OCTOBER_PROVIDER_ID } from "./auth.ts";

export { OCTOBER_PROVIDER_ID };
/** Production OpenAI-compatible root. Overridable via OCTOBER_INFERENCE_BASE_URL for tests. */
export const DEFAULT_OCTOBER_BASE_URL = "https://www.october.dev/v1";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Hetzner publishes no verifiable context figure; 128000 is the conservative value from the gateway
// handover. Under-claiming only compacts sooner; over-claiming gets oversized requests rejected.
const DEFAULT_CONTEXT_WINDOW = 128000;
// Safe output ceiling per the handover. These models spend budget on a reasoning trace first, so a
// small cap yields empty content — pi's own internal requests must keep a floor well above this.
const DEFAULT_MAX_TOKENS = 32000;

interface OctoberModelMeta {
	name: string;
	input: ("text" | "image")[];
	reasoning: boolean;
}

/**
 * Per-model metadata the `/models` catalogue does not carry, from the gateway handover. Ids not in
 * this table fall back to DEFAULT_META and are still exposed — a new October model must not require a
 * harness release to become usable.
 */
const DEFAULT_META: OctoberModelMeta = { name: "", input: ["text"], reasoning: false };
const MODEL_META: Record<string, OctoberModelMeta> = {
	"october/Kimi-K2.7-Code": { name: "Kimi K2.7 Code (recommended)", input: ["text", "image"], reasoning: false },
	"october/Qwen/Qwen3.6-35B-A3B-FP8": { name: "Qwen3.6 35B A3B", input: ["text"], reasoning: true },
};

/** The first entry is what bare `--provider october` selects. */
export const OCTOBER_DEFAULT_MODEL_ID = "october/Kimi-K2.7-Code";
const SEED_ORDER: readonly string[] = [OCTOBER_DEFAULT_MODEL_ID, "october/Qwen/Qwen3.6-35B-A3B-FP8"];

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

/** Build a model entry for an id, applying known metadata and conservative defaults for the rest. */
function modelFor(id: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW): ProviderModelConfig {
	const meta = MODEL_META[id] ?? DEFAULT_META;
	return {
		id,
		name: meta.name.length > 0 ? meta.name : id,
		reasoning: meta.reasoning,
		input: meta.input,
		cost: ZERO_COST,
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

/** Static baseline so `--provider october` works before the first /models refresh. Kimi is first. */
export const OCTOBER_SEED_MODELS: ProviderModelConfig[] = SEED_ORDER.map((id) => modelFor(id));

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

/**
 * Discover models from `${baseUrl}/models`. Ids are taken verbatim — no
 * lowercasing, prefix stripping, or slash rewriting (ids carry their own slashes,
 * e.g. `october/Qwen/Qwen3.6-35B-A3B-FP8`). Skip the network when no token is resolvable.
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

		const live: ProviderModelConfig[] = [];
		for (const entry of data) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id !== "string" || id.length === 0) continue;
			live.push(modelFor(id, contextWindowFromEntry(entry as Record<string, unknown>)));
		}

		const byId = new Map(live.map((model) => [model.id, model]));
		const ordered: ProviderModelConfig[] = [];
		for (const seedId of SEED_ORDER) {
			const match = byId.get(seedId);
			if (match) {
				ordered.push(match);
				byId.delete(seedId);
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
