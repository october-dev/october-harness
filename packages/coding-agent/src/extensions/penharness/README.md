# PenHarness (native october capability)

A white-hat security hunt harness, built in as a native october capability. It ports
[PenHarness](https://github.com/harshsaver/penharness) — originally an
[opencode](https://opencode.ai)-based harness driven by a Python `fleet.py` and an opencode plugin —
onto october's own extension seams, so a user triggers a fleet-scaled hunt with `/hunt` from a stock
october: no opencode, no Python, no separate setup.

> Authorized white-hat use only. The methodology enforces a Red list (no other-tenant data, no cloud
> metadata credentials, no DoS-adjacent probing, no bulk enumeration, no publishing/vendor contact
> without the user's say-so) and a politeness budget. A hunt does no active probing of a target until
> the user fills in `scope.md` with authorized targets.

## Trigger it

| Command | What it does |
|---|---|
| `/hunt <target>` | Scaffold (or resume) `hunts/<target>/`, engage the loop, inject the methodology to start the lead hunting. With no argument it resumes the hunt found from the cwd. |
| `/hunt-status` | Show the ledger: findings by status/severity, confirmed headlines, dead-end count. |
| `/hunt-pause` | Stop auto-continuing on idle (the session stays open). |
| `/hunt-resume` | Resume a paused hunt and continue. |
| `/hunt-stop` | Disengage the loop for this workspace (keeps all findings). |

The lead can also call two tools mid-turn:

- **`hunt_dispatch`** — fan hypotheses out to parallel workers. Each hypothesis becomes one isolated
  october subagent, running in the hunt directory, told the worker doctrine and the current ledger,
  that tests its one hypothesis with a control and serializes the result to `findings.d/`.
- **`hunt_status`** — read the merged ledger (same as the `/hunt-status` command).

## How it maps to october seams

| PenHarness (opencode) | october-native |
|---|---|
| `whitehat-hunt` SKILL.md methodology | injected by `/hunt`; the worker doctrine is appended to each worker's system prompt (`methodology.ts`) |
| `fleet.py` dispatch of opencode workers over HTTP | `hunt_dispatch` spawns isolated october processes (`--mode json -p --no-session --tools … --append-system-prompt`), concurrency-capped (`fleet.ts`) |
| `hunt-loop.js` opencode plugin (idle → "continue the hunt") | `agent_settled` lifecycle hook re-prompting the same session (`loop.ts`) |
| `hunts/<target>/` workspace + `findings.d/index.jsonl` ledger | identical on disk — hunts are portable between the two harnesses (`hunt.ts`) |

The remote boat.dev / fly.io worker fleet is intentionally **not** ported: it is opencode+Python
infrastructure. PenHarness's own default ("local" mode — spawn many local workers, one hypothesis
each) is what maps cleanly to october, and that is what this capability is.

## Files

- `index.ts` — extension factory; registered in `../index.ts` as a built-in.
- `commands.ts` — `/hunt` and friends.
- `fleet.ts` — `hunt_dispatch` / `hunt_status` tools and the worker spawner.
- `loop.ts` — the idle hunt loop (TUI-only, gated on an engaged hunt).
- `hunt.ts` — hunt workspace: scaffold, loop markers, discovery, ledger parsing.
- `methodology.ts` — the lead methodology, worker doctrine, continue prompt, and scaffold templates.

## Inertness

The extension registers its triggers unconditionally (they are opt-in), and the loop stays silent
until a hunt is engaged and only ever fires in an interactive TUI lead session — dispatched workers
run in json/print mode and never loop, and they are given a restricted tool set so they cannot fan
out further. A plain october session with no hunt is unchanged.

## Workspace layout

```
hunts/<target>/
  scope.md              authorization (user-written; no active probing until filled in)
  brief.md              rules of engagement, read by every worker
  findings.md           merged ledger (lead-written)
  findings.d/index.jsonl  machine-readable index (one JSON line per finding; workers append)
  dead-ends.md          one-line falsifications
  chains/               compositions per credential floor
  evidence/             raw requests/responses
  report/               the deliverable
  .hunt-active          loop engaged (created by /hunt, removed by /hunt-stop)
  .hunt-loop-pause      loop paused (created by /hunt-pause)
```
