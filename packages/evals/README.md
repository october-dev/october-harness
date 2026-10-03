# Pi evals

Behavioral evals for Pi's coding agent, built with `vitest-evals`.

## File conventions

Eval definitions are flat under `evals/`:

- `*.docs.eval.ts` is a documentation-lift eval. `eval:docs` runs each case in isolated `without_docs` and `with_docs` containers and reports lift.
- Other `*.eval.ts` files are host evals. `eval:host` runs them with Vitest on this machine. They are ordinary vitest-evals suites, not paired comparisons.

Runner code lives in `src/`:

- `cli.ts` orchestrates a comparison
- `docker.ts` builds the two images, discovers cases, and runs one isolated arm
- `plan.ts` expands cases into `(case, variant, repetition)` tasks
- `report.ts` reads Vitest JSON, pairs arms, and computes lift
- `harness.ts` is the vitest-evals adapter
- `scenario.ts`, `scenario-runner.ts`, `scenario-checks.ts`, `scenario-report.ts`, and `scenario-cli.ts` run deterministic scenarios (see [Scenario evals](#scenario-evals))

Eval suites and their fixtures live under `evals/`. Deterministic scenarios live under `scenarios/`. Image build files live in `docker/`.

## Scenario evals

Scenario evals check harness behavior without credentials or network. Each run replays a scripted faux model against a copy of a fixture workspace, then scores the end state. The runner imports built packages, so build once after `npm ci`:

```bash
npm run build
npm run eval:scenarios -w packages/evals
```

The command prints a Markdown summary and writes `scenarios.json` and `summary.md` under `.eval/`. It exits nonzero if any scenario fails, and a scenario that cannot load or run is reported as a failure instead of stopping the others.

During a run, tools see only a minimal environment (`PATH`, the temporary home, locale and temp directories), so a scenario cannot read provider keys or other host secrets. Scenarios run one at a time because each run changes the process environment. Pass `--scenarios <dir>` (repeatable) to run other packs instead of the bundled one, `--filter <text>` to select by path, and `--out <dir>` to choose the report directory.

### Run against a real model

The same scenarios run against any configured model. The `faux` script is ignored, the checks are unchanged, and cost is reported when the model is priced:

```bash
npm run eval:scenarios -w packages/evals -- --provider anthropic --model claude-sonnet-5
```

**A real-model run executes the commands the model chooses, on this machine.** The workspace is a temporary copy and provider keys are hidden from tools, but `bash` and other tools still run on the host with your user's permissions. Run real-model evals only with models and scenario packs you trust, or inside a container.

Credentials come from the host's stored login or environment, as for other evals, and are resolved before the run starts. Add `--record <dir>` to save each run's assistant messages as a new scenario pack with the same prompt, fixture and checks. Compaction summaries are recorded in place, so a run that compacts still replays in order. A compaction that makes two summary requests (a split turn with earlier history) is recorded as one step and will not replay exactly. The recorded pack then replays with no credentials:

```bash
npm run eval:scenarios -w packages/evals -- --provider anthropic --model claude-sonnet-5 --record recorded/
npm run eval:scenarios -w packages/evals -- --scenarios recorded/
```

### Scenario packs

A pack is any directory tree of scenarios. Extensions and providers can keep a pack next to their code, for example `my-extension/scenarios/`, and run it with `--scenarios my-extension/scenarios`. Use a pack-specific prefix in scenario ids (`my-extension/...`) so reports from several packs don't collide.

A scenario is a directory with `scenario.json` and an optional `workspace/` fixture:

```json
{
	"formatVersion": 1,
	"id": "core/command-failure-recovery",
	"prompt": "Build the project so dist/out.txt exists.",
	"tools": ["bash"],
	"faux": [
		{ "toolCall": { "name": "bash", "args": { "command": "node scripts/missing-build.js" } } },
		{ "toolCall": { "name": "bash", "args": { "command": "node scripts/build.js" } } },
		{ "text": "Built dist/out.txt after retrying." }
	],
	"expect": [
		{ "file": "dist/out.txt", "contains": "ok" },
		{ "toolCalls": { "name": "bash", "min": 2, "errors": 1 } }
	]
}
```

- `faux` is the scripted model: each step is one model response, either `text`, a `toolCall`, or `toolCalls` with optional `text`. A compaction summary is a model request too, so it takes the next step. A run that stops before using every step is reported as an error.
- `expect` lists the checks. `file` checks `exists`, `contains`, `notContains`, or a `matches` regex; `command` runs in the final workspace and checks `exitCode` and `outputContains`; `toolCalls` checks counts and errors, optionally for one tool; `finalText` checks the last assistant text; `maxTurns` bounds the turns; `compactions` bounds completed compactions (a failed or aborted one always fails the check); `busCall` requires a call to a fake Bus tool whose listed `arguments` match, optionally an exact `count`. Each check takes an optional `weight` (default 1).

Optional fields set up the run:

| Field | Effect |
| --- | --- |
| `model` | `contextWindow` and `maxTokens` for the faux model, to create context pressure. Ignored for a real model. |
| `compaction` | Enables threshold compaction with `reserveTokens` and `keepRecentTokens`. Compaction is off otherwise. |
| `permissionMode` | Loads the October permission gate in `ask`, `accept-edits`, or `bypass`. A headless run blocks whatever the mode would prompt for, as a tool error. |
| `bus` | Serves `tools` from an in-process fake October Bus through the real Bus tools, as `mcp__october-bus__<name>`. Each tool returns its `result` text; every call is recorded for `busCall` checks. |

The bundled `core/` pack covers editing, command-failure recovery, context pressure, permission denial, and Bus response correlation.
- The score is the weighted share of passing checks. A scenario passes when every check passes and the run had no errors.
- Faux usage is estimated, so cost is reported as `n/a`.

Unknown fields are rejected, so a typo fails loading instead of silently skipping a check.

## Run evals

Host evals (smoke, documentation audit) and documentation-lift evals need `PI_PROVIDER` and `PI_MODEL`.

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval -w packages/evals
```

That runs host evals, then the documentation comparison. Extra CLI flags after `--` go to `eval:docs` only.

Host only:

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval:host -w packages/evals
```

One host suite:

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol \
  npm run eval:host -w packages/evals -- evals/documentation-audit.eval.ts
```

## Run documentation comparisons

From the repository root:

```bash
npm run eval:docs -w packages/evals -- \
  --provider openai-codex \
  --model gpt-5.6-sol
```

`PI_PROVIDER` and `PI_MODEL` provide the same defaults. Both values are required.

The default is one run per variant. Increase repetitions explicitly when measuring stability:

```bash
npm run eval:docs -w packages/evals -- \
  evals/extensions.docs.eval.ts \
  --runs-per-variant 5
```

`PI_EVAL_RUNS_PER_VARIANT=5` is equivalent. Vitest filters are applied during discovery:

```bash
npm run eval:docs -w packages/evals -- -t "adds the model"
```

The runner:

1. Mounts the repository ephemerally for a Docker build, packs the current workspace packages using the repository's consumer-install machinery, then creates separate `without_docs` and `with_docs` images from the staged runtime.
2. Discovers the selected cases in both images and requires identical cohorts.
3. Plans every `(case, variant, model, runNumber)` arm before execution.
4. Runs each arm in a fresh container. A failed or missing arm is recorded and the planned cohort continues.
5. Reads native Vitest JSON through `@vitest-evals/core/node` when a report exists.
6. Pairs exact arms and writes the comparison report. Blocked pairs withhold headline lift; the process exits nonzero.

Repetition order alternates by run number to reduce order bias.

## Documentation variants

`without_docs` omits the coding-agent `README.md`, `CHANGELOG.md`, `docs/`, and `examples/`, then removes the Pi documentation-routing section from the default system prompt.

`with_docs` includes those files and uses the unchanged default prompt.

Both variants install the same local workspace tarballs. Existing npm overrides ensure coding-agent's internal Pi dependencies also come from the current repository rather than the registry. Documentation and source files from internal dependency packages are removed symmetrically so they cannot act as alternate instructions. Startup validates the image allowlist and verifies that the installed coding-agent package resolves from `dist/`. Eval definitions, evaluator helpers, fixtures, and Vitest configuration are root-owned and unreadable after the harness permanently drops to an unprivileged UID. Each run receives a new home, agent directory, workspace, session directory, and container filesystem.

Documentation evals allow only `read`, `write`, `edit`, `grep`, `find`, and `ls` by default. They do not expose shell or web-search tools. Provider traffic still requires container network access, so Docker alone cannot prove that arbitrary code written by an agent never uses the network.

## Results

Each invocation creates an ignored `.eval/<timestamp>_<id>/` directory containing:

- `protocol.json`: model, image IDs, cases, tasks, and protocol digest.
- `expected-runs.json`: the complete planned cohort.
- `observations.jsonl`: normalized outcomes and telemetry.
- `tasks/*/vitest.json`: native JSON for each isolated arm.
- `<variant>/sessions/*/session.jsonl`: native Pi sessions.
- `report.json` and `report.txt`: paired comparisons.

A pair contributes to pass-rate lift only when both arms produce exactly one score. Missing, duplicate, skipped, pending, unscored, or errored arms block the pair. If any pair in an eval set is blocked, headline pass rates are withheld. Missing telemetry remains unavailable rather than being treated as zero.

The report flags no lift, negative deltas, saturated controls or treatments, and observed flakiness. One repetition cannot establish stability.

Artifacts may contain prompts, responses, generated code, and tool output.

## Write an eval

Use one ordinary `describeEval(...)` suite and one explicit `run(...)` call per case:

```ts
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const harness = createPiDocumentationEvalHarness();
const judge = StructuredOutputJudge({ expected: { ok: true }, match: "strict", allowExtras: false });

describeEval("Target workflow", { harness, judges: [judge], judgeThreshold: null }, (it) => {
  it("completes the task", async ({ run }) => {
    await run("Complete the target task.");
  });
});
```

The outer runner owns variants, repetitions, isolation, identity, persistence, and reporting. Eval files should contain only scenario setup, the model task, and deterministic grading.

Use `judgeThreshold: null` for comparative scoring. A low score is data, not an infrastructure failure. Reserve Vitest assertions for broken suite invariants.
