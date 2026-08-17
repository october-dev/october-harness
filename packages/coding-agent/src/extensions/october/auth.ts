import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { ProviderConfig } from "../../core/extensions/types.ts";
import { logOctoberDebug } from "./bus/log.ts";
import { revokeOctoberInferenceToken, runOctoberDeviceCodeLogin } from "./device-code.ts";

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

function decodeJwtPayload(token: string): { exp?: unknown; sub?: unknown } | undefined {
	const segments = token.split(".");
	if (segments.length < 2) return undefined;
	try {
		return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { exp?: unknown; sub?: unknown };
	} catch {
		return undefined;
	}
}

/** Best-effort `exp` claim (seconds) from a JWT, without verifying the signature. */
function jwtExpiryMs(token: string): number | undefined {
	const payload = decodeJwtPayload(token);
	if (typeof payload?.exp === "number" && Number.isFinite(payload.exp)) {
		return payload.exp * 1000;
	}
	return undefined;
}

function jwtSub(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	return typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
}

function readInjectedUserId(env: NodeJS.ProcessEnv = process.env, accessToken?: string): string | undefined {
	return nonEmpty(env.OCTOBER_SUPABASE_USER_ID) ?? (accessToken ? jwtSub(accessToken) : undefined);
}

/** Desktop mode: the October app spawned this process (bus is present). */
export function isOctoberDesktopMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return nonEmpty(env.OCTOBER_BUS_PORT) !== undefined;
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

let desktopCredential: OAuthCredentials | undefined;
let desktopUserId: string | undefined;

export function getDesktopOctoberCredential(): OAuthCredentials | undefined {
	return desktopCredential;
}

/** Test helper: drop the in-memory Desktop session. */
export function resetDesktopOctoberState(): void {
	desktopCredential = undefined;
	desktopUserId = undefined;
}

function applyDesktopCredential(next: OAuthCredentials, userId?: string): OAuthCredentials {
	desktopCredential = next;
	if (userId) desktopUserId = userId;
	process.env.OCTOBER_INFERENCE_TOKEN = next.access;
	return next;
}

function clearDesktopCredential(): void {
	desktopCredential = undefined;
	desktopUserId = undefined;
	delete process.env.OCTOBER_INFERENCE_TOKEN;
}

async function refreshViaBus(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const port = nonEmpty(process.env.OCTOBER_BUS_PORT);
	const busToken = nonEmpty(process.env.OCTOBER_BUS_TOKEN);
	if (!port || !busToken) {
		throw new Error("October bus token refresh is not available.");
	}
	const response = await fetch(`http://127.0.0.1:${port}/auth/october-token`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${busToken}` },
		signal,
	});
	if (!response.ok) {
		throw new Error(`October bus token refresh failed: HTTP ${response.status}`);
	}
	const body = (await response.json()) as { access_token?: unknown; expires_at?: unknown };
	if (typeof body.access_token !== "string" || !body.access_token) {
		throw new Error("October bus token refresh returned no access_token.");
	}
	const expiresAt =
		typeof body.expires_at === "number"
			? body.expires_at
			: typeof body.expires_at === "string"
				? Number(body.expires_at)
				: undefined;
	const next: OAuthCredentials = {
		...credentials,
		access: body.access_token,
		expires: resolveExpiryMs({
			expiresAtSeconds: expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined,
			accessToken: body.access_token,
		}),
	};
	if (isOctoberDesktopMode()) {
		applyDesktopCredential(next, desktopUserId);
	}
	return next;
}

function busRefreshConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return nonEmpty(env.OCTOBER_BUS_PORT) !== undefined && nonEmpty(env.OCTOBER_BUS_TOKEN) !== undefined;
}

async function refreshViaSupabase(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
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
	const next: OAuthCredentials = {
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
	if (isOctoberDesktopMode()) {
		applyDesktopCredential(next, desktopUserId);
	}
	return next;
}

async function refreshOctoberSession(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	if (busRefreshConfigured()) {
		try {
			return await refreshViaBus(credentials, signal);
		} catch (error) {
			// Part C may not be live yet: Desktop already injects the bus, but
			// /auth/october-token can 404 or refuse. Fall back to Supabase.
			logOctoberDebug(
				`october bus token refresh failed, falling back to Supabase: ${error instanceof Error ? error.message : String(error)}`,
			);
			return refreshViaSupabase(credentials, signal);
		}
	}
	return refreshViaSupabase(credentials, signal);
}

/**
 * The provider's OAuth config. `getApiKey` hands the current Supabase access token to the inference
 * gateway as the bearer; pi refreshes it under a store lock via `refreshToken` before it expires.
 */
export function buildOctoberOAuth(): OctoberOAuth {
	return {
		name: "October",
		loginLabel: "Sign in with October",
		isSubscription: true,
		async login(callbacks) {
			const session = readSupabaseSessionEnv();
			if (session) {
				return credentialFromEnv(session);
			}
			const token = await runOctoberDeviceCodeLogin(callbacks);
			return {
				access: token,
				refresh: "",
				expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
			};
		},
		refreshToken: refreshOctoberSession,
		getApiKey: (credentials) => {
			if (isOctoberDesktopMode()) {
				const session = readSupabaseSessionEnv();
				if (!session) {
					clearDesktopCredential();
					return "";
				}
				if (desktopCredential?.access) return desktopCredential.access;
			}
			return String(credentials.access ?? "");
		},
	};
}

/**
 * Import the app-provided session into pi's credential store so inference works with no `/login`.
 * Idempotent and race-safe (write under the store lock); a no-op when no session is present, and it
 * never throws — an auth hiccup must not break a coding session.
 */
export async function storeOctoberInferenceToken(token: string, authPath = getAuthPath()): Promise<void> {
	const store = AuthStorage.create(authPath);
	await store.modify(OCTOBER_PROVIDER_ID, async () => ({ type: "api_key", key: token }));
}

export async function logoutOctober(authPath = getAuthPath(), signal?: AbortSignal): Promise<boolean> {
	const store = AuthStorage.create(authPath);
	const current = await store.read(OCTOBER_PROVIDER_ID);
	if (!current) return false;
	const token = current.type === "api_key" ? current.key : current.type === "oauth" ? current.access : undefined;
	if (typeof token === "string" && token.startsWith("oct_inf_")) {
		await revokeOctoberInferenceToken(token, signal);
	}
	await store.delete(OCTOBER_PROVIDER_ID);
	return true;
}

export async function seedOctoberCredential(): Promise<void> {
	const session = readSupabaseSessionEnv();
	if (isOctoberDesktopMode()) {
		if (!session) {
			clearDesktopCredential();
			return;
		}
		const next = credentialFromEnv(session);
		const userId = readInjectedUserId(process.env, session.accessToken);
		if (desktopUserId && userId && desktopUserId !== userId) {
			applyDesktopCredential(next, userId);
			return;
		}
		applyDesktopCredential(next, userId);
		return;
	}

	if (!session) return;
	const envCredential = credentialFromEnv(session);
	const userId = readInjectedUserId(process.env, session.accessToken);
	try {
		const store = AuthStorage.create(getAuthPath());
		await store.modify(OCTOBER_PROVIDER_ID, async (current) => {
			if (current?.type === "oauth") {
				const storedUserId = typeof current.supabaseUserId === "string" ? current.supabaseUserId : undefined;
				if (userId && storedUserId && userId !== storedUserId) {
					return { type: "oauth", ...envCredential, supabaseUserId: userId };
				}
				if (typeof current.expires === "number" && current.expires >= envCredential.expires) {
					return current;
				}
			}
			return { type: "oauth", ...envCredential, ...(userId ? { supabaseUserId: userId } : {}) };
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logOctoberDebug(`october auth seed failed: ${message}`);
		console.error(`October credential store write failed: ${message}`);
		throw error;
	}
}
