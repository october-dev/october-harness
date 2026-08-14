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

`POST http://127.0.0.1:${OCTOBER_BUS_PORT}<route>` with `X-October-Bus-Token:
${OCTOBER_BUS_TOKEN}` and JSON body. Fire-and-forget with a 3s timeout **except** `/hook/pre-prompt`
(response is consumed; 5s timeout). Swallow every failure. Same env gate as Phase 2.

### 3.2 Hooks emitted — the definitive list

The contract says an unimplemented hook must not be guessed at. This harness emits exactly three:

| Route | Emitted from | Payload |
|---|---|---|
| `/hook/session` | `pi.on("session_start")` / `pi.on("session_shutdown")` | `{ "event": "start"\|"end", "sessionId", "sessionFile", "cwd", "reason" }` — reason is pi's (`startup\|reload\|new\|resume\|fork` / `quit\|reload\|new\|resume\|fork`). **Carrying `sessionId` here is contract row 4's "way for October to learn the id."** |
| `/hook/pre-prompt` | `pi.on("before_agent_start")` | Request `{ "sessionId", "prompt" }`. Response `{ "inject": "<text>" \| null }` — when non-empty, return `{ message: { customType: "october-bus", content: [{ type: "text", text }], display: false } }` from the handler so the text enters the turn as a custom message. This is how October's orientation block and peer messages reach the model. |
| `/hook/stop` | `pi.on("agent_end")` | `{ "sessionId", "summary": "<last assistant text, truncated 2000 chars>", "willRetry" }` — drives "is this agent idle?". |

**Not emitted** (October must not wait on them): `/hook/notify` — pi has no "waiting for user
input" event distinct from turn end (nearest signal is `/hook/stop`); if Phase 4's ask-mode
confirm later wants to emit it, add it then and update this table. `/hook/message-peer`,
`/hook/task` — peer messaging and the task board flow through the bus MCP *tools* (Phase 2); the
bus observes those calls server-side, so harness-side emission would duplicate them.

These payload shapes are the contract october-desktop codes against. If october-desktop already
expects different field names, fixing the mismatch is october-desktop's job to communicate — this
table is the source of truth and must be updated with whatever is actually shipped.

### 3.3 Tests

Extend the stub bus with the hook routes:

- session start/end fire with correct token header, sessionId present.
- `before_agent_start` → pre-prompt POST → stubbed `inject` text lands in the agent's message
  array (assert via the harness transcript), and `display: false` keeps it out of rendering.
- Stop fires after a completed faux-provider turn.
- Pre-prompt endpoint returning 500 / timing out / returning garbage JSON → turn proceeds
  normally with no injection and no user-visible error.
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

**Decision (frozen once shipped, October probes processes by this name): the binary is `octo`.**
Short, typable, and distinct from any `october` desktop-app process name. Config dir `.octo`,
agent dir `~/.octo/agent`, env prefix `OCTO_` (derived automatically).

### 6.1 The one-line rebrand

`packages/coding-agent/package.json`:

```json
"bin": { "octo": "dist/cli.js" },
"piConfig": { "name": "octo", "configDir": ".octo" }
```

`APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `ENV_*` names, the startup logo line, terminal title,
`--help` header, and `/quit` description all follow automatically (`src/config.ts:485-496`).
Side effect to accept knowingly: `isOfficialDistribution()` (`src/cli/startup-ui.ts:25-41`) goes
false, which disables upstream's first-time-setup/telemetry dialog — correct for a fork.
Keep the npm package name unchanged for now; publishing is out of scope.

### 6.2 Hardcoded literals to edit (complete inventory from the audit)

Confined, presentation-only edits — the rebase-friendly kind:

- `src/core/system-prompt.ts:121` — identity line → "…operating inside octo, October's coding
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

`octo --help` shows octo-branded help; TUI shows the October header; sessions land under
`~/.octo/agent/sessions`; `rg -n '"pi"' packages/coding-agent/package.json` shows no bin named pi.
Run the full `./test.sh` — the config-dir rename is the likeliest thing to break tests; fix
forward.

---

## 7. Phase 7 — Verification matrix, docs, status

### 7.1 Definition of done — execute each line literally, from the built binary

- [ ] `octo` launches an interactive TUI
- [ ] `octo -p "say exactly: ok"` → prints answer to stdout, exit 0; with a bogus
      `--model` → non-zero exit, message on stderr, `stdout` empty (verify with
      `1>/dev/null` / `2>/dev/null` splits)
- [ ] `--model`, `--continue`, `--resume <id>`, `--session-id <id>`, and
      `--permission-mode ask|accept-edits|bypass` all work
- [ ] With `OCTOBER_BUS_*` set (stub bus): the agent lists `mcp__october-bus__*` tools and a call
      succeeds
- [ ] `/hook/pre-prompt` inject text demonstrably reaches the model (ask the model to repeat it)
- [ ] With `OCTOBER_BUS_*` unset: startup output, `--help`, and a full `-p` turn are identical to
      a build without the October extension; a packet capture / stub server shows zero traffic
- [ ] With `OCTOBER_INFERENCE_TOKEN` set: October models work end to end including tool calling
      (manual; requires real token)
- [ ] A `429` produces backoff and, on exhaustion, a clear stderr message naming the rate limit —
      not a crash (stub server returning 429 + `retry-after`)
- [ ] No secret in the repo or its history (`git log -p | rg -i 'october_inference|bearer'` finds
      only docs/code references, no values)
- [ ] §9 status table updated; §7.2 interface section written

### 7.2 Document the verified interface (in this file, not README.md — upstream owns README)

Append a section "Verified interface (octo <version>)" recording, **from the installed binary's
actual output**: the binary name; every October-relevant flag as printed by `octo --help`; the
resume contract (`--continue`, `--resume <id>`, `--session-id <id>`, id delivery via
`/hook/session`); image-attach syntax (`octo -p @screenshot.png "what is this?"`); the exact three
hooks emitted and the ones that are not; the upstream base version. October's capability registry
treats anything unverified as unsupported — "verified against `octo --help` on 0.84.2-october.1"
is the format that counts.

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

---

## 9. Status

| Area | State |
|---|---|
| Fork created | done |
| Code audit + execution plan | **done** — this document, 2026-08-14 |
| Phase 1: October inference provider | **done** — provider + offline tests; live-token E2E skipped (no `OCTOBER_INFERENCE_TOKEN`) |
| Phase 2: Bus MCP client (env-driven) | not started |
| Phase 3: Lifecycle hooks (session / pre-prompt / stop) | not started |
| Phase 4: Permission-mode flags | not started |
| Phase 5: `--resume <id>` | not started |
| Phase 6: Branding (`octo`) | not started |
| Phase 7: Verification + interface doc | not started |
| Rebase procedure + recorded base | done — synced to upstream 0.84.2 on 2026-08-14 |

Keep this table honest. October's integration decisions are made from it.
