/** Type-only compatibility entry point for coding-agent extension OAuth declarations. */

export type { OAuthDeviceCodePollResult } from "./auth/oauth/device-code.ts";
export { pollOAuthDeviceCodeFlow } from "./auth/oauth/device-code.ts";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
