import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
