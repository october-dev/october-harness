import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { parseOctoberBusEnv } from "./bus/env.ts";
import { registerOctoberBusTools } from "./bus/tools.ts";
import { registerOctoberProvider } from "./provider.ts";

export default async function octoberExtension(pi: ExtensionAPI): Promise<void> {
	registerOctoberProvider(pi);
	const bus = parseOctoberBusEnv();
	if (!bus) return;
	await registerOctoberBusTools(pi, bus);
}
