import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripBom } from "../../utils/text.ts";

/**
 * Extension capability manifests (#7).
 *
 * A manifest declares the host capabilities an extension expects before its code is loaded, so the
 * harness can disclose them and reject malformed declarations. It is disclosure metadata only: it is
 * not an operating-system sandbox and does not prove what the extension actually does.
 */

export const CAPABILITY_MANIFEST_VERSION = 1;

export type FilesystemScope = "none" | "project" | "any";

export interface CapabilityManifest {
	manifestVersion: 1;
	filesystem?: { read?: FilesystemScope; write?: FilesystemScope };
	shell?: boolean;
	network?: string[];
	environment?: string[];
	credentials?: string[];
	octoberBus?: boolean;
}

export type CapabilityDisclosure =
	| { status: "declared"; manifest: CapabilityManifest; source: string }
	| { status: "unclassified" }
	| { status: "invalid"; source: string; errors: string[] };

const FILESYSTEM_SCOPES: readonly FilesystemScope[] = ["none", "project", "any"];
const TOP_LEVEL_FIELDS = new Set([
	"manifestVersion",
	"filesystem",
	"shell",
	"network",
	"environment",
	"credentials",
	"octoberBus",
]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_NAME =
	/^(?:\*|(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?)$/;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringList(
	value: unknown,
	field: string,
	pattern: RegExp | undefined,
	errors: string[],
): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
		errors.push(`${field}: must be an array of non-empty strings`);
		return undefined;
	}
	if (new Set(value).size !== value.length) errors.push(`${field}: contains duplicate entries`);
	if (pattern) {
		for (const entry of value) {
			if (!pattern.test(entry)) errors.push(`${field}: invalid entry ${JSON.stringify(entry)}`);
		}
	}
	return value;
}

/** Validate a parsed manifest. Returns the typed manifest or every problem found, each as `field: message`. */
export function validateCapabilityManifest(
	value: unknown,
): { manifest: CapabilityManifest; errors?: undefined } | { manifest?: undefined; errors: string[] } {
	const errors: string[] = [];
	if (!isObject(value)) return { errors: ["manifest: must be an object"] };
	for (const key of Object.keys(value)) {
		if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`${key}: unknown field`);
	}
	if (value.manifestVersion !== CAPABILITY_MANIFEST_VERSION) {
		errors.push(
			`manifestVersion: must be ${CAPABILITY_MANIFEST_VERSION}, got ${JSON.stringify(value.manifestVersion ?? null)}`,
		);
	}
	const manifest: CapabilityManifest = { manifestVersion: 1 };
	if (value.filesystem !== undefined) {
		if (!isObject(value.filesystem)) {
			errors.push("filesystem: must be an object");
		} else {
			const filesystem: { read?: FilesystemScope; write?: FilesystemScope } = {};
			for (const key of Object.keys(value.filesystem)) {
				if (key !== "read" && key !== "write") {
					errors.push(`filesystem.${key}: unknown field`);
					continue;
				}
				const scope = value.filesystem[key];
				if (typeof scope !== "string" || !FILESYSTEM_SCOPES.includes(scope as FilesystemScope)) {
					errors.push(`filesystem.${key}: must be one of ${FILESYSTEM_SCOPES.join(", ")}`);
					continue;
				}
				filesystem[key] = scope as FilesystemScope;
			}
			manifest.filesystem = filesystem;
		}
	}
	for (const field of ["shell", "octoberBus"] as const) {
		if (value[field] === undefined) continue;
		if (typeof value[field] !== "boolean") errors.push(`${field}: must be a boolean`);
		else manifest[field] = value[field];
	}
	const lists = [
		["network", HOST_NAME],
		["environment", ENVIRONMENT_NAME],
		["credentials", undefined],
	] as const;
	for (const [field, pattern] of lists) {
		if (value[field] === undefined) continue;
		const list = validateStringList(value[field], field, pattern, errors);
		if (list) manifest[field] = list;
	}
	return errors.length > 0 ? { errors } : { manifest };
}

function readJson(filePath: string): { value: unknown } | { error: string } {
	try {
		return { value: JSON.parse(stripBom(readFileSync(filePath, "utf-8"))) };
	} catch (error) {
		return { error: `manifest: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})` };
	}
}

function isWithin(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find the package that owns an extension entry: the nearest package.json whose `pi.extensions` lists the
 * entry (or a directory containing it), or whose directory directly contains the entry. A package.json that
 * merely sits above an unrelated single-file extension does not apply.
 */
function findOwningPackageJson(
	entryPath: string,
): { packageJsonPath: string; pi: Record<string, unknown> } | undefined {
	let dir = path.dirname(entryPath);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			const parsed = readJson(packageJsonPath);
			if (!("value" in parsed) || !isObject(parsed.value) || !isObject(parsed.value.pi)) return undefined;
			const pi = parsed.value.pi;
			const listed =
				Array.isArray(pi.extensions) &&
				pi.extensions.some((entry) => typeof entry === "string" && isWithin(entryPath, path.resolve(dir, entry)));
			return listed || path.dirname(entryPath) === dir ? { packageJsonPath, pi } : undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The sidecar manifest path for an entry file: `name.ts` → `name.capabilities.json`. */
export function getSidecarManifestPath(entryPath: string): string {
	const extension = path.extname(entryPath);
	return `${entryPath.slice(0, entryPath.length - extension.length)}.capabilities.json`;
}

/** Read an extension's capability manifest without executing any extension code. */
export function readCapabilityManifest(entryPath: string): CapabilityDisclosure {
	const sidecarPath = getSidecarManifestPath(entryPath);
	const owningPackage = findOwningPackageJson(entryPath);
	const packageDeclared = owningPackage?.pi.capabilities !== undefined;
	const sidecarDeclared = existsSync(sidecarPath);
	if (packageDeclared && sidecarDeclared) {
		return {
			status: "invalid",
			source: sidecarPath,
			errors: [`manifest: declared in both ${owningPackage.packageJsonPath} (pi.capabilities) and ${sidecarPath}`],
		};
	}
	let source: string;
	let value: unknown;
	if (packageDeclared) {
		source = `${owningPackage.packageJsonPath}#pi.capabilities`;
		value = owningPackage.pi.capabilities;
	} else if (sidecarDeclared) {
		source = sidecarPath;
		const parsed = readJson(sidecarPath);
		if ("error" in parsed) return { status: "invalid", source, errors: [parsed.error] };
		value = parsed.value;
	} else {
		return { status: "unclassified" };
	}
	const result = validateCapabilityManifest(value);
	return result.errors
		? { status: "invalid", source, errors: result.errors }
		: { status: "declared", manifest: result.manifest, source };
}

function describeList(label: string, values: string[] | undefined): string {
	if (values === undefined) return `${label}: not declared`;
	return values.length === 0 ? `${label}: none` : `${label}: ${values.join(", ")}`;
}

function describeFlag(label: string, value: boolean | undefined, yes: string, no: string): string {
	return value === undefined ? `${label}: not declared` : `${label}: ${value ? yes : no}`;
}

/**
 * Concise, UI-independent disclosure lines for one extension. Fields the manifest omits are shown as
 * "not declared" rather than as "none", because omission is not a promise.
 */
export function formatCapabilitySummary(disclosure: CapabilityDisclosure): string[] {
	if (disclosure.status === "unclassified") {
		return ["Unclassified: no capability manifest. It may use any capability the host allows."];
	}
	if (disclosure.status === "invalid") {
		return [`Invalid capability manifest (${disclosure.source}):`, ...disclosure.errors.map((error) => `  ${error}`)];
	}
	const { manifest } = disclosure;
	const read = manifest.filesystem?.read ?? "not declared";
	const write = manifest.filesystem?.write ?? "not declared";
	return [
		`Filesystem: read ${read}, write ${write}`,
		describeFlag("Shell", manifest.shell, "runs commands", "no"),
		describeList("Network", manifest.network),
		describeList("Environment", manifest.environment),
		describeList("Credentials", manifest.credentials),
		describeFlag("October Bus", manifest.octoberBus, "uses the Bus", "no"),
		"Declared by the extension author; this is disclosure, not a sandbox.",
	];
}
