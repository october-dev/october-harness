import { spawn } from "node:child_process";
import type { AssistantMessage, OAuthCredentials } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "../../core/extensions/types.ts";
import { logOctoberDebug } from "./bus/log.ts";
import { runOctoberDeviceCodeLogin } from "./device-code.ts";
import { logoutOctoberWithStore, saveOctoberCredential } from "./token-lifecycle.ts";

export const OCTOBER_PROVIDER_ID = "october";

/** Seconds of head-room subtracted from a token's real expiry so a request never rides the edge. */
const EXPIRY_SAFETY_MS = 60_000;
/** Match pi's stored-oauth refresh window. Desktop refresh is extension-owned. */
const DESKTOP_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DESKTOP_REFRESH_TIMEOUT_MS = 15_000;
const DESKTOP_REFRESH_RETRY_MS = 30_000;
/** Cap on OCTOBER_TOKEN_COMMAND output; a token response is a few KB at most. */
const TOKEN_COMMAND_MAX_OUTPUT = 64 * 1024;

type OctoberOAuth = NonNullable<ProviderConfig["oauth"]>;

interface SupabaseSessionEnv {
	url: string;
	anonKey: string;
	accessToken: string;
	/** Empty when the launching app (Desktop, or another app such as Lantern) keeps the refresh token. */
	refreshToken: string;
	expiresAt?: number;
}

/** Stable token in the message so Desktop's error classifier can match it. */
export const OCTOBER_SESSION_UNAVAILABLE_CODE = "october_session_unavailable";
/** Marks a 401 after which OCTOBER_TOKEN_COMMAND supplied a new token, so the turn is retried. */
export const OCTOBER_SESSION_REFRESHED_CODE = "october_session_refreshed";

/**
 * Desktop owns the Supabase session and the Bus could not supply a fresh access token. The
 * harness never refreshes against Supabase itself in this state; October must re-issue the token.
 */
export class OctoberSessionUnavailableError extends Error {
	readonly code = OCTOBER_SESSION_UNAVAILABLE_CODE;
	readonly reason: string;

	constructor(reason: string, options?: ErrorOptions) {
		super(
			`October session unavailable (${OCTOBER_SESSION_UNAVAILABLE_CODE}): ${reason}. Ask October to refresh your sign-in, then retry.`,
			options,
		);
		this.name = "OctoberSessionUnavailableError";
		this.reason = reason;
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The Supabase session a launching app injects for the signed-in user, mirroring how October Desktop
 * injects OCTOBER_BUS_*. Absent outside such an app, which keeps the provider inert there. The refresh
 * token is optional: without it the launching app owns refresh (see isOctoberManagedSessionMode).
 */
function readSupabaseSessionEnv(env: NodeJS.ProcessEnv = process.env): SupabaseSessionEnv | undefined {
	const url = nonEmpty(env.OCTOBER_SUPABASE_URL);
	const anonKey = nonEmpty(env.OCTOBER_SUPABASE_ANON_KEY);
	const accessToken = nonEmpty(env.OCTOBER_SUPABASE_ACCESS_TOKEN);
	const refreshToken = nonEmpty(env.OCTOBER_SUPABASE_REFRESH_TOKEN) ?? "";
	if (!url || !anonKey || !accessToken) return undefined;

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

/**
 * The launching app owns the October session: Desktop (refresh over the Bus), or any app that
 * injects an access token without a refresh token (refresh through OCTOBER_TOKEN_COMMAND). The
 * session lives only in memory and is never written to the credential store.
 */
export function isOctoberManagedSessionMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return isOctoberDesktopMode(env) || readSupabaseSessionEnv(env)?.refreshToken === "";
}

function tokenCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return nonEmpty(env.OCTOBER_TOKEN_COMMAND);
}

/** Desktop always retries over the Bus; other managed sessions refresh only with a token command. */
function managedRefreshConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return isOctoberDesktopMode(env) || tokenCommand(env) !== undefined;
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

/** A managed session as the environment describes it, read without refreshing it or changing any state. */
export interface ManagedOctoberSessionSnapshot {
	/** `desktop`: October Desktop owns the session. `app`: another launching app injected it without a refresh token. */
	owner: "desktop" | "app";
	/** What a session would ask for a new token: the Desktop Bus token route or OCTOBER_TOKEN_COMMAND. */
	refresher?: "bus" | "token-command";
	/** `refresh-due`: still valid, but inside the window in which a session refreshes it. */
	state: "missing" | "valid" | "refresh-due" | "expired";
	accessToken?: string;
	/** Epoch ms after which the token is no longer used (its expiry minus safety head-room). */
	expiresAt?: number;
}

/**
 * Inspect the managed October session for diagnostics. Unlike resolveManagedOctoberAccessToken, this
 * never refreshes, runs OCTOBER_TOKEN_COMMAND, schedules timers, sets OCTOBER_INFERENCE_TOKEN, or
 * logs. Returns undefined outside managed-session mode.
 */
export function inspectManagedOctoberSession(
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): ManagedOctoberSessionSnapshot | undefined {
	if (!isOctoberManagedSessionMode(env)) return undefined;
	const desktop = isOctoberDesktopMode(env);
	const owner = desktop ? "desktop" : "app";
	const refresher = desktop
		? busRefreshConfigured(env)
			? "bus"
			: undefined
		: tokenCommand(env) !== undefined
			? "token-command"
			: undefined;
	const session = readSupabaseSessionEnv(env);
	if (!session) return { owner, refresher, state: "missing" };
	const credential = credentialFromEnv(session);
	const state =
		credential.expires <= now
			? "expired"
			: now + DESKTOP_REFRESH_MARGIN_MS >= credential.expires
				? "refresh-due"
				: "valid";
	return { owner, refresher, state, accessToken: credential.access, expiresAt: credential.expires };
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
let desktopOwnedToken: string | undefined;
let previousInferenceToken: string | undefined;
let desktopRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let desktopRefreshInFlight: Promise<void> | undefined;
/** Set when a non-Desktop managed session failed for good; later requests fall back to /login. */
let managedSessionUnavailable: string | undefined;
let managedSessionNoticeShown = false;

export function getDesktopOctoberCredential(): OAuthCredentials | undefined {
	return desktopCredential;
}

export function desktopOctoberTokenNeedsRefresh(now = Date.now()): boolean {
	if (!desktopCredential) return false;
	return now + DESKTOP_REFRESH_MARGIN_MS >= desktopCredential.expires;
}

export function stopDesktopOctoberRefresh(): void {
	if (desktopRefreshTimer) {
		clearTimeout(desktopRefreshTimer);
		desktopRefreshTimer = undefined;
	}
}

/** Test helper: drop the in-memory managed session and cancel the refresh timer. */
export function resetDesktopOctoberState(): void {
	stopDesktopOctoberRefresh();
	desktopRefreshInFlight = undefined;
	managedSessionUnavailable = undefined;
	managedSessionNoticeShown = false;
	clearDesktopCredential();
}

/** User-facing reason the launching app's session can no longer be used, if it failed. */
export function managedOctoberSessionNotice(): string | undefined {
	if (!managedSessionUnavailable) return undefined;
	return `The October session from the launching app is no longer usable (${managedSessionUnavailable}). Run /login to sign in to October.`;
}

function markManagedSessionUnavailable(error: unknown): void {
	const reason = error instanceof OctoberSessionUnavailableError ? error.reason : "the token could not be refreshed";
	managedSessionUnavailable = reason;
	stopDesktopOctoberRefresh();
	clearDesktopCredential();
	logOctoberDebug(`managed october session unavailable: ${reason}`);
}

function applyDesktopCredential(next: OAuthCredentials, userId?: string): OAuthCredentials {
	if (desktopOwnedToken === undefined || process.env.OCTOBER_INFERENCE_TOKEN !== desktopOwnedToken) {
		previousInferenceToken = process.env.OCTOBER_INFERENCE_TOKEN;
	}
	desktopCredential = next;
	if (userId) desktopUserId = userId;
	desktopOwnedToken = next.access;
	process.env.OCTOBER_INFERENCE_TOKEN = next.access;
	return next;
}

function clearDesktopCredential(): void {
	desktopCredential = undefined;
	desktopUserId = undefined;
	if (desktopOwnedToken !== undefined && process.env.OCTOBER_INFERENCE_TOKEN === desktopOwnedToken) {
		if (previousInferenceToken === undefined) delete process.env.OCTOBER_INFERENCE_TOKEN;
		else process.env.OCTOBER_INFERENCE_TOKEN = previousInferenceToken;
	}
	desktopOwnedToken = undefined;
	previousInferenceToken = undefined;
}

async function refreshViaBus(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const port = nonEmpty(process.env.OCTOBER_BUS_PORT);
	const busToken = nonEmpty(process.env.OCTOBER_BUS_TOKEN);
	if (!port || !busToken) {
		throw new OctoberSessionUnavailableError("the October Bus token route is not configured");
	}
	const response = await fetch(`http://127.0.0.1:${port}/auth/october-token`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${busToken}` },
		signal,
	});
	if (!response.ok) {
		throw new OctoberSessionUnavailableError(`the October Bus token route answered HTTP ${response.status}`);
	}
	const body = (await response.json()) as { access_token?: unknown; expires_at?: unknown };
	if (typeof body.access_token !== "string" || !body.access_token) {
		throw new OctoberSessionUnavailableError("the October Bus token route returned no access token");
	}
	const next: OAuthCredentials = {
		...credentials,
		access: body.access_token,
		expires: resolveExpiryMs({
			expiresAtSeconds: parseExpiresAtSeconds(body.expires_at),
			accessToken: body.access_token,
		}),
	};
	if (isOctoberDesktopMode()) {
		applyDesktopCredential(next, desktopUserId);
	}
	return next;
}

function parseExpiresAtSeconds(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
	return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Run OCTOBER_TOKEN_COMMAND through the shell. It must print `{"accessToken": "...", "expiresAt":
 * <unix seconds>}` on stdout and exit 0. Its output is never logged because it carries the token.
 */
function runTokenCommand(command: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "ignore"], signal, windowsHide: true });
		const chunks: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > TOKEN_COMMAND_MAX_OUTPUT) {
				child.kill();
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", (error) => {
			reject(
				new OctoberSessionUnavailableError(
					signal.aborted
						? "OCTOBER_TOKEN_COMMAND did not answer in time"
						: "OCTOBER_TOKEN_COMMAND could not start",
					{ cause: error },
				),
			);
		});
		child.on("close", (code) => {
			if (size > TOKEN_COMMAND_MAX_OUTPUT) {
				reject(new OctoberSessionUnavailableError("OCTOBER_TOKEN_COMMAND printed too much output"));
			} else if (code !== 0) {
				reject(new OctoberSessionUnavailableError(`OCTOBER_TOKEN_COMMAND exited with code ${code}`));
			} else {
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		});
	});
}

async function refreshViaTokenCommand(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const command = tokenCommand();
	if (!command) {
		throw new OctoberSessionUnavailableError("the access token expired and OCTOBER_TOKEN_COMMAND is not set");
	}
	const output = await runTokenCommand(command, signal);
	let body: { accessToken?: unknown; expiresAt?: unknown };
	try {
		body = JSON.parse(output) as { accessToken?: unknown; expiresAt?: unknown };
	} catch {
		// The parse error can quote the token. Never propagate it.
		throw new OctoberSessionUnavailableError("OCTOBER_TOKEN_COMMAND did not print JSON");
	}
	if (typeof body?.accessToken !== "string" || !body.accessToken.trim()) {
		throw new OctoberSessionUnavailableError("OCTOBER_TOKEN_COMMAND returned no accessToken");
	}
	const access = body.accessToken.trim();
	return {
		...credentials,
		access,
		expires: resolveExpiryMs({ expiresAtSeconds: parseExpiresAtSeconds(body.expiresAt), accessToken: access }),
	};
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

/**
 * Desktop owns the Supabase session, so under Desktop the Bus is the only refresher. A direct
 * Supabase refresh from here would rotate the token behind Desktop's back and trip Supabase's
 * reuse detection, signing the user out everywhere. Outside Desktop, the stored session refreshes
 * against Supabase as before.
 */
async function refreshOctoberSession(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	if (!isOctoberDesktopMode()) {
		return refreshViaSupabase(credentials, signal);
	}
	if (!busRefreshConfigured()) {
		throw new OctoberSessionUnavailableError("the October Bus token route is not configured");
	}
	try {
		return await refreshViaBus(credentials, signal);
	} catch (error) {
		if (error instanceof OctoberSessionUnavailableError) throw error;
		const reason = signal.aborted ? "the October Bus did not answer in time" : "the October Bus token route failed";
		throw new OctoberSessionUnavailableError(reason, { cause: error });
	}
}

/** The launching app's refresher: the Bus under Desktop, otherwise OCTOBER_TOKEN_COMMAND. */
function refreshManagedSession(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	return isOctoberDesktopMode()
		? refreshOctoberSession(credentials, signal)
		: refreshViaTokenCommand(credentials, signal);
}

function scheduleDesktopOctoberRefresh(): void {
	stopDesktopOctoberRefresh();
	if (!isOctoberManagedSessionMode() || !managedRefreshConfigured() || !desktopCredential) return;
	const delayMs = desktopOctoberTokenNeedsRefresh()
		? DESKTOP_REFRESH_RETRY_MS
		: Math.max(1_000, desktopCredential.expires - Date.now() - DESKTOP_REFRESH_MARGIN_MS);
	desktopRefreshTimer = setTimeout(() => {
		void ensureDesktopOctoberAccess().catch((error) => {
			if (!isOctoberDesktopMode()) {
				markManagedSessionUnavailable(error);
				return;
			}
			logOctoberDebug(`desktop october refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			scheduleDesktopOctoberRefresh();
		});
	}, delayMs);
	desktopRefreshTimer.unref?.();
}

/**
 * A managed session writes no oauth credential, so pi's resolveStoredOAuth loop never runs.
 * The extension must refresh the in-memory JWT and OCTOBER_INFERENCE_TOKEN itself.
 * `$OCTOBER_INFERENCE_TOKEN` is interpolated from process.env on each request (not cached).
 * `force` refreshes even an unexpired token, after the gateway rejected it.
 */
export async function ensureDesktopOctoberAccess(
	signal?: AbortSignal,
	options: { force?: boolean } = {},
): Promise<void> {
	if (!isOctoberManagedSessionMode()) return;
	const session = readSupabaseSessionEnv();
	if (!session) {
		clearDesktopCredential();
		stopDesktopOctoberRefresh();
		return;
	}
	if (managedSessionUnavailable && !isOctoberDesktopMode()) return;
	if (!desktopCredential) {
		applyDesktopCredential(credentialFromEnv(session), readInjectedUserId(process.env, session.accessToken));
	}
	if (!options.force && !desktopOctoberTokenNeedsRefresh()) {
		scheduleDesktopOctoberRefresh();
		return;
	}
	if (desktopRefreshInFlight) {
		await desktopRefreshInFlight;
		return;
	}
	desktopRefreshInFlight = (async () => {
		const current = desktopCredential ?? credentialFromEnv(session);
		// One refresh request per attempt, capped by the timeout; the timer retries later. Callers
		// share a token command run, so one caller's abort must not fail it for the others.
		const timeout = AbortSignal.timeout(DESKTOP_REFRESH_TIMEOUT_MS);
		const shared = signal && isOctoberDesktopMode() ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const next = await refreshManagedSession(current, shared);
			applyDesktopCredential(next, desktopUserId);
			scheduleDesktopOctoberRefresh();
		} catch (error) {
			// Refresh starts inside the expiry margin, so the current token may still be valid.
			// Keep using it and retry on the timer; fail only once it has actually expired.
			// After a 401 (force) the current token is known bad, so it is never kept.
			if (!options.force && !signal?.aborted && current.expires > Date.now()) {
				logOctoberDebug(
					`desktop october refresh failed, keeping the unexpired token: ${error instanceof Error ? error.message : String(error)}`,
				);
				scheduleDesktopOctoberRefresh();
				return;
			}
			throw error;
		}
	})();
	try {
		await desktopRefreshInFlight;
	} finally {
		desktopRefreshInFlight = undefined;
	}
}

/**
 * The bearer for a managed session, for the runtime credential overlay. Desktop stays authoritative
 * and fails closed. Another app's session that expired or could not be refreshed returns undefined,
 * so the request falls back to the stored /login credential, or to an unauthenticated provider.
 */
export async function resolveManagedOctoberAccessToken(signal?: AbortSignal): Promise<string | undefined> {
	if (!isOctoberManagedSessionMode()) return undefined;
	try {
		await ensureDesktopOctoberAccess(signal);
	} catch (error) {
		if (isOctoberDesktopMode() || signal?.aborted) throw error;
		markManagedSessionUnavailable(error);
		return undefined;
	}
	const credential = desktopCredential;
	if (credential && credential.expires > Date.now()) return credential.access;
	if (!isOctoberDesktopMode() && !managedSessionUnavailable) {
		markManagedSessionUnavailable(new OctoberSessionUnavailableError("the access token expired"));
	}
	return undefined;
}

/**
 * After the gateway rejects a managed (non-Desktop) token, ask OCTOBER_TOKEN_COMMAND for a new one.
 * Returns true when it supplied a different token, so the failed request is worth retrying.
 */
export async function refreshManagedOctoberAfterUnauthorized(): Promise<boolean> {
	if (isOctoberDesktopMode() || !isOctoberManagedSessionMode() || managedSessionUnavailable) return false;
	const rejected = desktopCredential?.access;
	try {
		await ensureDesktopOctoberAccess(undefined, { force: true });
	} catch (error) {
		markManagedSessionUnavailable(error);
		return false;
	}
	return desktopCredential !== undefined && desktopCredential.access !== rejected;
}

/** Interactive sessions get a one-time warning; other modes see the notice in the failed turn. */
function showManagedSessionNotice(ctx: ExtensionContext): void {
	const notice = managedOctoberSessionNotice();
	if (!notice || managedSessionNoticeShown || !ctx.hasUI) return;
	managedSessionNoticeShown = true;
	ctx.ui.notify(notice, "warning");
}

/** Drive managed-session refresh from session/turn lifecycle because pi cannot. */
export function registerOctoberDesktopAuth(pi: ExtensionAPI): void {
	if (!isOctoberManagedSessionMode()) return;
	if (!isOctoberDesktopMode()) {
		registerManagedSessionAuth(pi);
		return;
	}
	pi.on("session_start", () => {
		void ensureDesktopOctoberAccess().catch((error) => {
			logOctoberDebug(
				`desktop october refresh on session_start failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	});
	pi.on("before_agent_start", async () => {
		try {
			await ensureDesktopOctoberAccess();
		} catch (error) {
			logOctoberDebug(
				`desktop october refresh on before_agent_start failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
	pi.on("session_shutdown", () => {
		stopDesktopOctoberRefresh();
	});
}

/** A non-Desktop launching app: token command refresh, 401 retry, and a /login fallback notice. */
function registerManagedSessionAuth(pi: ExtensionAPI): void {
	let retryUnauthorized = false;
	pi.on("session_start", async (_event, ctx) => {
		await resolveManagedOctoberAccessToken().catch(() => undefined);
		showManagedSessionNotice(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await resolveManagedOctoberAccessToken().catch(() => undefined);
		showManagedSessionNotice(ctx);
	});
	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 401 || ctx.model?.provider !== OCTOBER_PROVIDER_ID) return;
		retryUnauthorized = await refreshManagedOctoberAfterUnauthorized();
		showManagedSessionNotice(ctx);
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== OCTOBER_PROVIDER_ID) return;
		const retry = retryUnauthorized;
		retryUnauthorized = false;
		if (message.stopReason !== "error") return;
		const notice = managedOctoberSessionNotice();
		let errorMessage: string;
		if (retry) {
			errorMessage = `October rejected the session token (HTTP 401); OCTOBER_TOKEN_COMMAND supplied a new one (${OCTOBER_SESSION_REFRESHED_CODE}).`;
		} else if (notice) {
			errorMessage = message.errorMessage ? `${notice} ${message.errorMessage}` : notice;
		} else {
			return;
		}
		const replacement: AssistantMessage = { ...message, errorMessage };
		return { message: replacement };
	});
	pi.on("session_shutdown", () => {
		stopDesktopOctoberRefresh();
	});
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
			// Only a session with its own refresh token may be stored; a managed one stays in memory.
			const session = readSupabaseSessionEnv();
			if (session?.refreshToken) {
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

/** Commit a CLI token, then revoke superseded inference tokens without losing recovery state. */
export async function storeOctoberInferenceToken(token: string, authPath = getAuthPath()): Promise<void> {
	await saveOctoberCredential(AuthStorage.create(authPath), { type: "api_key", key: token });
}

export async function logoutOctober(authPath = getAuthPath(), signal?: AbortSignal): Promise<boolean> {
	return logoutOctoberWithStore(AuthStorage.create(authPath), signal);
}

export async function seedOctoberCredential(): Promise<void> {
	const session = readSupabaseSessionEnv();
	if (isOctoberManagedSessionMode()) {
		if (!session) {
			clearDesktopCredential();
			return;
		}
		const next = credentialFromEnv(session);
		const userId = readInjectedUserId(process.env, session.accessToken);
		applyDesktopCredential(next, userId);
		scheduleDesktopOctoberRefresh();
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
