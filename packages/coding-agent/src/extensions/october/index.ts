import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerOctoberDesktopAuth, seedOctoberCredential } from "./auth.ts";
import { parseOctoberBusEnv } from "./bus/env.ts";
import { registerOctoberHooks } from "./bus/hooks.ts";
import { registerOctoberPublicBus } from "./bus/public.ts";
import { registerOctoberBusTools } from "./bus/tools.ts";
import { registerOctoberHeader } from "./header.ts";
import { registerOctoberPermissions } from "./permissions.ts";
import { registerOctoberProvider } from "./provider.ts";

export default async function octoberExtension(pi: ExtensionAPI): Promise<void> {
	registerOctoberProvider(pi);
	registerOctoberPermissions(pi);
	registerOctoberHeader(pi);
	// Import the signed-in user's October session (if the app injected one) so inference is zero-config.
	await seedOctoberCredential();
	registerOctoberDesktopAuth(pi);
	const bus = parseOctoberBusEnv();
	if (!bus) return;
	if (bus.transport === "desktop") registerOctoberHooks(pi, bus);
	else registerOctoberPublicBus(pi, bus);
	await registerOctoberBusTools(pi, bus);
}
