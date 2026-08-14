import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { seedOctoberCredential } from "./auth.ts";
import { parseOctoberBusEnv } from "./bus/env.ts";
import { registerOctoberHooks } from "./bus/hooks.ts";
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
	const bus = parseOctoberBusEnv();
	if (!bus) return;
	registerOctoberHooks(pi, bus);
	await registerOctoberBusTools(pi, bus);
}
