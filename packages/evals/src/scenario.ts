import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

/**
 * Scenario format for deterministic harness evals (#15).
 *
 * A scenario is a directory with `scenario.json` and a `workspace/` fixture. The `faux` script is the
 * default model, so a scenario runs with no credentials or network; `expect` scores the final state
 * without an LLM judge.
 */

export const SCENARIO_FORMAT_VERSION = 1;

const Weight = Type.Optional(Type.Number({ exclusiveMinimum: 0 }));

const ToolCallSchema = Type.Object(
	{ name: Type.String({ minLength: 1 }), args: Type.Record(Type.String(), Type.Unknown()) },
	{ additionalProperties: false },
);

/** One assistant message: text, one tool call, or several tool calls with optional text (as recorded). */
const FauxStepSchema = Type.Union([
	Type.Object({ text: Type.String() }, { additionalProperties: false }),
	Type.Object({ toolCall: ToolCallSchema }, { additionalProperties: false }),
	Type.Object(
		{ text: Type.Optional(Type.String()), toolCalls: Type.Array(ToolCallSchema, { minItems: 1 }) },
		{ additionalProperties: false },
	),
]);

const CheckSchema = Type.Union([
	Type.Object(
		{
			file: Type.String({ minLength: 1 }),
			exists: Type.Optional(Type.Boolean()),
			contains: Type.Optional(Type.String()),
			notContains: Type.Optional(Type.String()),
			matches: Type.Optional(Type.String()),
			weight: Weight,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			command: Type.String({ minLength: 1 }),
			exitCode: Type.Optional(Type.Integer()),
			outputContains: Type.Optional(Type.String()),
			weight: Weight,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			toolCalls: Type.Object(
				{
					name: Type.Optional(Type.String({ minLength: 1 })),
					min: Type.Optional(Type.Integer({ minimum: 0 })),
					max: Type.Optional(Type.Integer({ minimum: 0 })),
					errors: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
			weight: Weight,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ finalText: Type.Object({ contains: Type.String() }, { additionalProperties: false }), weight: Weight },
		{ additionalProperties: false },
	),
	Type.Object({ maxTurns: Type.Integer({ minimum: 1 }), weight: Weight }, { additionalProperties: false }),
	Type.Object(
		{
			compactions: Type.Object(
				{ min: Type.Optional(Type.Integer({ minimum: 0 })), max: Type.Optional(Type.Integer({ minimum: 0 })) },
				{ additionalProperties: false },
			),
			weight: Weight,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			busCall: Type.Object(
				{
					name: Type.String({ minLength: 1 }),
					/** Every listed argument must equal the call's value; other arguments are ignored. */
					arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
					count: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
			weight: Weight,
		},
		{ additionalProperties: false },
	),
]);

const ScenarioSchema = Type.Object(
	{
		formatVersion: Type.Literal(SCENARIO_FORMAT_VERSION),
		id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$" }),
		description: Type.Optional(Type.String()),
		prompt: Type.String({ minLength: 1 }),
		tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		/** Faux model limits, for context-pressure scenarios. Ignored when a real model runs. */
		model: Type.Optional(
			Type.Object(
				{
					contextWindow: Type.Optional(Type.Integer({ minimum: 1000 })),
					maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		/** Enables threshold compaction with these limits. Compaction is off otherwise. */
		compaction: Type.Optional(
			Type.Object(
				{ reserveTokens: Type.Integer({ minimum: 0 }), keepRecentTokens: Type.Integer({ minimum: 0 }) },
				{ additionalProperties: false },
			),
		),
		/** Runs the October permission gate in this mode. A headless run blocks what the mode would prompt for. */
		permissionMode: Type.Optional(Type.Enum(["ask", "accept-edits", "bypass"])),
		/** Serves these tools from an in-process fake October Bus, exposed as `mcp__october-bus__<name>`. */
		bus: Type.Optional(
			Type.Object(
				{
					tools: Type.Array(
						Type.Object(
							{
								name: Type.String({ minLength: 1 }),
								description: Type.Optional(Type.String()),
								result: Type.Optional(Type.String()),
							},
							{ additionalProperties: false },
						),
						{ minItems: 1 },
					),
				},
				{ additionalProperties: false },
			),
		),
		faux: Type.Array(FauxStepSchema, { minItems: 1 }),
		expect: Type.Array(CheckSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
const checkScenario = Compile(ScenarioSchema);

export type Scenario = Static<typeof ScenarioSchema>;
export type ScenarioCheck = Static<typeof CheckSchema>;
export type FauxStep = Static<typeof FauxStepSchema>;

export type LoadedScenario = Scenario & {
	/** Directory holding `scenario.json`. */
	directory: string;
	/** Fixture copied into a fresh temp workspace for each run; absent means an empty workspace. */
	workspaceDirectory: string | undefined;
};

/** Load and validate one scenario directory. Throws with every schema problem, one per line. */
export async function loadScenario(directory: string): Promise<LoadedScenario> {
	const file = join(directory, "scenario.json");
	const value: unknown = JSON.parse(await readFile(file, "utf8"));
	if (!checkScenario.Check(value)) {
		const problems = checkScenario
			.Errors(value)
			.map((error) => `  ${error.instancePath || "/"}: ${error.message}`)
			.join("\n");
		throw new Error(`Invalid scenario ${file}:\n${problems}`);
	}
	const workspace = join(directory, "workspace");
	return {
		...value,
		directory: resolve(directory),
		workspaceDirectory: existsSync(workspace) ? resolve(workspace) : undefined,
	};
}

/**
 * Write `scenario` with `faux` replaced by `steps` under `root/<id>/`, copying its workspace fixture, so a
 * recorded real-model run can be replayed deterministically. Returns the new scenario directory.
 */
export async function writeRecordedScenario(
	scenario: LoadedScenario,
	steps: FauxStep[],
	root: string,
): Promise<string> {
	const directory = join(resolve(root), ...scenario.id.split("/"));
	await mkdir(directory, { recursive: true });
	const { directory: _source, workspaceDirectory, ...definition } = scenario;
	const recorded: Scenario = { ...definition, faux: steps };
	await writeFile(join(directory, "scenario.json"), `${JSON.stringify(recorded, null, "\t")}\n`);
	if (workspaceDirectory) await cp(workspaceDirectory, join(directory, "workspace"), { recursive: true });
	return directory;
}

/**
 * SHA-256 identities of what a scenario run depends on, so two reports can tell whether they ran the
 * same scenario. `script` is the faux model; it matters only when comparing faux runs.
 */
export type ScenarioFingerprint = {
	/** Prompt, tools, model limits, compaction, permission mode and Bus tools. */
	definition: string;
	/** The `expect` checks, in order. */
	checks: string;
	/** The `faux` steps. */
	script: string;
	/** Every file under `workspace/` (path and content), or null when the scenario has no fixture. */
	workspace: string | null;
};

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted at every level, so formatting and key order never change a hash. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

async function hashTree(root: string): Promise<string> {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else files.push(path);
		}
	};
	await visit(root);
	const hash = createHash("sha256");
	// Forward slashes, sorted, so the same fixture hashes identically on every platform.
	const entries = files.map((file) => ({ file, key: relative(root, file).split(sep).join("/") }));
	entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	for (const { file, key } of entries) {
		hash.update(`${key}\0`);
		hash.update(sha256(await readFile(file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function fingerprintScenario(scenario: LoadedScenario): Promise<ScenarioFingerprint> {
	const {
		directory: _directory,
		workspaceDirectory,
		description: _description,
		faux,
		expect,
		...definition
	} = scenario;
	return {
		definition: sha256(canonicalJson(definition)),
		checks: sha256(canonicalJson(expect)),
		script: sha256(canonicalJson(faux)),
		workspace: workspaceDirectory ? await hashTree(workspaceDirectory) : null,
	};
}

/** Find every scenario directory (one containing `scenario.json`) under `root`, sorted by path. */
export async function discoverScenarios(root: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		if (existsSync(join(directory, "scenario.json"))) {
			found.push(directory);
			return;
		}
		for (const entry of await readdir(directory)) {
			// Skip dependencies, reports, and other hidden directories such as `.eval`.
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const child = join(directory, entry);
			if ((await stat(child)).isDirectory()) await visit(child);
		}
	};
	await visit(resolve(root));
	return found.sort();
}
