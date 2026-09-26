import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	/** Raw `pi.capabilities` value, validated by the extension loader (see extensions/capabilities.ts). */
	capabilities?: unknown;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

/** The `pi` fields that list package resources. */
export type PiResourceField = (typeof RESOURCE_FIELDS)[number];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the manifest lists resources; otherwise the package uses the conventional directories. */
export function hasResourceEntries(manifest: PiManifest): boolean {
	return RESOURCE_FIELDS.some((field) => manifest[field] !== undefined);
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.pi[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		if (pkg.pi.capabilities !== undefined) {
			manifest.capabilities = pkg.pi.capabilities;
		}
		return manifest;
	} catch {
		return null;
	}
}
