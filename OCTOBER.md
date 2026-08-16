# October integration — execution plan

> **Status: execution-ready plan.** This file was rewritten on 2026-08-14 after a full code audit
> of the fork at upstream base 0.84.2 (`b1efcf7d7`). It supersedes the original specification: every
> requirement from that spec is preserved below, but now mapped to verified facts about the
> codebase, concrete files, and ordered phases with acceptance criteria. An executing agent should
> work top to bottom: read §0, then execute Phases 0–7 in order.

This repository is October's fork of [pi](https://github.com/earendil-works/pi) (MIT). It exists so
October can ship a first-party agent: one that carries October's own inference endpoint and joins
the october-bus with **no configuration injected from outside**.

**The design test: if october-desktop has to write a single file to make this work, the design is
wrong.**

`README.md` is upstream's and stays that way. This file is the only October-owned doc at the root.

---

## 0. For the executing agent — read this first

### 0.1 Repo rules you must follow (digest of `AGENTS.md` — read it in full before starting)

- After any code change run **`npm run check`** from the repo root and fix *all* errors, warnings,
  and infos. It does not run tests.
- **Never run the full vitest suite directly** — use `./test.sh` from the repo root for the
  non-e2e suite. For a single test file, from the package root:
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts`
- If you create or modify a test file, run it and iterate until it passes.
- Tests in `packages/coding-agent/test/suite/` must use `test/suite/harness.ts` and the **faux
  provider** — no real provider APIs or keys.
- Code style: Biome (tabs, indent width 3, line width 120), erasable-TS-only (no `enum`,
  `namespace`, parameter properties), **no inline/dynamic imports**, no `any` unless unavoidable,
  no emojis anywhere.
- Never edit `packages/ai/src/models.generated.ts` by hand.
- Git: stage explicit paths only (**never `git add -A` / `git add .`**); never `reset --hard`,
  `checkout .`, `clean -fd`, `stash`, or `--no-verify`. Commit format:
  `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`. Commit at the end of each phase.
  Changelog: add entries under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md` only when
  on `main`.
- Lockfile changes are blocked by the pre-commit hook unless `PI_ALLOW_LOCKFILE_CHANGE=1`. This
  plan requires **no new dependencies** — if you think you need one, stop and reconsider; the
  design below avoids it deliberately.

### 0.2 Setup and baseline (Phase 0)

```sh
npm ci --ignore-scripts
npm run build          # falls back: npm run build:offline (bundled model data, no network)
npm run check
./test.sh              # confirm the suite is green before touching anything
node packages/coding-agent/dist/cli.js --help   # smoke: flags print, exit 0
```

Node `>=22.19.0` required. The binary entry is `packages/coding-agent/dist/cli.js`
(bin name `pi` today; renamed in Phase 6).

### 0.3 Architecture facts this plan is built on (all verified in-tree, 2026-08-14)

1. **Headless one-shot already exists and already has the exact stream discipline the contract
   demands.** `-p`/`--print` (`packages/coding-agent/src/cli/args.ts:143`) plus
   `takeOverStdout()` (`src/core/output-guard.ts:45`) — in print/json/rpc modes *all* diagnostics
   are rerouted to stderr and only `writeRawStdout()` reaches stdout. Final assistant text goes to
   stdout; assistant error/abort → message on stderr, empty stdout, exit 1
   (`src/modes/print-mode.ts:139-161`).
2. **Resume mostly exists.** `--continue` picks the most recent session; `--session <id|prefix|path>`
   opens an exact session; `--session-id <id>` lets the *caller dictate* the id up front
   (creates-if-missing, `src/main.ts:438-450`). `--resume` today is a TUI picker with **no id
   argument**. Session ids are uuidv7, stored as the JSONL header `id` field
   (`src/core/session-manager.ts:208-217, 930-955`).
3. **There is no MCP support anywhere in pi** — by upstream design ("No MCP. …build an extension
   that adds MCP support", `packages/coding-agent/README.md:498`). The bus client must be built on
   the extension seam. Tool names are flat, unvalidated, author-chosen strings — an extension can
   legally register tools named `mcp__october-bus__<rawName>` (`src/core/extensions/loader.ts:264`).
4. **The extension seam is far stronger than the original spec assumed.** In-repo, zero-config,
   always-on extensions exist: `packages/coding-agent/src/extensions/index.ts` exports
   `builtInExtensions: InlineExtension[]` (today: llama.cpp), loaded in **every** mode including
   print/headless, and not disabled by `--no-extensions`. Extensions can register tools, providers,
   CLI flags, slash commands, and subscribe to 33 lifecycle events including `before_agent_start`
   (whose result injects a message into the turn and/or rewrites the system prompt — exactly the
   pre-prompt hook), `session_start`/`session_shutdown`, `agent_start`/`agent_end`, `turn_end`,
   `tool_call` (can block a call). Full reference: `packages/coding-agent/docs/extensions.md`,
   ~90 examples under `packages/coding-agent/examples/extensions/`.
5. **A generic OpenAI-compatible provider mechanism already exists.**
   `pi.registerProvider(name, config)` (`src/core/model-registry.ts:131`) takes baseUrl, apiKey
   (with `$ENV_VAR` interpolation), `api: "openai-completions"`, headers, and a model list, with
   optional `refreshModels`. The in-tree llama.cpp extension
   (`src/extensions/llama/provider.ts`) is the working template: it discovers free-text model ids
   from `/v1/models` at runtime. Users can point the same machinery at any endpoint via
   `~/.pi/agent/models.json` — §4.2's genericity requirement is already satisfied by upstream.
6. **429/backoff is already handled.** `packages/ai/src/utils/provider-retry.ts` retries 408/409/
   429/5xx honoring `retry-after`/`retry-after-ms` headers with exponential backoff + jitter, and a
   second assistant-turn retry layer classifies `rate limit`/`429`/`overloaded` messages as
   retryable (`packages/ai/src/utils/retry.ts`). Defaults: 3 retries, 2s/4s/8s.
7. **There is no permission system at all** — no ask/accept-edits/bypass, no tool-approval prompt.
   (`--approve`/`-a` is *project trust* — whether `.pi/` config loads — not tool permission.) This
   is the one contract row that needs real new behavior (Phase 4).
8. **Branding is centralized.** `APP_NAME`/`APP_TITLE`/`CONFIG_DIR_NAME` derive from
   `piConfig.name`/`piConfig.configDir` in `packages/coding-agent/package.json`
   (`src/config.ts:485-496`); the banner, help text, terminal title, and env-var names all
   interpolate them. A handful of hardcoded `pi` literals remain (inventoried in Phase 6).
   `packages/tui` contains no branding — the original spec's pointer to it was wrong.
9. **Reasoning-model floor**: `options.maxTokens` defaults to `model.maxTokens`
   (`packages/ai/src/api/simple-options.ts:34`). Setting a generous `maxTokens` on the October
   models at registration time is the clean, zero-core-edit insertion point for §4.1(2).

### 0.4 Contract → status map

| # | Capability (unchanged contract) | Status | Where |
|---|---|---|---|
| 1 | Stable binary name on PATH | **Phase 6** — rename `pi` → `octo` | `packages/coding-agent/package.json` |
| 2 | Interactive TUI default | done upstream | `src/main.ts:118-133` |
| 3 | Headless `-p`: answer on stdout, exit 0/1, errors on stderr | done upstream — verify in Phase 7 | `src/modes/print-mode.ts` |
| 4 | `--continue` + `--resume <id>` + learnable id | **Phase 5** — small arg edit + id in `/hook/session` | `src/cli/args.ts`, extension |
| 5 | `--model <id>` | done upstream — verify pass-through in Phase 1 | `src/core/model-resolver.ts` |
| 6 | Permission modes as flags | **Phase 4** — new, extension-implemented | new extension file |
| 7 | Image attach by path | done upstream (`@path`) — document in Phase 7 | `src/cli/file-processor.ts` |
| 8 | Pre-prompt injection | **Phase 3** — `before_agent_start` → `/hook/pre-prompt` | new extension file |
| — | October inference provider | **Phase 1** | new extension file |
| — | Bus MCP tools | **Phase 2** | new extension files |
| — | Lifecycle hooks | **Phase 3** | new extension file |

---

## 1. Phase 1 — October inference provider

**Goal:** with `OCTOBER_INFERENCE_TOKEN` set, `--provider october --model <id>` works end to end
including tool calling; without the token, the provider is registered but unauthenticated (pi
already filters unauthenticated providers out of the picker/`--list-models` snapshot).

### 1.1 Files

Create `packages/coding-agent/src/extensions/october/` (October owns this directory entirely —
maximum rebase safety):

```
october/
  index.ts        # extension factory: default export (pi: ExtensionAPI) => void
  provider.ts     # this phase
  bus/            # Phase 2–3
  permissions.ts  # Phase 4
```

Register in `packages/coding-agent/src/extensions/index.ts` (one-line addition to
`builtInExtensions`, mirroring llama.cpp):

```ts
export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "october", factory: octoberExtension, hidden: true },
];
```

### 1.2 Implementation (`provider.ts`)

Model the code on `src/extensions/llama/provider.ts` and
`examples/extensions/custom-provider-anthropic/`. Use `pi.registerProvider("october", config)` with:

- `baseUrl: "https://www.october.dev/v1"`, overridable via `OCTOBER_INFERENCE_BASE_URL` (useful for
  tests; do not document beyond a code comment).
- `api: "openai-completions"`.
- `apiKey: "$OCTOBER_INFERENCE_TOKEN"` (the config layer resolves `$ENV` syntax; falls back to the
  credential store via the normal `pi auth` flow — §4.3's "environment or existing credential
  store" for free).
- **Models — do not mirror a catalog** (§4.2): provide `refreshModels` that GETs
  `${baseUrl}/models` (OpenAI-compatible list endpoint) with the bearer token and maps each `id`
  verbatim into a model entry. Skip the network call entirely when no token is resolvable. Seed a
  static baseline so the provider works before the first refresh, ordered and labeled honestly per
  §4.1(1):
  - `hetzner/kimi-k2` (exact current id: confirm against the live `/models` response) — first,
    name `"Kimi K2 (recommended: fast, reliable tool calling)"`; make it
    `defaultModelPerProvider`-style first-in-list so bare `--provider october` selects it.
  - GLM and Qwen entries with names suffixed `"(unreliable: timeouts observed)"` /
    `"(slow, intermittent 502s)"`.
- Per-model settings addressing §4.1(2): `reasoning: true`, `maxTokens: 32768` (floor — a small
  value starves the reasoning trace and returns empty content), `contextWindow` from the `/models`
  response when present, else `131072`. `input: ["text"]` unless the endpoint documents vision.
- **Model ids pass through verbatim.** They carry a required `hetzner/` prefix; a bare id is a
  deliberate `400`. Never normalize, strip, or lowercase. ⚠ pi's `--model a/b` syntax infers a
  provider from the segment before the first `/` (`src/core/model-resolver.ts:203-254`) — verify
  that `--provider october --model hetzner/<id>` reaches the wire untouched, and that
  `--model october/hetzner/<id>` resolves (provider `october`, model `hetzner/<id>`). If the
  resolver mangles the latter, document `--provider october --model <id>` as the supported form;
  do not "fix" ids.
- Rate limits (§4.1(3)): the shared limits (~60 req/min, ~4 concurrent) surface as
  `429 concurrency_limit_exceeded`. Upstream's retry layers already back off honoring
  `retry-after`. Add nothing unless Phase 7 verification shows the message is swallowed; if it is,
  the fix belongs in the provider's error text, not a new retry layer.
- Capacity is free and experimental (§4.1(4)): nothing may hard-depend on a specific model id
  existing — which the dynamic `/models` refresh already guarantees.

### 1.3 Tests

`packages/coding-agent/test/october-provider.test.ts` (vitest, offline by default):

- Extension registers provider `october`; with `OCTOBER_INFERENCE_TOKEN` unset, no network call is
  made during refresh (spin a local `http.Server` as base URL and assert zero hits).
- With a token set and the local server stubbing `/models`, refresh upserts the returned ids
  verbatim (including the `hetzner/` prefix — assert no normalization).
- Seeded baseline present before refresh; Kimi model is first.
- A stubbed chat-completions SSE response streams through `streamSimple` (follow the faux-provider
  patterns in `test/suite/`).

### 1.4 Acceptance

- `npm run check` clean; new tests pass; `./test.sh` green.
- `node packages/coding-agent/dist/cli.js --list-models october` shows the October models only
  when a token is set.
- Manual (needs a real token; skip if unavailable and note it in the phase commit message):
  `OCTOBER_INFERENCE_TOKEN=... dist/cli.js --provider october --model hetzner/<kimi-id> -p "run: echo hi"`
  → tool call executes, answer on stdout, exit 0.

---

## 2. Phase 2 — Bus MCP client, environment-driven

**Goal:** with `OCTOBER_BUS_*` set, the agent lists the bus tools as `mcp__october-bus__<rawName>`
and can call them. With them unset: **complete no-op** — no network, no errors, no visible change.

### 2.1 What October exports (unchanged contract)

october-desktop sets these on every agent process it spawns. Read them; never require flags:

```
OCTOBER_BUS_PORT             # bus listener, always on 127.0.0.1
OCTOBER_BUS_CANVAS           # canvas id
OCTOBER_BUS_NODE             # this node's id
OCTOBER_BUS_MCP_CAPABILITY   # per-execution capability, required on identified /mcp calls
OCTOBER_BUS_TOKEN            # process-lifetime token for /hook/* calls
```

Gate at the top of the extension factory: if `OCTOBER_BUS_PORT`/`CANVAS`/`NODE` are not all
present and well-formed, register nothing bus-related and return. This single guard is the §3.4
inertness mechanism — everything below sits behind it.

### 2.2 MCP transport — hand-rolled, no new dependency

pi has no MCP client and the `@modelcontextprotocol/sdk` dependency is not worth the lockfile and
review cost for the subset needed. Implement a minimal Streamable-HTTP MCP client in
`october/bus/mcp-client.ts` (~200 lines) using Node's global `fetch`:

- All calls: `POST http://127.0.0.1:${OCTOBER_BUS_PORT}/mcp` with headers
  `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
  `X-October-Canvas`, `X-October-Node`, `X-October-MCP-Capability` (from the env), and
  `Mcp-Session-Id` once the server issues one (capture it from the `initialize` response header;
  echo it on every subsequent call).
- JSON-RPC 2.0 methods needed, in order: `initialize` (protocolVersion `2025-03-26`, clientInfo
  name `octo`), then notification `notifications/initialized`, then `tools/list` (follow
  `nextCursor` pagination), and `tools/call` per invocation.
- Response bodies may be `application/json` (single JSON-RPC response) **or** `text/event-stream`
  (parse SSE `data:` lines; the response to the request is the event whose `id` matches). Support
  both; do not implement server-initiated streams, subscriptions, or resumability.
- Timeouts: 5s for initialize/tools-list, 120s for tools/call (bus tools include long-running
  browser operations), all via `AbortSignal.timeout` combined with the tool-call's own signal.
- Every failure path returns a normal error to the caller — never throws past the extension
  boundary (§3.4: an unreachable October is a degraded session, not a failed one).

### 2.3 Tool registration (`october/bus/tools.ts`)

- At extension load (bound env only): initialize, `tools/list`, then for each tool
  `pi.registerTool({...})` with:
  - `name: "mcp__october-bus__" + rawName` — same shape Claude Code and Codex use, so prompts and
    transcripts read consistently across harnesses.
  - `label`: the raw name; `description`: verbatim from the server.
  - `parameters: Type.Unsafe(tool.inputSchema)` — TypeBox schemas *are* JSON Schema, so the
    server's `inputSchema` passes through `Type.Unsafe` without conversion. Guard: if
    `inputSchema` is absent, use `Type.Object({})`.
  - `execute`: `tools/call` with the raw name; map result `content` text/image parts to pi's
    `AgentToolResult.content`; map MCP `isError` to a thrown error (pi's convention:
    "Throw on failure instead of encoding errors in `content`").
- If the bus is unreachable at startup: log one line to the debug log
  (`~/.octo/agent/octo-debug.log`), register nothing, continue — the session must work.
- `registerTool` is valid after startup too (`docs/extensions.md:1338`) — if the initial
  `tools/list` fails, retry once in the background after 5s, then give up silently.

### 2.4 Tests

`packages/coding-agent/test/october-bus-mcp.test.ts`:

- **Inertness (the §3.4 test — most important test in the plan):** with env unset, constructing a
  session with the extension performs zero network calls (assert via a local server bound to a
  port passed in `OCTOBER_BUS_PORT`… left unset) and registers zero `mcp__october-bus__*` tools;
  behavior identical to a session without the extension.
- With a stub bus (local `http.Server` implementing initialize/tools/list/tools/call in JSON mode):
  tools appear with the `mcp__october-bus__` prefix; a `tools/call` round-trips arguments and
  result; the capability/canvas/node headers are present on every request; `Mcp-Session-Id` is
  echoed after initialize.
- SSE-mode response parsing round-trips (serve one response as `text/event-stream`).
- Bus down (env set, nothing listening): session still constructs; a registered-then-failing call
  returns a tool error, not a crash.

### 2.5 Acceptance

- Checks/tests green. Manual: run the stub bus from a scratch script, launch the TUI with the env
  set, confirm the tools list in the session and one successful call; then unset env and diff
  `--help`/startup output against a pre-change build — byte-identical.

---

## 3. Phase 3 — Lifecycle hooks

**Goal:** October's canvas presence, idle detection, and mid-session message delivery work.

### 3.1 Transport (`october/bus/hooks.ts`)

Identity is the `OCTOBER_BUS_*` env (`PORT`, `CANVAS`, `NODE`, optional `LAUNCH`/`TOKEN`/`MCP_CAPABILITY`).
Every request sends `X-October-Bus-Token: ${OCTOBER_BUS_TOKEN}` when a token is present. Swallow
every failure.

- `POST http://127.0.0.1:${OCTOBER_BUS_PORT}/hook/session` and `/hook/stop` — JSON body, 3s
  fire-and-forget.
- `GET http://127.0.0.1:${OCTOBER_BUS_PORT}/hook/pre-prompt?canvas&node&launch&agent=october` —
  response is consumed as `text/plain` (5s timeout). This is a **pull**, not a POST.

This matches october-desktop's real bus (`src/main/bus/server.ts` + `hook-auth.ts`): pre-prompt is
GET-only (`HOOK_ROUTES`), records `turn-start`, and returns orientation + unread peers as plain
text. Stop records `turn-end` from `{ canvas, node, excerpt }`.

### 3.2 Hooks emitted — the definitive list

The contract says an unimplemented hook must not be guessed at. This harness emits exactly three.
Every POST body includes `{ canvas, node, agent: "october" }` and `launch` when `OCTOBER_BUS_LAUNCH`
is set (desktop uses launch as the PTY epoch so a restart cannot inherit the prior process's
lifecycle).

| Route | Emitted from | Contract |
|---|---|---|
| `/hook/session` | `pi.on("session_start")` / `pi.on("session_shutdown")` | POST `{ canvas, node, launch?, agent: "october", status: "live"\|"offline", session?, file?, cwd? }`. `session` (not `sessionId`) is the learnable id desktop's `handleHookSession` reads. Start = `status: "live"`; shutdown = `status: "offline"` (no session fields). |
| `/hook/pre-prompt` | `pi.on("before_agent_start")` | **GET** with query `canvas`, `node`, `launch`, `agent=october`. Response is `text/plain`. Non-empty body → return `{ message: { customType: "october-bus", content: [{ type: "text", text }], display: false } }` so orientation + peer inject enter the turn hidden. Empty / 4xx / timeout → no injection, turn continues. Desktop records `turn-start` on this pull (`event` defaults to `pre-prompt`). |
| `/hook/stop` | `pi.on("agent_end")` | POST `{ canvas, node, launch?, agent: "october", excerpt: { cwd, userPrompt, assistantText } }`. Always posted (even if `assistantText` is empty) so desktop can record `turn-end` and flip idle. User prompt truncated 6k, assistant 12k. |

**Not emitted** (October must not wait on them): `/hook/notify` — pi has no "waiting for user
input" event distinct from turn end (nearest signal is `/hook/stop`); if Phase 4's ask-mode
confirm later wants to emit it, add it then and update this table. `/hook/message-peer`,
`/hook/task` — peer messaging and the task board flow through the bus MCP *tools* (Phase 2); the
bus observes those calls server-side, so harness-side emission would duplicate them.

These payload shapes are the contract october-desktop codes against. If they drift, update this
table in the same commit as the hooks.

### 3.3 Tests

Extend the stub bus with the hook routes:

- session live/offline fire with token header, `canvas`/`node`/`launch`/`agent`, and `session` present on live.
- `before_agent_start` → pre-prompt **GET** → stubbed plain-text body lands in the agent's message
  array (assert via the harness transcript), and `display: false` keeps it out of rendering.
- Stop fires after a completed faux-provider turn with `excerpt.assistantText`.
- Pre-prompt returning 500 / timing out / empty text → turn proceeds normally with no injection
  and no user-visible error.
- Inertness rerun: env unset → zero hook traffic.

---

## 4. Phase 4 — Permission modes (contract row 6)

**Goal:** `--permission-mode ask|accept-edits|bypass` as a real flag, so October's launch chooser
and persisted per-harness defaults light up.

pi has no permission system, so this is new behavior — but it fits entirely inside the October
extension via two upstream seams: `pi.registerFlag` (extension CLI flags arrive via
`unknownFlags`, `src/cli/args.ts:213-226`) and the blocking `tool_call` event
(`ToolCallEventResult { block, reason }`, `src/core/extensions/types.ts:1071-1080`).

`october/permissions.ts`:

- `pi.registerFlag("permission-mode", { type: "string", default: "bypass" })`. Also honor a
  `permissionMode` key in settings and `OCTOBER_PERMISSION_MODE` env (flag > env > settings).
  Default **bypass** = upstream behavior, preserving §3.4 outside October.
- Classification: `read`, `grep`, `find`, `ls` are always allowed; `edit`, `write` are "edits";
  `bash` and every other tool (including `mcp__october-bus__*`) are "commands".
- `ask`: every edit and command prompts `ctx.ui.confirm(title, body)` with the tool name and a
  compact argument preview; deny → `{ block: true, reason: "denied by user" }`.
- `accept-edits`: edits auto-approved; commands prompt.
- `bypass`: no gating (do not even subscribe to `tool_call` in this mode).
- Headless (`!ctx.hasUI`): a mode that would prompt instead blocks with
  `reason: "blocked by permission mode <m> in non-interactive mode"` — deterministic, never hangs.
- This flag is deliberately **not** upstream's `--approve/-a` (project trust); do not conflate
  them in help text.

Tests (`test/october-permissions.test.ts`, faux provider harness): each mode × {read, edit, bash}
matrix; headless-ask blocks with the documented reason; bypass leaves no `tool_call` subscription
overhead.

---

## 5. Phase 5 — `--resume <id>` (contract row 4, remaining half)

Upstream `--resume` opens a TUI picker and takes no argument; exact-id resume exists as
`--session <id>`. October's contract wants `--resume <id>`. Smallest possible diff, two files:

- `packages/coding-agent/src/cli/args.ts` (~6 lines): after matching `--resume`/`-r`, if the next
  arg exists and is not a flag and not `@`-prefixed, consume it into `result.resumeId`.
- `packages/coding-agent/src/main.ts` (~4 lines): when `parsed.resumeId` is set, route through the
  existing `--session` resolution path (`resolveSessionSelector`, `src/main.ts:259-285`) instead
  of the picker. Add the same mutual-exclusion errors `--session`/`--session-id` already have.

This is the **only** edit this plan makes inside upstream's CLI logic — keep it that shape.
Bare `--resume` keeps the picker, so the diff is purely additive in behavior.

The other half of row 4 — *learning* the id — is already delivered by `/hook/session` (Phase 3),
and `--session-id <id>` (upstream, undocumented in its docs but in `--help`) even lets October
dictate ids up front. Document both in Phase 7.

Tests: args parsing unit test (`--resume` bare → picker flag; `--resume abc` → resumeId;
`--resume -p` → picker + print); an integration test resuming a real session file by id in print
mode.

---

## 6. Phase 6 — Branding + binary name

**Decision (updated 2026-08-15): the binary is `october`.** Package `@october-dev/october`
(de-clash from upstream `pi` and from taken bare npm names). Config dir `.october`,
agent dir `~/.october/agent`, env prefix `OCTOBER_` (derived automatically).

### 6.1 The one-line rebrand

`packages/coding-agent/package.json`:

```json
"bin": { "october": "dist/cli.js" },
"piConfig": { "name": "october", "configDir": ".october" }
```

`APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `ENV_*` names, the startup logo line, terminal title,
`--help` header, and `/quit` description all follow automatically (`src/config.ts:485-496`).
Side effect to accept knowingly: `isOfficialDistribution()` (`src/cli/startup-ui.ts:25-41`) goes
false, which disables upstream's first-time-setup/telemetry dialog — correct for a fork.
Keep the npm package name unchanged for now; publishing is out of scope.

### 6.2 Hardcoded literals to edit (complete inventory from the audit)

Confined, presentation-only edits — the rebase-friendly kind:

- `src/core/system-prompt.ts:121` — identity line → "…operating inside october, October's coding
  agent (a fork of pi)." Leave the surrounding pi-docs references intact (the docs they point to
  are real and shipped).
- `src/modes/interactive/interactive-mode.ts:961` — onboarding line: replace the double "Pi"
  sentence with an October-neutral one.
- Do **not** touch: `pi.dev` share/catalog URLs (upstream services that still work),
  `PI_*` env vars read by upstream code, `pi-bash` temp prefixes, provider attribution headers,
  easter eggs. Every one is invisible-or-harmless, and each edit is a future merge conflict.

### 6.3 In-TUI October identity (additive, zero upstream edits)

In the October extension: when running interactively, `ctx.ui.setHeader(...)` with a small
October ASCII banner + accent-colored name/version (the built-in header is designed to be
replaced — `interactive-mode.ts:511-520`). Optionally ship `october-dark` /`october-light` theme
JSONs beside the built-ins later; not required for done.

### 6.4 Acceptance

`october --help` shows october-branded help; TUI shows the October header; sessions land under
`~/.october/agent/sessions`; `rg -n '"pi"' packages/coding-agent/package.json` shows no bin named pi.
Run the full `./test.sh` — the config-dir rename is the likeliest thing to break tests; fix
forward.

---

## 7. Phase 7 — Verification matrix, docs, status

### 7.1 Definition of done — execute each line literally, from the built binary

- [x] `october` launches an interactive TUI — binary starts and stays alive (`timeout` exit 124, no crash). This environment has no `tmux`; a PTY spawn produced no framed TUI dump. Header is registered via `ctx.ui.setHeader` in TUI mode.
- [x] Bogus `--model` path: `node dist/cli.js --model definitely-not-a-model -p "say exactly: ok"` → exit 1, empty stdout, stderr `Model "definitely-not-a-model" not found`. Happy-path `-p "say exactly: ok"` **skipped** (no `OCTOBER_INFERENCE_TOKEN` / no default authenticated provider in this environment).
- [x] `--model`, `--continue`, `--resume <id>`, `--session-id <id>`, and `--permission-mode ask|accept-edits|bypass` are present in `october --help` and covered by unit/integration tests. `--resume missing-id-xyz` from the built binary exits 1 with `No session found matching`.
- [x] With `OCTOBER_BUS_*` set (stub bus): tests register `mcp__october-bus__echo` and a `tools/call` round-trips.
- [x] `GET /hook/pre-prompt` pull text lands in the provider message array as a hidden `october-bus` custom message (`display: false`).
- [x] With `OCTOBER_BUS_*` unset: `--help` is byte-identical to a run with env set; inertness tests show zero bus traffic and zero `mcp__october-bus__*` tools.
- [ ] With `OCTOBER_INFERENCE_TOKEN` set: October models work end to end including tool calling
      (manual; **skipped** — token unset)
- [x] A stub `/v1/chat/completions` returning `429` + `concurrency_limit_exceeded` yields `stopReason: error` and an error message containing `429` and `concurrency_limit_exceeded` (no crash). This stub recorded one attempt; existing upstream retry layers were not extended.
- [x] No secret in the repo or its history (`git log -p` matches only docs/code references, no token values)
- [x] §9 status table updated; §7.2 interface section written

### 7.2 Document the verified interface (in this file, not README.md — upstream owns README)

See **Verified interface (october 0.84.2)** below. Verified against `october --help` on 0.84.2
(upstream base 0.84.2 / `b1efcf7d7`).

---

## 8. Staying rebaseable (unchanged, still binding)

- Record the exact upstream base here on every sync (table below).
- Keep the diff small, additive, concentrated. This plan touches upstream files in exactly four
  places (extensions/index.ts registration, args.ts + main.ts for `--resume <id>`, package.json
  branding, two literal strings) — everything else lives in `src/extensions/october/`, which
  October owns entirely.
- Never edit `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`. Keep MIT attribution.
- **Merge, not rebase** — `main` is published; rebasing would force-push over it:

```sh
gh api --method POST repos/october-dev/october-harness/merges \
  -f base=main -f head="$(gh api repos/earendil-works/pi/commits/main --jq .sha)"

gh api repos/october-dev/october-harness/compare/main...earendil-works:pi:main \
  --jq '"upstream_ahead=\(.ahead_by) fork_ahead=\(.behind_by)"'
```

`upstream_ahead=0` means caught up. `gh repo sync` is NOT usable here — its `--force` would
discard October's commits.

### Upstream base

| Merged | Upstream SHA | `@earendil-works/pi-coding-agent` |
|---|---|---|
| 2026-08-14 | `b1efcf7d7c5d7394fbb12ede0174e04d39ee7004` | 0.84.2 |
| 2026-08-17 | `d3ab2af969d64997338253c9151190aa1bc33580` | 0.84.2 |

2026-08-17: caught up 4 upstream commits (xAI → Responses / Grok 4.6 #8124, Copilot login
retry/sequencing, kimi cached-token tracking #8119) via the merge above — conflict-free; the model
catalogue (`src/providers/data/`, gitignored) was regenerated so `tsgo` passes. No October-owned
files touched; all October suites green.

---

## 9. Status

| Area | State |
|---|---|
| Fork created | done |
| Code audit + execution plan | **done** — this document, 2026-08-14 |
| Phase 1: October inference provider | **done** — provider + offline tests; live-token E2E skipped (no `OCTOBER_INFERENCE_TOKEN`) |
| §10: Supabase-session auth (general users) | **done (harness side)** — env-seeded oauth credential + Supabase refresh; inert without `OCTOBER_SUPABASE_*`. Backend/desktop wiring is the checklist in §10 |
| Phase 2: Bus MCP client (env-driven) | **done** — inert when `OCTOBER_BUS_*` unset; JSON + SSE stub coverage |
| Phase 3: Lifecycle hooks (session / pre-prompt / stop) | **done** — desktop contract: `GET /hook/pre-prompt`, `/hook/session` `{status:live\|offline}`, `/hook/stop` `{excerpt}` |
| Phase 4: Permission-mode flags | **done** — ask/accept-edits/bypass; headless modes that would prompt block |
| Phase 5: `--resume <id>` | **done** — bare `--resume` still opens the picker |
| Phase 6: Branding (`october`) | **done** — bin `october`, package `@october-dev/october`, config dir `.october` |
| Phase 7: Verification + interface doc | **done** — live-token E2E skipped; `./test.sh` in this environment failed on missing `git-upload-pack` + a concurrent-session flake (unrelated to October code) |
| Rebase procedure + recorded base | done — synced to upstream 0.84.2 on 2026-08-14 |

Keep this table honest. October's integration decisions are made from it.

---

## Verified interface (october 0.84.2)

Verified against `october --help` on 0.84.2 (upstream base 0.84.2, `b1efcf7d7c5d7394fbb12ede0174e04d39ee7004`). Package `@october-dev/october`.

**Binary name:** `october` (`packages/coding-agent/package.json` `bin.october`). Config dir `.october`. Agent dir `~/.october/agent` (`OCTOBER_CODING_AGENT_DIR`).

**October-relevant flags as printed:**

- `--provider <name>`
- `--model <pattern>` — provider/id and optional `:<thinking>`
- `--print, -p`
- `--continue, -c`
- `--resume, -r [id]` — picker when bare; id/path/prefix when given
- `--session <path|id>`
- `--session-id <id>` — exact project session id, creates if missing
- `--permission-mode <value>` — extension flag: `ask`, `accept-edits`, or `bypass`. Default bypass. Not `--approve`.

**Resume contract:** `--continue` opens the most recent session. `--resume <id>` uses the same resolver as `--session`. `--session-id <id>` creates-if-missing. Session id is delivered to October on `/hook/session` as `session` (desktop `handleHookSession` field).

**Image attach:** `october -p @screenshot.png "what is this?"` (help example: `october @prompt.md @image.png "What color is the sky?"`).

**Hooks emitted:** `POST /hook/session` (`status: live` / `offline`), `GET /hook/pre-prompt` (query pull → `text/plain`), `POST /hook/stop` (`excerpt`). **Not emitted:** `/hook/notify`, `/hook/message-peer`, `/hook/task`.

**Model ids:** pass through verbatim, including the `hetzner/` prefix and any further slashes (e.g. `hetzner/Qwen/Qwen3.6-35B-A3B-FP8` — only the first segment is the provider namespace). Supported forms: `--provider october --model hetzner/<id>` and `--model october/hetzner/<id>` (both resolve to provider `october`; multi-slash ids verified in tests). Seed catalog (real ids from the gateway handover): `hetzner/Kimi-K2.7-Code` first (images), then `hetzner/Qwen/Qwen3.6-35B-A3B-FP8` (reasoning); the full catalogue is fetched live from `/v1/models`.

**Idle signal:** `/hook/stop` is always posted on `agent_end` (even with an empty excerpt) so october-desktop can record `turn-end`. Desktop does not read a `willRetry` field.

**Manual skip:** no `OCTOBER_INFERENCE_TOKEN` in this environment; live October inference + tool-calling E2E was not run.

---

## 10. Making it usable for general users: October inference auth + rollout

The point: a general user installs the October app, signs in once (as they already must to use the
app), and octo's October models just work — no key paste, no `/login`, no config file. This section
is the contract that makes that true and the checklist of what October (backend + desktop) must wire.

### 10.1 Auth model — the signed-in user's Supabase session, refreshed in-harness

octo runs **inside the October app**, where the user is already authenticated (Supabase). So the
harness never runs its own login flow: October-desktop injects the user's Supabase session into the
agent process the same way it already injects `OCTOBER_BUS_*`, and octo forwards the access token to
the inference gateway and refreshes it autonomously for long sessions.

Implemented on pi's OAuth provider seam (`packages/coding-agent/src/extensions/october/auth.ts`):

- **Env October-desktop injects** (all required together; absent → the whole path is inert, so octo
  outside the app is exactly upstream pi):

  ```
  OCTOBER_SUPABASE_URL           # e.g. https://<project>.supabase.co
  OCTOBER_SUPABASE_ANON_KEY      # the project's anon/publishable key (public; used only to refresh)
  OCTOBER_SUPABASE_ACCESS_TOKEN  # the signed-in user's current access token (JWT) — the gateway bearer
  OCTOBER_SUPABASE_REFRESH_TOKEN # used to rotate the access token when it nears expiry
  OCTOBER_SUPABASE_EXPIRES_AT    # optional epoch seconds; if absent, octo reads the JWT `exp` claim
  ```

- **Seeding** (`seedOctoberCredential`, run once at extension load): imports the injected session into
  pi's credential store (`~/.octo/agent/auth.json`, mode 0600) as an `oauth` credential
  `{ type:"oauth", access, refresh, expires, supabaseUrl, supabaseAnonKey }`, race-safe under the
  store lock, idempotent, and it never overwrites a stored session that is already fresher. No-op and
  never throws when the env is absent.
- **Per-request auth**: `getApiKey(cred)` returns `cred.access`; pi sends it as `Authorization:
  Bearer <jwt>` to `https://www.october.dev/v1`. When the token is within pi's ~5-minute expiry
  window, pi calls `refreshToken` **once, under the per-provider store lock**, and persists the
  rotated session — so a multi-hour terminal session never dies on a 1-hour JWT.
- **Refresh** (`refreshToken`): `POST ${supabaseUrl}/auth/v1/token?grant_type=refresh_token` with
  header `apikey: <anon>` and body `{ refresh_token }`, mapping the response back to the credential.
  The Supabase URL + anon key are stored on the credential (and fall back to env), so refresh works
  even for a `/login october`-imported session.
- **Fallback**: the static `OCTOBER_INFERENCE_TOKEN` bearer still works (tests / non-app use). With
  neither a Supabase session nor that token, the provider is unauthenticated and pi filters it out of
  the picker — no dead options.

> **✅ Confirmed by the gateway handover (`OCTOBER_HARNESS_HANDOVER.md`).** The gateway validates the
> **Supabase session JWT directly** as `Authorization: Bearer …` — no server change needed for the
> harness. It also accepts a long-lived `oct_inf_…` inference token on the same header for clients
> outside October, which is exactly what the `OCTOBER_INFERENCE_TOKEN` fallback carries. Both resolve
> to the same October user id and share one usage/limit bucket.

### 10.2 What October must do for it all to work — checklist

**Backend / gateway (October-owned):**
- [ ] Confirm the gateway at `https://www.october.dev/v1` accepts the user's Supabase **access-token
      JWT** as `Authorization: Bearer …` (or tell me it wants an exchange — see the ⚠ above).
- [ ] Confirm the OpenAI-compatible surface: `GET /models` (bearer-auth) for the live catalog, and
      `POST /chat/completions` streaming with tool-calling for the `hetzner/*` models.
- [ ] Confirm the real model ids (the seed list `hetzner/kimi-k2`, `hetzner/glm-4.7`,
      `hetzner/qwen3-coder` is a placeholder) and per-user rate/capacity limits.
- [ ] Decide what a signed-in user is entitled to (all `hetzner/*`? metered?). No harness change
      either way — it's whatever the gateway authorizes for that JWT.

**October-desktop (the spawner):**
- [ ] Inject the five `OCTOBER_SUPABASE_*` env vars (§10.1) into every agent process, exactly as it
      already injects `OCTOBER_BUS_*`. Keep the access token reasonably fresh at spawn; octo handles
      in-session refresh from there.
- [ ] Pass `--model october/hetzner/<id>` (or your chosen default) on the spawn command for chat
      nodes so a fresh user gets an October model with zero picking. (octo already registers the
      provider; this just preselects it. It's a spawn arg, not a written file — the design test holds.)
- [ ] Provide the Supabase **anon** key only (never the service-role key) — it is public by design.

**Distribution (pick per §10.3):**
- [ ] Build and ship the binary/package; bundle it with the October app.

### 10.3 Distribution options (recommendation: bundle the prebuilt binary)

The install story depends on audience. Since the primary consumer is the October app itself:

- **Recommended — prebuilt binary bundled by the app.** `scripts/build-binaries.sh` already produces
  self-contained Bun executables for all six OS/arch targets (no Node needed). The app ships the
  matching binary and spawns it. Two small polish items: the built binary/archive is still named
  `pi`/`pi-<platform>.tar.gz` (rename to `octo` in `build-binaries.sh`), and the release workflow
  references upstream infra (R2 `pi-artifacts`, `pi.dev`) that a fork run would need pointed at
  October's own or trimmed to just the artifact build.
- **npm global install** (`npm i -g @october/...`): broadest for developers, but requires renaming all
  nine `@earendil-works/pi-*` packages to an October-owned scope, creating the npm org, and updating
  the shrinkwrap/install-lock generators (`internalPackagePrefix`). Bigger lift; only worth it if you
  want a public `npm i -g` story. OCTOBER.md §6.1 currently freezes the npm identity — revisit here if
  you choose this.
- **Both**: the release workflow already does binaries + npm in one tagged run; the rename work above
  is the prerequisite.

### 10.4 Status of §10

| Piece | State |
|---|---|
| Harness: Supabase-session provider auth + refresh + seeding | **done** — `october/auth.ts`, 7 offline tests, inert without `OCTOBER_SUPABASE_*` |
| Gateway JWT-bearer contract | **confirmed** by the handover (§10.1 ✅) |
| Real model ids + metadata | **done** — seed `hetzner/Kimi-K2.7-Code` (images) + `hetzner/Qwen/Qwen3.6-35B-A3B-FP8` (reasoning); ctx 128000, maxTokens 32000, cost 0; catalogue fetched live; unknown ids exposed with defaults |
| October-desktop env injection + `--model` at spawn | **not started** (October-desktop repo) |
| Binary/package rebrand + release infra repointing | **not started** — see §10.3 |
| Live end-to-end with a real signed-in session | **not run** — no Supabase project/session in this environment |

### 10.5 Reconciliation with the gateway handover, and what it still asks the harness to do

The handover confirms the auth model and the fetch-don't-hardcode catalogue (both done), and adds
requirements that are **not yet in the harness**. Some need a decision; some need pi-core work:

- **Token delivery — decision (handover §3, §11.2).** The current harness reads the session from
  `OCTOBER_SUPABASE_*` at spawn and refreshes it *itself* against Supabase. The handover's
  **recommended** shape is different: October-desktop exposes a **loopback token endpoint** (it owns
  the session in Electron `safeStorage` and already refreshes it), and the harness fetches the current
  token per request / on `401 invalid_api_key`. That is cleaner (no refresh token or anon key in the
  agent env; desktop owns refresh) and is the natural fit for the existing October bus. Recommend
  switching the token source to a bus route once October-desktop defines it; keep an `oct_inf_` static
  token as the headless/CI fallback (handover §3(c)).
- **401 must branch on `error.code`, not status (handover §2.1, §8).** `invalid_api_key` → refresh +
  retry once; `upstream_authentication_error` → surface as a service fault, do **not** refresh/retry;
  `503 service_unavailable` → back off, do **not** sign out. pi refreshes proactively on the expiry
  window but has no refresh-on-401 hook today — this needs a small pi-core seam or a `streamSimple`
  wrapper.
- **Client-side concurrency semaphore of ~4 (handover §7).** Parallel subagents will exhaust the
  4-concurrent limit instantly. Queue rather than fire; honour `Retry-After` on `429`. pi-core
  dispatch concern.
- **Reasoning-token floor ~256 on harness-internal requests (handover §6).** Title/summary/tool-repair
  requests with a tiny budget return empty content on these reasoning models. pi's internal min-output
  needs a floor for this provider.
- **Abort on cancel (handover §5).** The HTTP request must actually `AbortController.abort()` on
  cancel to free a concurrency slot. pi aborts requests on cancel today — verify it holds for this
  provider under live conditions.
- **Do-not-build, already honoured:** no auto-retry of generations (but note pi-core's generic retry
  layer may retry a mid-stream 5xx — verify/limit for this provider), no silent provider fallback, no
  hardcoded catalogue, ids passed verbatim, credential only ever in `Authorization`.
- **Model curation (handover §11.4):** GLM times out and Qwen is slow; the seed leads with Kimi and
  the catalogue is fetched live, so weak models surface but Kimi is the default.
