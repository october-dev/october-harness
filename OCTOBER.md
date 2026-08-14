# October integration spec

> **Status: specification, not description.** Nothing in this document is implemented yet. Every
> checklist item below is unchecked on purpose. Do not read this as a description of how the fork
> behaves today — read it as the contract it has to satisfy.

This repository is October's fork of [pi](https://github.com/earendil-works/pi) (MIT). It exists so
October can ship a first-party agent: one that carries October's own inference endpoint and joins
the october-bus with **no configuration injected from outside**.

`README.md` is upstream's and stays that way. This file is the only October-owned doc at the root.

---

## 1. Why a fork, and what that costs

October integrates a dozen third-party harnesses. Every one of them needs configuration written in
from outside at launch:

| Harness | How October has to configure it |
|---|---|
| Kimi | October writes a per-node MCP config file and passes it by path |
| DeepSeek | October writes a `--patch` overlay that inserts an MCP row into its plugin tree |
| Goose | October runs a managed stdio bridge process |
| Claude Code / Codex | Hook scripts + repo-local config files |

None of them emit October's full lifecycle. **Because October owns this harness, it can be the
first perfect citizen**: it reads its own binding out of the environment and configures itself.

**The design test: if october-desktop has to write a single file to make this work, the design is
wrong.**

The cost of a fork is a permanent rebase against a fast-moving upstream (pi ships constantly, with
several active maintainers). That cost is only bearable if the diff stays small — see §7.

---

## 2. The integration contract

This is what october-desktop consumes. Each row lights up a specific feature; a missing row means
that feature is silently unavailable.

| # | Capability | What October does with it |
|---|---|---|
| 1 | A stable binary name on `PATH` — pick one and freeze it | Installation probe + foreground-process detection (October identifies a running agent by process name) |
| 2 | Interactive TUI as the default invocation | Terminal nodes on the canvas |
| 3 | **Headless one-shot**: `<bin> -p "<task>"` → final assistant text on **stdout**, exit `0` on success and non-zero on failure, with errors on **stderr** and stdout left empty | Chat nodes. Without this the harness can only ever be a terminal |
| 4 | Resume: `--continue` (most recent) **and** `--resume <id>` (exact), plus a way for October to *learn* the id — print it on start, or include it in the session hook payload | Restoring a session after the app restarts |
| 5 | `--model <id>` | The per-chat model picker |
| 6 | Permission modes as flags: ask / accept-edits / bypass-all | The launch chooser and persisted per-harness defaults |
| 7 | Image attach by file path, with documented syntax | Paste-an-image into a terminal |
| 8 | A pre-prompt injection point (§3.3) | Delivering October's one-shot orientation block and peer messages mid-session |

**Do both #2 and #3.** October currently has one harness that is chat-only (no TUI) and one that is
terminal-only (no headless mode); each is half-integrated as a result. This one should be neither.

On #3, the exact stream discipline matters more than it looks: October reads stdout as the answer
and falls back to stderr for the error message. A harness that prints diagnostics to stdout on
failure produces a "successful" turn containing an error message.

---

## 3. October bus — pre-wired, environment-driven

### 3.1 What October already exports

october-desktop sets these on every agent process it spawns. Read them; do not require flags.

```
OCTOBER_BUS_PORT             # bus listener, always on 127.0.0.1
OCTOBER_BUS_CANVAS           # canvas id
OCTOBER_BUS_NODE             # this node's id
OCTOBER_BUS_MCP_CAPABILITY   # per-execution capability, required on identified /mcp calls
OCTOBER_BUS_TOKEN            # process-lifetime token for /hook/* calls
```

### 3.2 MCP transport

Streamable HTTP, **not** stdio:

```
http://127.0.0.1:${OCTOBER_BUS_PORT}/mcp

X-October-Canvas:         ${OCTOBER_BUS_CANVAS}
X-October-Node:           ${OCTOBER_BUS_NODE}
X-October-MCP-Capability: ${OCTOBER_BUS_MCP_CAPABILITY}
```

Register the discovered tools under a server-qualified namespace — `mcp__october-bus__<rawName>` —
which is the same shape Claude Code and Codex use, so prompts and transcripts read consistently
across harnesses.

### 3.3 Lifecycle hooks

`POST` to `http://127.0.0.1:${OCTOBER_BUS_PORT}<route>` with header
`X-October-Bus-Token: ${OCTOBER_BUS_TOKEN}`.

| Route | When | Why October cares |
|---|---|---|
| `/hook/session` | session start / end | Presence on the canvas; session capture for resume |
| `/hook/pre-prompt` | immediately before a turn | **The highest-value hook.** Its response carries text to inject — this is how a peer's message and October's orientation block reach the model mid-session |
| `/hook/stop` | turn end | Turn summary; drives "is this agent idle?" |
| `/hook/notify` | the agent needs user input | Attention badge + OS notification |
| `/hook/message-peer` | agent-to-agent message | Multi-agent coordination |
| `/hook/task` | task-board update | The shared plan/checklist |

Silence is meaningful to October only for hooks a harness actually implements, so **document
exactly which ones you emit** — an unimplemented hook must not be guessed at.

### 3.4 Inert when unbound — non-negotiable

If the `OCTOBER_BUS_*` variables are absent, every path above must be a **complete no-op**: no
network calls, no errors, no behavior change, nothing on screen. Someone who installs this harness
and runs it outside October must get upstream pi's behavior exactly.

Swallow every bus failure. A bus problem must never break a coding session — an unreachable
October is a degraded session, not a failed one.

---

## 4. October inference provider

Built in and selectable by name, with no user configuration required.

- **Base URL** `https://www.october.dev/v1` — **OpenAI-compatible** (chat-completions shape).
- **Auth**: bearer token read from `OCTOBER_INFERENCE_TOKEN`.
- **Model ids are opaque and must pass through verbatim.** They carry a required `hetzner/`
  prefix; a bare id is a deliberate `400`, not a bug. Never normalize, strip, or lowercase them.

### 4.1 Four things that will otherwise cost a day

1. **Default to the Kimi coding model.** In testing it was the only one consistently fast with
   reliable tool calling. GLM timed out on both test runs; Qwen is slower and intermittently
   returns `502`. If you expose the others, label their reliability honestly rather than
   presenting four equal-looking options.
2. **These are reasoning models.** A small `max_tokens` is spent entirely on the reasoning trace
   and returns empty content — which looks exactly like a broken integration. Set a sane floor and
   surface the setting.
3. **Shared rate limits** (~60 requests/min, ~4 concurrent) mean
   `429 concurrency_limit_exceeded` is a normal condition, not an exception. Back off and surface
   it as a clear message. Cancelling a run frees its slot immediately.
4. **Capacity is free and experimental.** It can change or disappear. Do not build anything that
   assumes a specific model id keeps existing.

### 4.2 Keep the mechanism generic

Implement this as *one instance of* a general OpenAI-compatible provider: base URL + key + free-text
model ids. A user must be able to point the same machinery at any other compatible endpoint.

October deliberately does **not** mirror anyone's model catalog — catalog ids rot, and a stale
mirror produces dead options in a picker. Model ids stay user-supplied text.

### 4.3 Never commit a token

No token in source, tests, fixtures, README examples, or commit messages. Read from the
environment or from the harness's existing credential store.

---

## 5. Where this work goes

Anchors in the current tree:

| Area | Package |
|---|---|
| Provider / model registry, OpenAI-compatible transport | `packages/ai/src` — see `model-catalog.ts`, `models-store.ts`, `env-api-keys.ts`, `api/`, `compat/` |
| Agent loop, tool calling — where bus MCP tools and lifecycle emission attach | `packages/agent` |
| CLI entry, flags, headless vs interactive modes, config | `packages/coding-agent/src` — `cli.ts`, `config.ts`, `modes/`, `core/` |
| Extension seam (October already ships a pi extension through this) | `packages/coding-agent/src/extensions` |
| TUI chrome — banner, header, colors | `packages/tui` |

Prefer adding files over editing existing ones wherever the seam allows. If the extension API can
express the bus client and the provider registration, use it — an additive extension survives a
rebase; an edit to the agent loop does not.

---

## 6. Branding

In-TUI identity is the reason this is a fork rather than a wrapper package — a wrapper can only
decorate *around* the process, and a banner printed before launch is wiped the moment the TUI
enters the alternate screen buffer.

In scope: startup banner / ASCII art, header, `/help` text, colors, binary name.

Keep every one of these confined to presentation files. Branding is the most rebase-friendly kind
of diff there is, as long as it stays out of the loop.

---

## 7. Staying rebaseable

The fork is only worth its cost if upstream keeps flowing in.

- **Record the exact upstream base** (commit SHA and version) here, and update it on every rebase.
- Keep the diff **small, additive, and concentrated**. A file October owns entirely is free to
  maintain; a fifty-line change scattered through upstream's agent loop is a merge conflict every
  release.
- Add a rebase script or a documented procedure, and run it regularly rather than in one painful
  batch. A fork that skips six months of upstream is a snapshot, not a fork.
- Never edit `README.md`, `LICENSE`, `CONTRIBUTING.md`, or `SECURITY.md` — upstream owns those.
  Keep MIT attribution intact.

**Upstream base: _(record SHA + version here on first rebase)_**

---

## 8. Definition of done

- [ ] `<bin>` launches an interactive TUI
- [ ] `<bin> -p "<task>"` prints one answer to stdout and exits `0`; failures exit non-zero with
      the message on stderr and stdout empty
- [ ] `--model`, `--continue`, `--resume <id>`, and the permission-mode flags all work
- [ ] With `OCTOBER_BUS_*` set: the agent lists October's bus tools and can successfully call one
- [ ] `/hook/pre-prompt` injects returned text into the turn
- [ ] With `OCTOBER_BUS_*` **unset**: behavior is identical to upstream pi — no calls, no errors,
      no visible difference
- [ ] With `OCTOBER_INFERENCE_TOKEN` set: October models work end to end, including tool calling
- [ ] A `429` from the endpoint produces a clear message, not a crash
- [ ] No secret appears anywhere in the repository or its history
- [ ] This file's status table (§9) is updated, and the README section below is written

### README section to add when the above is true

Document, precisely and from the installed binary rather than from intent: the binary name, every
flag, the resume contract, image-attach syntax, permission flags, which lifecycle hooks are emitted
(and which are not), and the exact upstream base version.

October's own capability registry records evidence per harness and treats anything unverified as
unsupported, so "verified against `<bin> --help` on version X" is worth more there than a
description of what was intended.

---

## 9. Status

| Area | State |
|---|---|
| Fork created | done |
| October inference provider | not started |
| Bus MCP client (env-driven) | not started |
| Lifecycle hooks | not started |
| Headless one-shot mode | not started (verify what upstream already offers first) |
| Resume + session-id exposure | not started (verify upstream) |
| Branding | not started |
| Rebase procedure + recorded base | not started |

Keep this table honest. October's integration decisions are made from it.
