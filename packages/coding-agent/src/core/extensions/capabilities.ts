import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripBom } from "../../utils/text.ts";
import { readPiManifest } from "../pi-manifest.ts";

/**
 * Extension capability manifests (#7).
 *
 * A manifest declares the host capabilities an extension expects before its code is loaded, so the
 * harness can reject malformed declarations. It is disclosure metadata only: it is not an operating-system
 * sandbox and does not prove what the extension actually does.
 */

const HOST_NAME =
	"^(?:\\*|(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\\d{1,5})?)$";
const ENVIRONMENT_NAME = "^[A-Za-z_][A-Za-z0-9_]*$";

const FilesystemScopeSchema = Type.Enum(["none", "project", "any"]);

const CapabilityManifestSchema = Type.Object(
	{
		manifestVersion: Type.Literal(1),
		filesystem: Type.Optional(
			Type.Object(
				{ read: Type.Optional(FilesystemScopeSchema), write: Type.Optional(FilesystemScopeSchema) },
				{ additionalProperties: false },
			),
		),
		shell: Type.Optional(Type.Boolean()),
		network: Type.Optional(Type.Array(Type.String({ pattern: HOST_NAME }), { uniqueItems: true })),
		environment: Type.Optional(Type.Array(Type.String({ pattern: ENVIRONMENT_NAME }), { uniqueItems: true })),
		credentials: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
		octoberBus: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const checkCapabilityManifest = Compile(CapabilityManifestSchema);

export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;

export type CapabilityDisclosure =
	| { status: "declared"; manifest: CapabilityManifest; source: string }
	| { status: "unclassified" }
	| { status: "invalid"; source: string; errors: string[] };

function valueAt(root: unknown, pointer: string): unknown {
	let value = root;
	for (const segment of pointer.split("/").slice(1)) {
		value = (value as Record<string, unknown> | undefined)?.[segment];
	}
	return value;
}

/** One `field: message` line per problem, naming fields with dotted paths. */
function formatErrors(value: unknown, errors: TLocalizedValidationError[]): string[] {
	const lines = errors.flatMap((error): string[] => {
		const field = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
		const params = error.params as Record<string, unknown>;
		switch (error.keyword) {
			case "boolean":
				// A rejected additional property; reported by its "additionalProperties" error.
				return [];
			case "additionalProperties":
				return ((params.additionalProperties as string[]) ?? []).map(
					(key) => `${field ? `${field}.` : ""}${key}: unknown field`,
				);
			case "required":
				return ((params.requiredProperties as string[]) ?? []).map((key) => `${key}: is required`);
			case "const":
				return [`${field}: must be ${JSON.stringify(params.allowedValue)}`];
			case "enum":
				return [`${field}: must be one of ${(params.allowedValues as string[]).join(", ")}`];
			case "pattern":
				return [`${field}: invalid entry ${JSON.stringify(valueAt(value, error.instancePath))}`];
			default:
				return [`${field || "manifest"}: ${error.message}`];
		}
	});
	return [...new Set(lines)];
}

/** Validate a parsed manifest. Returns the typed manifest or every problem found, each as `field: message`. */
export function validateCapabilityManifest(
	value: unknown,
): { manifest: CapabilityManifest; errors?: undefined } | { manifest?: undefined; errors: string[] } {
	if (checkCapabilityManifest.Check(value)) return { manifest: value };
	return { errors: formatErrors(value, checkCapabilityManifest.Errors(value)) };
}

function isWithin(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find the package that owns an extension entry: the nearest package.json with a `pi` field whose
 * `pi.extensions` lists the entry (or a directory containing it), or, without `pi.extensions`, whose
 * conventional `extensions/` directory contains it. An entry directly in the package root also belongs to
 * it. A package.json that merely sits above an unrelated single-file extension does not apply.
 */
function findOwningPackage(entryPath: string): { packageJsonPath: string; capabilities: unknown } | undefined {
	let dir = path.dirname(entryPath);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			const manifest = readPiManifest(packageJsonPath);
			if (!manifest) return undefined;
			const roots = manifest.extensions?.map((entry) => path.resolve(dir, entry)) ?? [path.join(dir, "extensions")];
			const owned = path.dirname(entryPath) === dir || roots.some((root) => isWithin(entryPath, root));
			return owned ? { packageJsonPath, capabilities: manifest.capabilities } : undefined;
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
	const owningPackage = findOwningPackage(entryPath);
	const packageDeclared = owningPackage?.capabilities !== undefined;
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
		value = owningPackage.capabilities;
	} else if (sidecarDeclared) {
		source = sidecarPath;
		try {
			value = JSON.parse(stripBom(readFileSync(sidecarPath, "utf-8")));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { status: "invalid", source, errors: [`manifest: cannot be read as JSON (${reason})`] };
		}
	} else {
		return { status: "unclassified" };
	}
	const result = validateCapabilityManifest(value);
	return result.errors
		? { status: "invalid", source, errors: result.errors }
		: { status: "declared", manifest: result.manifest, source };
}
