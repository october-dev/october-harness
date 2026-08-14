import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerOctoberProvider } from "./provider.ts";

export default function octoberExtension(pi: ExtensionAPI): void {
	registerOctoberProvider(pi);
}
