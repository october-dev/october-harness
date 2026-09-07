import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { APP_NAME } from "../../config.ts";
import { openBrowser } from "../../utils/open-browser.ts";

const DEVICE_POLL_CANCEL = "Login cancelled";
const DEVICE_POLL_TIMEOUT = "October login timed out. Run the command again.";
const DEVICE_POLL_MIN_INTERVAL_MS = 1000;
const DEVICE_POLL_DEFAULT_INTERVAL_SECONDS = 5;
const DEVICE_POLL_SLOW_DOWN_MS = 5000;
const DEVICE_LOGIN_MAX_SECONDS = 600;
const DEVICE_REQUEST_TIMEOUT_MS = 15000;

type DevicePollResult<T> =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string }
	| { status: "complete"; value: T };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(DEVICE_POLL_CANCEL));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(DEVICE_POLL_CANCEL));
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** RFC 8628 device-code poller. Local so we do not depend on an unpublished pi-ai/oauth export. */
async function pollDeviceCodeFlow<T>(options: {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	waitBeforeFirstPoll?: boolean;
	poll: () => Promise<DevicePollResult<T>>;
	signal: AbortSignal;
}): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		DEVICE_POLL_MIN_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEVICE_POLL_DEFAULT_INTERVAL_SECONDS) * 1000),
	);
	if (options.waitBeforeFirstPoll) {
		const remainingMs = deadline - Date.now();
		if (remainingMs > 0) {
			await abortableSleep(Math.min(intervalMs, remainingMs), options.signal);
		}
	}
	while (Date.now() < deadline) {
		if (options.signal.aborted) throw new Error(DEVICE_POLL_CANCEL);
		const result = await options.poll();
		if (result.status === "complete") return result.value;
		if (result.status === "failed") throw new Error(result.message);
		if (result.status === "slow_down") {
			intervalMs =
				typeof result.intervalSeconds === "number" &&
				Number.isFinite(result.intervalSeconds) &&
				result.intervalSeconds > 0
					? Math.max(DEVICE_POLL_MIN_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: Math.max(DEVICE_POLL_MIN_INTERVAL_MS, intervalMs + DEVICE_POLL_SLOW_DOWN_MS);
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), options.signal);
	}
	throw new Error(DEVICE_POLL_TIMEOUT);
}

export const DEFAULT_OCTOBER_AUTH_BASE_URL = "https://www.october.dev";
export const OCTOBER_DEVICE_CODE_PATH = "/api/cli/device/code";
export const OCTOBER_DEVICE_TOKEN_PATH = "/api/cli/device/token";
export const OCTOBER_INFERENCE_TOKEN_PREFIX = "oct_inf_";

export const OCTOBER_LOGIN_UNAVAILABLE_MESSAGE =
	`October login is not available yet (could not reach the device-code endpoint). ` +
	`Sign in via the October app, or set OCTOBER_INFERENCE_TOKEN.`;

function isLoopbackUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			!url.username &&
			!url.password &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

/** Production auth origin, or a loopback test override. */
export function octoberAuthBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OCTOBER_AUTH_BASE_URL?.trim();
	if (override && override.length > 0 && isLoopbackUrl(override)) {
		return new URL(override).origin;
	}
	return DEFAULT_OCTOBER_AUTH_BASE_URL;
}

function deviceCodeUrl(): string {
	return `${octoberAuthBaseUrl()}${OCTOBER_DEVICE_CODE_PATH}`;
}

function deviceTokenUrl(): string {
	return `${octoberAuthBaseUrl()}${OCTOBER_DEVICE_TOKEN_PATH}`;
}

export function formatOctoberLoginUnavailable(cause?: unknown): string {
	const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
	const detail = message ? ` (${message})` : "";
	return `${OCTOBER_LOGIN_UNAVAILABLE_MESSAGE}${detail}`;
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval?: number;
	expires_in?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

async function requestDeviceCode(signal: AbortSignal): Promise<DeviceCodeResponse> {
	let response: Response;
	try {
		response = await fetch(deviceCodeUrl(), {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.any([signal, AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS)]),
			redirect: "error",
		});
	} catch (error) {
		if (signal.aborted) throw new Error(DEVICE_POLL_CANCEL);
		throw new Error(formatOctoberLoginUnavailable(error));
	}
	if (!response.ok) {
		throw new Error(formatOctoberLoginUnavailable(`HTTP ${response.status}`));
	}
	const data = await readJson(response);
	if (!isRecord(data)) {
		throw new Error(formatOctoberLoginUnavailable("invalid device-code response"));
	}
	const deviceCode = data.device_code;
	const userCode = data.user_code;
	const verificationUri = data.verification_uri;
	if (
		typeof deviceCode !== "string" ||
		!deviceCode ||
		typeof userCode !== "string" ||
		!userCode ||
		typeof verificationUri !== "string"
	) {
		throw new Error(formatOctoberLoginUnavailable("invalid device-code response fields"));
	}
	for (const uri of [verificationUri, data.verification_uri_complete]) {
		if (uri === undefined) continue;
		let parsed: URL;
		try {
			if (typeof uri !== "string") throw new Error("Invalid URI");
			parsed = new URL(uri);
		} catch {
			throw new Error("Untrusted verification_uri in device code response");
		}
		if (parsed.origin !== octoberAuthBaseUrl() || parsed.username || parsed.password || parsed.hash) {
			throw new Error("Untrusted verification_uri in device code response");
		}
	}
	for (const value of [data.interval, data.expires_in]) {
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
			throw new Error(formatOctoberLoginUnavailable("invalid device-code timing"));
		}
	}
	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		verification_uri_complete: data.verification_uri_complete as string | undefined,
		interval: typeof data.interval === "number" ? data.interval : undefined,
		expires_in: Math.min(
			typeof data.expires_in === "number" ? data.expires_in : DEVICE_LOGIN_MAX_SECONDS,
			DEVICE_LOGIN_MAX_SECONDS,
		),
	};
}

async function pollDeviceToken(device: DeviceCodeResponse, signal: AbortSignal): Promise<string> {
	return pollDeviceCodeFlow<string>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			let response: Response;
			try {
				response = await fetch(deviceTokenUrl(), {
					method: "POST",
					headers: { Accept: "application/json", "Content-Type": "application/json" },
					body: JSON.stringify({ device_code: device.device_code }),
					signal: AbortSignal.any([signal, AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS)]),
					redirect: "error",
				});
			} catch (error) {
				return { status: "failed", message: formatOctoberLoginUnavailable(error) };
			}
			const raw = await readJson(response);
			if (response.ok && isRecord(raw) && typeof raw.access_token === "string") {
				if (!raw.access_token.startsWith(OCTOBER_INFERENCE_TOKEN_PREFIX)) {
					return { status: "failed", message: "October login returned an unexpected token type." };
				}
				return { status: "complete", value: raw.access_token };
			}
			if (isRecord(raw) && typeof raw.error === "string") {
				if (raw.error === "authorization_pending") return { status: "pending" };
				if (raw.error === "slow_down") {
					return {
						status: "slow_down",
						intervalSeconds: typeof raw.interval === "number" ? raw.interval : undefined,
					};
				}
				if (raw.error === "access_denied") {
					return { status: "failed", message: "October login was denied." };
				}
				if (raw.error === "expired_token") {
					return { status: "failed", message: "October login timed out. Run the command again." };
				}
				return { status: "failed", message: `October login failed: ${raw.error}` };
			}
			if (!response.ok) {
				return { status: "failed", message: formatOctoberLoginUnavailable(`HTTP ${response.status}`) };
			}
			return { status: "failed", message: "Invalid October device token response" };
		},
	});
}

export async function runOctoberDeviceCodeLogin(
	callbacks: Pick<OAuthLoginCallbacks, "onDeviceCode" | "signal">,
	options: { openBrowser?: boolean } = {},
): Promise<string> {
	const signal = callbacks.signal ?? new AbortController().signal;
	const device = await requestDeviceCode(signal);
	if (signal.aborted) throw new Error(DEVICE_POLL_CANCEL);
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});
	if (signal.aborted) throw new Error(DEVICE_POLL_CANCEL);
	if (options.openBrowser !== false) openBrowser(device.verification_uri_complete ?? device.verification_uri);
	const deadline = AbortSignal.timeout((device.expires_in ?? DEVICE_LOGIN_MAX_SECONDS) * 1000);
	try {
		return await pollDeviceToken(device, AbortSignal.any([signal, deadline]));
	} catch (error) {
		if (signal.aborted) throw new Error(DEVICE_POLL_CANCEL);
		if (deadline.aborted) throw new Error(DEVICE_POLL_TIMEOUT);
		throw error;
	}
}

export async function revokeOctoberInferenceToken(token: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(`${octoberAuthBaseUrl()}/api/cli/device/revoke`, {
			method: "DELETE",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
			},
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
			redirect: "error",
		});
		return response.ok;
	} catch {
		// Revoke is best-effort; the token is still removed locally.
		return false;
	}
}

export function printOctoberDeviceCode(info: { userCode: string; verificationUri: string }): void {
	console.log(`Open ${info.verificationUri} and enter code: ${info.userCode}`);
	console.log(`Waiting for ${APP_NAME} login approval...`);
}
