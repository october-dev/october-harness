import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { parseOctoberBusEnv } from "./bus/env.ts";
import { registerOctoberHooks } from "./bus/hooks.ts";
import { registerOctoberBusTools } from "./bus/tools.ts";
import { registerOctoberPermissions } from "./permissions.ts";
import { registerOctoberProvider } from "./provider.ts";

export default async function octoberExtension(pi: ExtensionAPI): Promise<void> {
	registerOctoberProvider(pi);
	registerOctoberPermissions(pi);
	const bus = parseOctoberBusEnv();
	if (!bus) return;
	registerOctoberHooks(pi, bus);
	await registerOctoberBusTools(pi, bus);
}
