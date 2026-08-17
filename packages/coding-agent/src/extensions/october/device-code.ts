import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { pollOAuthDeviceCodeFlow } from "@earendil-works/pi-ai/oauth";
import { APP_NAME } from "../../config.ts";

export const DEFAULT_OCTOBER_AUTH_BASE_URL = "https://www.october.dev";
export const OCTOBER_DEVICE_CODE_PATH = "/api/cli/device/code";
export const OCTOBER_DEVICE_TOKEN_PATH = "/api/cli/device/token";
export const OCTOBER_INFERENCE_TOKEN_PREFIX = "oct_inf_";

export const OCTOBER_LOGIN_UNAVAILABLE_MESSAGE =
	`October login is not available yet (could not reach the device-code endpoint). ` +
	`Sign in via the October app, or set OCTOBER_INFERENCE_TOKEN.`;

function isLoopbackUrl(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.toLowerCase();
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/** Production auth origin, or a loopback test override. */
export function octoberAuthBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OCTOBER_AUTH_BASE_URL?.trim();
	if (override && override.length > 0 && isLoopbackUrl(override)) {
		return override.replace(/\/$/, "");
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
	const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
	return `${OCTOBER_LOGIN_UNAVAILABLE_MESSAGE}${detail}`;
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
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
			signal,
		});
	} catch (error) {
		throw new Error(formatOctoberLoginUnavailable(error));
	}
	if (response.status === 404 || response.status === 501) {
		throw new Error(formatOctoberLoginUnavailable(`HTTP ${response.status}`));
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
	if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
		throw new Error(formatOctoberLoginUnavailable("invalid device-code response fields"));
	}
	let parsedUri: URL;
	try {
		parsedUri = new URL(verificationUri);
	} catch {
		throw new Error("Untrusted verification_uri in device code response");
	}
	if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in device code response");
	}
	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: parsedUri.href,
		interval: typeof data.interval === "number" ? data.interval : undefined,
		expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
	};
}

async function pollDeviceToken(device: DeviceCodeResponse, signal: AbortSignal): Promise<string> {
	return pollOAuthDeviceCodeFlow<string>({
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
					signal,
				});
			} catch (error) {
				return { status: "failed", message: formatOctoberLoginUnavailable(error) };
			}
			const raw = await readJson(response);
			if (isRecord(raw) && typeof raw.access_token === "string") {
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
): Promise<string> {
	const signal = callbacks.signal ?? new AbortController().signal;
	const device = await requestDeviceCode(signal);
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});
	return pollDeviceToken(device, signal);
}

export async function revokeOctoberInferenceToken(token: string, signal?: AbortSignal): Promise<void> {
	try {
		await fetch(`${octoberAuthBaseUrl()}/api/inference-tokens`, {
			method: "DELETE",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
			},
			signal: signal ?? AbortSignal.timeout(5000),
		});
	} catch {
		// Revoke is best-effort; the token is still removed locally.
	}
}

export function printOctoberDeviceCode(info: { userCode: string; verificationUri: string }): void {
	console.log(`Open ${info.verificationUri} and enter code: ${info.userCode}`);
	console.log(`Waiting for ${APP_NAME} login approval...`);
}
