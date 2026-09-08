import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { AuthSelectorProvider } from "../../modes/interactive/components/oauth-selector.ts";

export const LOGIN_MENU_TITLE = "Connect a provider";
export const LOGIN_MENU_OPTIONS = ["October account", "Another provider account", "API key"];

/** Use the same provider methods and credential status in shell and interactive login. */
export function getLoginProviderOptions(
	runtime: ModelRuntime,
	authType?: AuthSelectorProvider["authType"],
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of runtime.getProviders()) {
		const authStatus = runtime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({ id: provider.id, name: provider.name, authType: "oauth", method: provider.auth.oauth, status });
		}
		if ((!authType || authType === "api_key") && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}
