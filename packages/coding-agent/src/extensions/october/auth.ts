import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { ProviderConfig } from "../../core/extensions/types.ts";
import { logOctoberDebug } from "./bus/log.ts";

export const OCTOBER_PROVIDER_ID = "october";

/** Seconds of head-room subtracted from a token's real expiry so a request never rides the edge. */
const EXPIRY_SAFETY_MS = 60_000;

type OctoberOAuth = NonNullable<ProviderConfig["oauth"]>;

interface SupabaseSessionEnv {
	url: string;
	anonKey: string;
	accessToken: string;
	refreshToken: string;
	expiresAt?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The Supabase session October-desktop injects for the signed-in user, mirroring how it already
 * injects OCTOBER_BUS_*. Absent outside the October app, which keeps the provider inert there.
 */
function readSupabaseSessionEnv(env: NodeJS.ProcessEnv = process.env): SupabaseSessionEnv | undefined {
	const url = nonEmpty(env.OCTOBER_SUPABASE_URL);
	const anonKey = nonEmpty(env.OCTOBER_SUPABASE_ANON_KEY);
	const accessToken = nonEmpty(env.OCTOBER_SUPABASE_ACCESS_TOKEN);
	const refreshToken = nonEmpty(env.OCTOBER_SUPABASE_REFRESH_TOKEN);
	if (!url || !anonKey || !accessToken || !refreshToken) return undefined;

	const expiresRaw = nonEmpty(env.OCTOBER_SUPABASE_EXPIRES_AT);
	const expiresAt = expiresRaw !== undefined ? Number(expiresRaw) : undefined;
	return {
		url: url.replace(/\/$/, ""),
		anonKey,
		accessToken,
		refreshToken,
		expiresAt: expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined,
	};
}

/** Best-effort `exp` claim (seconds) from a JWT, without verifying the signature. */
function jwtExpiryMs(token: string): number | undefined {
	const segments = token.split(".");
	if (segments.length < 2) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
			return payload.exp * 1000;
		}
	} catch {
		// Not a decodable JWT; fall through.
	}
	return undefined;
}

/** Resolve an absolute expiry (epoch ms, with safety head-room) from the fields a session can carry. */
function resolveExpiryMs(input: { expiresAtSeconds?: number; expiresInSeconds?: number; accessToken: string }): number {
	if (input.expiresAtSeconds !== undefined && Number.isFinite(input.expiresAtSeconds)) {
		return input.expiresAtSeconds * 1000 - EXPIRY_SAFETY_MS;
	}
	if (input.expiresInSeconds !== undefined && Number.isFinite(input.expiresInSeconds)) {
		return Date.now() + input.expiresInSeconds * 1000 - EXPIRY_SAFETY_MS;
	}
	const fromJwt = jwtExpiryMs(input.accessToken);
	if (fromJwt !== undefined) return fromJwt - EXPIRY_SAFETY_MS;
	// Unknown expiry: assume the Supabase default (1h) so refresh still kicks in.
	return Date.now() + 60 * 60 * 1000 - EXPIRY_SAFETY_MS;
}

function credentialFromEnv(session: SupabaseSessionEnv): OAuthCredentials {
	return {
		access: session.accessToken,
		refresh: session.refreshToken,
		expires: resolveExpiryMs({ expiresAtSeconds: session.expiresAt, accessToken: session.accessToken }),
		supabaseUrl: session.url,
		supabaseAnonKey: session.anonKey,
	};
}

/** True when the process carries a signed-in October session (i.e. it runs inside the October app). */
export function octoberSessionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return readSupabaseSessionEnv(env) !== undefined;
}

interface SupabaseTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	expires_at?: number;
}

async function refreshOctoberSession(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const url = String(credentials.supabaseUrl ?? readSupabaseSessionEnv()?.url ?? "").replace(/\/$/, "");
	const anonKey = String(credentials.supabaseAnonKey ?? readSupabaseSessionEnv()?.anonKey ?? "");
	const refresh = String(credentials.refresh ?? "");
	if (!url || !anonKey || !refresh) {
		throw new Error("Cannot refresh the October session: missing Supabase url, anon key, or refresh token.");
	}

	const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
		method: "POST",
		headers: { "Content-Type": "application/json", apikey: anonKey },
		body: JSON.stringify({ refresh_token: refresh }),
		signal,
	});
	if (!response.ok) {
		throw new Error(`October session refresh failed: HTTP ${response.status}`);
	}
	const body = (await response.json()) as SupabaseTokenResponse;
	if (!body.access_token || !body.refresh_token) {
		throw new Error("October session refresh returned no tokens.");
	}
	return {
		access: body.access_token,
		refresh: body.refresh_token,
		expires: resolveExpiryMs({
			expiresAtSeconds: body.expires_at,
			expiresInSeconds: body.expires_in,
			accessToken: body.access_token,
		}),
		supabaseUrl: url,
		supabaseAnonKey: anonKey,
	};
}

/**
 * The provider's OAuth config. `getApiKey` hands the current Supabase access token to the inference
 * gateway as the bearer; pi refreshes it under a store lock via `refreshToken` before it expires.
 */
export function buildOctoberOAuth(): OctoberOAuth {
	return {
		name: "October (signed in via the October app)",
		isSubscription: true,
		async login() {
			const session = readSupabaseSessionEnv();
			if (!session) {
				throw new Error("Sign in to the October app; octo uses your existing October session automatically.");
			}
			return credentialFromEnv(session);
		},
		refreshToken: refreshOctoberSession,
		getApiKey: (credentials) => String(credentials.access ?? ""),
	};
}

/**
 * Import the app-provided session into pi's credential store so inference works with no `/login`.
 * Idempotent and race-safe (write under the store lock); a no-op when no session is present, and it
 * never throws — an auth hiccup must not break a coding session.
 */
export async function seedOctoberCredential(): Promise<void> {
	const session = readSupabaseSessionEnv();
	if (!session) return;
	try {
		const envCredential = credentialFromEnv(session);
		const store = AuthStorage.create(getAuthPath());
		await store.modify(OCTOBER_PROVIDER_ID, async (current) => {
			if (
				current?.type === "oauth" &&
				typeof current.expires === "number" &&
				current.expires >= envCredential.expires
			) {
				// A stored session is at least as fresh as the injected one; leave it for the refresh loop.
				return current;
			}
			return { type: "oauth", ...envCredential };
		});
	} catch (error) {
		logOctoberDebug(`october auth seed failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
