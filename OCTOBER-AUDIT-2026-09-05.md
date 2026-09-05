# October Harness audit — 2026-09-05

## Remediation follow-up

The original findings below describe the pre-fix audit. The user subsequently authorized fixes, committing and pushing to `main`, and an October-only npm release. The remediation contains:

- A fixed per-session permission policy. Trusted project settings may tighten, never relax, process policy; tool edits cannot raise it. Regression coverage includes settings-only escalation.
- Credential ownership tracking: clearing Desktop state preserves/restores explicit inference tokens.
- Separate public Bus and Desktop transports. Public launch variables automatically discover tools with bearer authentication, without calling Desktop hook routes or taking over launcher leases.
- Strict HTTP/JSON-RPC response checks, bounded response buffering, and SSE completion without requiring EOF. `/bus status` reports sanitized attachment and discovery state.
- Corrected documentation: public delivery is pull-only, no idle wake-up or user-dialog readiness is claimed, and the examples use `mode`/`taskId`/acknowledgement correctly.
- An October-only release candidate, `0.85.1-october.1`, with isolated npm/Bun consumer validation and a separate `october-v*` trusted-publishing workflow. Pi's inherited publish workflow is retained, not used for October.
- Experimental test fixtures use October's actual agent-directory environment variable. The inherited runtime was not changed to satisfy those tests.
- Compiled Bun version preflight reads metadata beside the executable, matching Pi's existing package lookup instead of returning `0.0.0` from a virtual filesystem.

The current source already suppresses startup “What's New”; the user's screenshot shows older `0.84.2-october.1`. The candidate carries the suppression. Desktop's managed version pin is outside this repository.

Validation: `npm run check` passes. `./test.sh` passes with a checksum-verified temporary `fd` 10.3.0 on PATH, including 2,222 coding-agent tests (51 skipped). All other workspace suites pass too. The compiled-version change additionally passes its eight focused preflight tests. Two faux-provider harness sessions pass against real public Bus commit `e65eef2` (discovery, durable request/reply, duplicate sends, acknowledgements, dependent tasks, replaced credentials). Release build and isolated npm/Bun installs using published Pi dependencies pass. The installed Node candidate opens without “What's New” in regular and fullscreen TUI modes when upgrading from `0.84.2-october.1`. This is integration evidence, not a claim of released-harness conformance certification.

Publication remains gated by `/cl` confirmation and the required live-provider smoke (no October credential available here). The user approved the October-only release path. npm trusted-publisher configuration must also be verified when publishing. The source commit and npm build do not imply publication or a Desktop managed-version update. Pre-existing local header-color changes are excluded from this remediation commit.

Final artifact validation: packed Node and compiled Bun both pass `--version`, `--help`, `--list-models`, and regular/fullscreen upgraded-profile startup without “What's New”. Bun was built with upstream's pinned 1.3.14 and locally ad-hoc signed on macOS before execution; the raw native archive is not a verified signed distribution. npm is unaffected by that native signing step. No live model reply was tested.

Pre-commit candidate: `/var/folders/n8/13fp_d0937b_dkytdsz0z7ww0000gn/T/october-release-2uT7Sl/tarballs/october-dev-october-0.85.1-october.1.tgz`. SHA-512 integrity: `sha512-+HS7y9fYeb6d4avH1LGrVBBBTUZ5Bcf86D6PL0LkOrTpOMDfLXechZDdO9BOcyboCcD8o0isezPtGsOJk0XNoA==`. This earlier artifact includes the pre-existing local header-color edits and is not the committed release artifact. Test log and startup captures are under `/private/tmp/october-binary-smoke.wvROKT/`. Rebuild from the reviewed commit before publication through the workflow.

Remaining improvements: opt-in idle delivery with safe acknowledgement boundaries; UI-prompt readiness reporting coordinated with the launcher; full released-harness conformance evidence; automated reviewable upstream-sync PRs. These are follow-up work, not silently enabled behavior.

## Original audit record

## Scope and sync

Audited October's built-in extension, Bus transport and hooks, permissions, authentication, CLI integration, distribution scripts, tests, and public integration claims. This is a targeted audit of October's changes, not an exhaustive audit of every inherited Pi package or the private Desktop/backend services.

- October starting commit: `cb54acc80` (also `origin/main` when fetched).
- Previous Pi base: `e44d75c20a51142abc056c243b13c1d7bb4be687`.
- Pi target: `da840b6216578c2a571d0374ac6a2091a83f9d91`, through v0.85.1, 25 new commits.
- Public Bus inspected: [`e65eef2158aeed6c27493000f85de6b940675c2e`](https://github.com/october-dev/october-bus/tree/e65eef2158aeed6c27493000f85de6b940675c2e).

The Pi merge is resolved locally but remains uncommitted and unpushed. Existing header, header-test, and changelog wording edits remain unstaged. October keeps its current package version, `0.84.3-october.2`; this sync does not create a release.

Merge adaptations preserve October's package identity, login, version preflight, and product documentation. The stable CLI now uses Pi's common setup without importing development-only server code. Pi's new consumer-install check targets `@october-dev/october` and its `october` binary. The branding assertion accepts the new distribution exclusions, and the startup-changelog regression no longer requires one obsolete package version. Lockfiles were refreshed without lifecycle scripts; no external dependency versions or lifecycle allowlists were changed.

## Findings requiring work

### 1. High: editable project settings can grant unrestricted tool execution

[`permissions.ts`](packages/coding-agent/src/extensions/october/permissions.ts) reads `.october/settings.json` directly, ahead of global settings, without consulting project trust. It re-reads the file before each tool call.

Reproduced with the faux provider: project mode is `accept-edits`; the first `bash` call is blocked; an allowed `write` changes the settings to `bypass`; the next `bash` call succeeds. The same reproduction succeeds with the session's project-trust flag false. An untrusted repository can also supply a project mode that overrides the user's global policy.

Necessary fix: resolve permissions through trusted configuration and retain a user-controlled authority ceiling for the session. Model-authored settings edits must not increase that authority. Require explicit user approval for permission increases. Explicit CLI/environment modes take precedence today and avoid this particular settings override, but the settings-based modes remain affected.

### 2. High: the public October Bus launcher does not connect this harness

The native integration currently implements a Desktop contract. The public Bus uses a different contract:

| Surface | Harness currently expects | Public October Bus provides |
| --- | --- | --- |
| Launch environment | `OCTOBER_BUS_PORT`, `CANVAS`, `NODE` | `OCTOBER_BUS_ADDRESS`, `MCP_URL`, `AGENT_ID`, `EXECUTION_ID`, `AGENT_TOKEN` |
| MCP authentication | `X-October-Canvas`, `X-October-Node`, optional capability | `Authorization: Bearer <agent token>` |
| Lifecycle | `/hook/session`, `/hook/pre-prompt`, `/hook/stop` | Registration and `/v1/me/heartbeat`; launcher owns leases and cleanup |

Reproduced: the public launch environment makes [`parseOctoberBusEnv`](packages/coding-agent/src/extensions/october/bus/env.ts) return `undefined`, so no Bus tools or hooks register. Manually translating the port and identity would still leave the wrong authentication headers and nonexistent hook routes. See the public [launcher](https://github.com/october-dev/october-bus/blob/e65eef2158aeed6c27493000f85de6b940675c2e/cmd/october-bus/main.go), [MCP contract](https://github.com/october-dev/october-bus/blob/e65eef2158aeed6c27493000f85de6b940675c2e/spec/0.1/mcp.md), and [HTTP routes](https://github.com/october-dev/october-bus/blob/e65eef2158aeed6c27493000f85de6b940675c2e/bus/routes.go).

Necessary fix: add an explicit public-Bus adapter using the execution-bound agent token. Keep Desktop transport selection explicit. When using `october-bus agent run`, let that launcher own registration, heartbeat, replacement detection, and cleanup. Do not give the model scope/admin credentials or lease-maintenance tasks.

### 3. High for releases: publishing still assumes Pi's product and infrastructure

[`scripts/publish.mjs`](scripts/publish.mjs) selects all public workspaces and requires one shared version. The read-only `node scripts/publish.mjs --dry-run` fails immediately with `Publish packages are not lockstep versioned: 0.85.1, 0.84.3-october.2`. This mismatch existed before the sync with the previous Pi version too.

The [release workflow](.github/workflows/build-binaries.yml) still depends on Pi's R2 announcement job and infrastructure. [`scripts/local-release.mjs`](scripts/local-release.mjs) also creates launch shims pointing at `.bin/pi`, although this package installs `.bin/october`. These paths conflict with the documented policy of publishing only the October CLI package.

Necessary fix before a release: define an October-only publication allowlist and version policy, keep inherited dependencies on published Pi versions, use October-owned release destinations, and fix local release launchers. Exercise clean npm and Bun consumer installs. No publishing, release build, or workflow changes were attempted during this audit.

### 4. Medium: a Bus port can erase an explicit inference credential

[`auth.ts`](packages/coding-agent/src/extensions/october/auth.ts) treats any nonempty `OCTOBER_BUS_PORT` as Desktop mode. If the Supabase session is absent, `seedOctoberCredential()` calls `clearDesktopCredential()`, which deletes `OCTOBER_INFERENCE_TOKEN`.

Reproduced with a dummy explicit inference token and only a Bus port: the token disappears. A standalone Desktop-style Bus connection therefore interferes with otherwise independent inference authentication. The public launcher does not set this port variable, so this finding applies to the existing Desktop-style launch path.

Necessary fix: distinguish Desktop-owned credentials from an explicit user-supplied token. Clearing Desktop state must clear only credentials that Desktop supplied.

### 5. Medium: MCP accepts responses belonging to another request

[`mcp-client.ts`](packages/coding-agent/src/extensions/october/bus/mcp-client.ts) falls back from the requested JSON-RPC ID to any response carrying a result or error. Its HTTP check rejects non-success responses only when the body is empty.

Reproduced: initialization and tool discovery return HTTP 500 with an unrelated response ID, but `listTools()` reports success and registers the returned tool. Require matching IDs and valid success status/envelopes. Further hardening should bound response bytes and parse SSE incrementally; the present implementation buffers the complete response before selecting an event.

### 6. Integration claims exceed the verified runtime behavior

The [root README](README.md) and [package README](packages/coding-agent/README.md) describe public Bus attachment, native collaboration, and input lifecycle evidence. The extension currently sends three Desktop hook routes and has no background inbox delivery/wake loop or `ui_prompt_start`/`ui_prompt_end` integration. Receiving work at the next pre-prompt boundary does not establish idle wake support.

The sample also uses `intent` for messaging and a task title for `claim_task`; the public MCP schema uses `mode` and `taskId`. The Bus's [verified registry](https://github.com/october-dev/october-bus/blob/e65eef2158aeed6c27493000f85de6b940675c2e/compatibility/registry.json) contains Codex evidence, not October Harness evidence.

Necessary fix: document Desktop support separately from public Bus support and describe delivery as pull-only until stronger behavior is implemented and verified. Treat most of the old `OCTOBER.md` execution plan as historical; its package, model, authentication, and status claims are inconsistent with current code.

## Recommended implementation order

1. Close the permission escalation and preserve explicit inference credentials. Add regressions through the actual session/tool path.
2. Make `october-bus agent run --id reviewer --name Reviewer -- october` connect automatically through the public launch contract. This command is a proposed acceptance target; it does not work with the current integration.
3. Add `/bus status` with connection type, sanitized identity, protocol compatibility, and actionable failures. Keep secrets out of logs and model context.
4. Run two faux-provider harness sessions against the real local Bus. Cover discovery, durable send/ack, request/reply correlation, duplicate requests, task dependencies, execution replacement, permission denial, and shutdown. Pin the tested Bus commit in CI.
5. Complete the public [harness verification runbook](https://github.com/october-dev/october-bus/blob/e65eef2158aeed6c27493000f85de6b940675c2e/compatibility/RUNBOOK.md) and submit versioned evidence before claiming verified compatibility.
6. Add explicit readiness and user-prompt lifecycle signals. Introduce opt-in idle delivery only with a safe queue boundary, acknowledgement after processing, cancellation, and clear permission behavior. Never equate process liveness with model readiness.
7. Repair the October release pipeline and verify installed SDK/CLI artifacts independently of workspace sources.
8. Automate upstream maintenance with scheduled reviewable sync PRs and a separate Bus compatibility job. Current workflows do not automatically merge Pi or test this harness against public Bus. Use checks and conflict reporting before merging; keep package releases a separate decision.

Optional later work: task progress/output-stream UI, cross-machine Bus addresses with explicit authentication policy, session handoff, and provider refresh-on-401 recovery. These should follow basic permission and interoperability correctness.

## Verification and limits

- `npm run check` passes in the actual working copy after model-data hydration.
- Focused validation: 675 tests passed and 9 were skipped. This comprises 278 October/coding-agent tests in the actual working copy, 271 TUI tests, 80 AI tests (8 skipped), 35 agent process tests (1 skipped), and 11 packaging/runtime-dependency helper tests. Other package tests ran against the equivalent resolved temporary checkout.
- Four temporary audit tests reproduce the public environment mismatch, permission escalation, inference-token deletion, and invalid MCP response acceptance. They assert the faulty behavior as diagnostic evidence; the corresponding production fixes are not included in this sync.
- Unbuilt workspace imports required a temporary Vitest alias for `@earendil-works/pi-ai/utils/*`; source tests do not prove that a released tarball works.
- No full test suite, release build, live model calls, credentialed Desktop session, or two-process public Bus conformance run was performed. Package-helper tests use synthetic packages.
- No commit, push, release, issue, PR, or external message was created.
