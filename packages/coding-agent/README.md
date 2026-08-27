<div align="center">

<pre aria-label="OCTOBER">
  ___   ____ _____ ___  ____  _____ ____
 / _ \ / ___|_   _/ _ \| __ )| ____|  _ \
| | | | |     | || | | |  _ \|  _| | |_) |
| |_| | |___  | || |_| | |_) | |___|  _ <
 \___/ \____| |_| \___/|____/|_____|_| \_\
</pre>

<h1>October Harness</h1>

<p><strong>October's open, multiplayer-first coding harness.</strong></p>

Fast in a terminal. Extensible as a runtime. Native to October Bus.

[![npm](https://img.shields.io/npm/v/@october-dev/october?style=flat-square&color=7C6CF0)](https://www.npmjs.com/package/@october-dev/october)
[![License](https://img.shields.io/badge/license-MIT-1C1B18?style=flat-square)](https://github.com/october-dev/october-harness/blob/main/LICENSE)
[![October Bus](https://img.shields.io/badge/October%20Bus-native-28B8D8?style=flat-square)](https://github.com/october-dev/october-bus)
[![Upstream](https://img.shields.io/badge/forked%20from-pi-6F6C66?style=flat-square)](https://github.com/earendil-works/pi)

</div>

---

**October Harness is a complete open-source coding agent built to work alone and with other agents.** Run it as an interactive terminal partner, a one-shot command, a JSON process, an RPC server, or an embedded SDK. Use October inference or bring another supported model provider.

Inside October, the same harness becomes a first-class multiplayer agent: it discovers peers through [October Bus](https://github.com/october-dev/october-bus), receives durable work, delegates tasks, exchanges correlated replies, publishes lifecycle and context, and keeps execution authority local to the process doing the work.

October Harness started as a fork of [Pi](https://github.com/earendil-works/pi). Pi remains the foundation for much of the agent core, provider layer, TUI, session model, and extension system. The project has since been substantially changed for October with its own package and CLI, inference and authentication, permission modes, Bus-native tools and hooks, October context handling, managed Desktop runtime, and product identity.

## Why another coding harness?

Claude Code, Codex, and Pi already prove that a terminal is a powerful place to work with an agent. October Harness is not an attempt to hide another agent loop or lock developers into a private implementation.

It exists to be the open reference harness for **multiplayer-native development**:

- useful as a serious standalone coding agent;
- native to agent discovery, durable messaging, delegation, and replies;
- transparent enough for developers to inspect, extend, and self-host;
- concrete enough to show other harness authors what first-class October Bus support looks like;
- deeply integrated with October without exposing October's private cloud or intelligence layer.

Pi optimizes for a small, extensible core. October Harness keeps that foundation and makes a different product choice: multiplayer behavior is part of the first-party runtime, not an afterthought bolted onto a `send_message()` function.

## Contents

- [Five-minute quickstart](#five-minute-quickstart)
- [Authentication, models, and providers](#authentication-models-and-providers)
- [Standalone usage](#standalone-usage)
- [Two harnesses, one Bus](#two-harnesses-one-bus)
- [Using it inside October](#using-it-inside-october)
- [Sessions and permissions](#sessions-and-permissions)
- [Architecture](#architecture)
- [Extensions and customization](#extensions-and-customization)
- [What changed from Pi](#what-changed-from-pi)
- [Open-source boundary](#open-source-boundary)
- [Contributing and upstream sync](#contributing-and-upstream-sync)
- [Roadmap](#roadmap)
- [Security](#security)
- [License and attribution](#license-and-attribution)

## Five-minute quickstart

October Harness requires Node.js 22.19 or newer.

```bash
npm install -g --ignore-scripts @october-dev/october
october login
cd /path/to/your/project
october
```

Ask for a quick orientation:

```text
Summarize this repository, explain how to run its checks, and suggest the highest-leverage next task.
```

October can read, write, and edit files, run shell commands, inspect the repository, and retain the session so you can continue later.

Already have another provider account? Start `october`, run `/login`, select the provider, then use `/model` to choose a model.

## Authentication, models, and providers

### October inference

```bash
october login
```

Standalone login uses a device-code flow and stores a revocable credential under `~/.october/agent/`. Inside October Desktop, the app injects and refreshes the signed-in session, so no separate login is required.

The built-in October provider refreshes its model catalog from the October inference gateway. Its offline seed catalog includes:

- `october/Kimi-K2.7-Code`: the recommended default, with text and image input;
- `october/Qwen/Qwen3.6-35B-A3B-FP8`: a reasoning model.

Use `/model` in the TUI or inspect available models from the shell:

```bash
october --list-models
october --provider october
```

### Subscription providers

Run `/login` to use supported subscriptions for ChatGPT Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot, xAI, OpenRouter, or Radius.

### API-key and cloud providers

The inherited multi-provider layer supports Anthropic, OpenAI, Azure OpenAI, Google Gemini and Vertex AI, Amazon Bedrock, DeepSeek, xAI, OpenRouter, Mistral, Groq, Cerebras, NVIDIA NIM, Cloudflare AI Gateway and Workers AI, Vercel AI Gateway, Hugging Face, Fireworks, Together AI, Baseten, Kimi, MiniMax, Qwen, Xiaomi, ZAI, OpenCode, and other compatible endpoints.

Set an environment variable or use `/login` to store a key in `~/.october/agent/auth.json`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
october
```

Custom model catalogs can connect Ollama, LM Studio, vLLM, and services implementing supported OpenAI, Anthropic, or Google APIs. Custom provider extensions can add new APIs and OAuth flows. See the full [provider guide](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/providers.md) and [custom model guide](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/models.md).

## Standalone usage

October is a complete local harness even when no October app or Bus is present.

| Mode | Command or surface | Best for |
| --- | --- | --- |
| Interactive | `october` | Pairing in the terminal |
| Print | `october -p "Review this diff"` | One-shot tasks and scripts |
| JSON | `october --mode json` | Structured pipelines and CI |
| RPC | `october --mode rpc` | Driving a persistent agent from another process |
| SDK | Import `@october-dev/october` | Embedding the agent in another application |

Common commands:

```bash
october -c                         # continue the latest session
october -r                         # browse previous sessions
october --name "Auth refactor"     # name a new session
october --no-session               # run without persistence
october -p "Summarize this repo"   # one-shot prompt
```

Bus integration is execution-gated. Without a valid Bus port, canvas, and node identity, October registers no Bus tools or hooks and behaves as a normal standalone harness.

## Two harnesses, one Bus

Attach two October Harness processes, or October plus another compatible harness, to the same local [October Bus](https://github.com/october-dev/october-bus). In October Desktop, this is as simple as placing two terminal nodes on one canvas and launching the harness in each.

Ask the first agent:

```text
Find the other agent on this canvas. Delegate a review of the authentication flow,
then wait for its answer and summarize the result for me.
```

The collaboration is visible in protocol operations:

```text
planner  → list_peers()
bus      → builder [attached, ready, local]

planner  → message_peer(builder, intent=request,
                         "Review the authentication flow for failure cases.")
bus      → request accepted durably as msg_01

builder  → check_inbox()
builder  → claim_task("Review authentication flow")
builder  → message_peer(planner, intent=response, responseTo=msg_01,
                         "Found two gaps: expired-device-code recovery and token revocation UX.")

planner  → correlated response received
```

This is more than agent-to-agent chat. The Bus keeps peer identity, reachability, durable delivery, request/reply correlation, shared tasks, dependencies, lifecycle, and human escalation as explicit protocol state. A peer request never expands the receiving harness's permissions.

## Using it inside October

October Harness is the first-party terminal agent for the October Desktop app:

- **Zero-config authentication.** Desktop supplies and refreshes the current October session.
- **Managed runtime.** The app installs and pins a verified harness build on its private Node runtime.
- **Bus-native collaboration.** The harness receives an execution-scoped identity and registers peer, inbox, task, and status tools from the local Bus.
- **Lifecycle hooks.** Prompt, turn, input, and session events provide evidence for safe delivery and reply completion.
- **October context.** Bounded orientation, peer, inbox, and summary context can enter the agent at the appropriate prompt boundary.
- **Local authority.** Bus credentials and process identity belong to one execution and disappear when that run ends.

The CLI remains the same harness in both environments. October integration adds context and collaboration; it does not replace the open runtime with a private agent implementation.

## Sessions and permissions

### Sessions

Sessions are append-only JSONL trees stored under `~/.october/agent/sessions/`, grouped by working directory. They preserve messages, tool results, model and thinking changes, compactions, labels, extension state, and alternate branches.

| Command | Behavior |
| --- | --- |
| `/resume` | Browse saved sessions |
| `/new` | Start a fresh session |
| `/name <name>` | Give the session a human-readable name |
| `/session` | Show the current file, ID, messages, tokens, and cost |
| `/tree` | Move through the current session's branch tree |
| `/fork` | Start a new session from an earlier user message |
| `/clone` | Copy the active branch into a new session |
| `/compact` | Summarize older context for a longer working session |
| `/export` | Export the session for review |

See [Sessions](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/sessions.md), [Compaction](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/compaction.md), and the [session format](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/session-format.md).

### Tool permissions

October adds three explicit tool-permission modes:

| Mode | Reads | File edits | Shell and other commands |
| --- | --- | --- | --- |
| `ask` | Allow | Ask | Ask |
| `accept-edits` | Allow | Allow | Ask |
| `bypass` | Allow | Allow | Allow |

Select a mode with `--permission-mode`, `OCTOBER_PERMISSION_MODE`, project `.october/settings.json`, or global `~/.october/agent/settings.json`. The default is `bypass`. In a non-interactive run, an operation that requires a prompt is blocked rather than silently approved.

Project trust is separate from tool permissions. It controls whether October loads project-local settings, extensions, skills, prompts, themes, and packages. It is an input-loading boundary, not a sandbox.

## Architecture

```mermaid
flowchart TB
    subgraph Entry[Runtime surfaces]
        A[Interactive TUI]
        B[Print / JSON]
        C[RPC]
        D[SDK]
    end

    subgraph Harness[October Harness]
        E[Agent session + message queue]
        F[Agent loop + tools]
        G[Model runtime]
        H[Session manager]
        I[Extension + resource loader]

        subgraph October[Built-in October extension]
            J[Inference + auth]
            K[Permission modes]
            L[Bus MCP client + tools]
            M[Lifecycle + context hooks]
        end
    end

    N[Model providers]
    O[Local files + shell]
    P[(JSONL sessions)]
    Q[October Bus]

    A --> E
    B --> E
    C --> E
    D --> E
    E --> F
    E --> G
    E --> H
    E --> I
    I --> J
    I --> K
    I --> L
    I --> M
    G <--> N
    F <--> O
    H <--> P
    L <--> Q
    M <--> Q
```

The public monorepo contains the full path from CLI input to model request, tool execution, session persistence, and Bus collaboration. October's built-in extension uses the same public extension surface available to developers.

## Extensions and customization

October is designed to be changed at the edges:

| Extension point | What it changes |
| --- | --- |
| TypeScript extensions | Tools, commands, providers, events, UI, and lifecycle behavior |
| Skills | Reusable instructions and domain workflows loaded on demand |
| Prompt templates | Repeatable prompts exposed as slash commands |
| Themes | TUI colors and presentation |
| Packages | Shareable bundles installed from npm or Git |

Start with the [documentation index](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/index.md), then explore [extensions](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/extensions.md), [skills](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/skills.md), [prompt templates](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/prompt-templates.md), [themes](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/themes.md), the [RPC protocol](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/rpc.md), and the [SDK](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent/docs/sdk.md).

## What changed from Pi

October Harness is a real downstream product, not a renamed Pi binary. We continue to inherit and credit substantial upstream work while maintaining October-specific behavior in this repository.

| Area | Pi foundation retained | October-specific work |
| --- | --- | --- |
| Runtime | Agent loop, tools, provider abstraction, TUI, sessions, RPC, SDK | `october` CLI/package identity, `.october` configuration, managed distribution |
| Models | Multi-provider APIs and catalogs | October inference provider, dynamic October catalog, device login, Desktop session refresh |
| Collaboration | General extension primitives | Native October Bus client, peer tools, durable inbox, task coordination, lifecycle and reply hooks |
| Context | Project instructions, skills, prompts, extensions | Bus orientation and peer/inbox context, execution identity, turn summaries |
| Permissions | Project trust and host-process security model | `ask`, `accept-edits`, and `bypass` tool-permission modes |
| Product integration | Portable terminal harness | October header, Desktop launch contract, safe self-update and first-party runtime behavior |

October publishes only [`@october-dev/october`](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent). It does not republish the upstream `@earendil-works/pi-coding-agent` package. The upstream workspace package names and required notices are preserved.

## Open-source boundary

This repository contains the usable harness:

- CLI, interactive TUI, headless modes, RPC runtime, and SDK;
- model and provider support;
- session persistence, branching, compaction, and export;
- project trust and October permission modes;
- October inference and standalone authentication;
- October Bus integration, agent-to-agent tools, lifecycle hooks, and context handling;
- the extension, skill, prompt, theme, and package systems needed to customize it.

It does **not** contain October backend secrets, private inference credentials, internal admin tooling, proprietary Autopilot or team-staffing logic, quota-routing intelligence, enterprise controls, or October's hosted cloud control plane.

The open harness should be enough to run, study, extend, and use as a reference implementation without needing access to October's private product systems.

## Repository layout

| Package | Role |
| --- | --- |
| [`@october-dev/october`](https://github.com/october-dev/october-harness/blob/main/packages/coding-agent) | October CLI, SDK, permissions, inference, and Bus integration |
| [`@earendil-works/pi-agent-core`](https://github.com/october-dev/october-harness/blob/main/packages/agent) | Agent loop, tool calling, and state management |
| [`@earendil-works/pi-ai`](https://github.com/october-dev/october-harness/blob/main/packages/ai) | Unified multi-provider model API |
| [`@earendil-works/pi-tui`](https://github.com/october-dev/october-harness/blob/main/packages/tui) | Differentially rendered terminal UI |
| [`@earendil-works/pi-protocol`](https://github.com/october-dev/october-harness/blob/main/packages/protocol) | RPC protocol types and transport contract |
| [`@earendil-works/pi-client`](https://github.com/october-dev/october-harness/blob/main/packages/client) | Client for remote agent sessions |
| [`@earendil-works/pi-server`](https://github.com/october-dev/october-harness/blob/main/packages/server) | Server runtime for remote sessions |
| [`@earendil-works/pi-telemetry`](https://github.com/october-dev/october-harness/blob/main/packages/telemetry) | Shared, privacy-aware telemetry primitives |

## Contributing and upstream sync

October welcomes fixes, documentation, new provider support, extensions, and improvements to its Bus-native behavior. Read [CONTRIBUTING.md](https://github.com/october-dev/october-harness/blob/main/CONTRIBUTING.md) and [AGENTS.md](https://github.com/october-dev/october-harness/blob/main/AGENTS.md) before making changes.

```bash
git clone https://github.com/october-dev/october-harness.git
cd october-harness
npm install --ignore-scripts
npm run build:offline
npm run check
./test.sh
```

Our upstream policy is straightforward:

- keep Pi copyright, MIT license, package attribution, and provenance intact;
- track Pi through explicit, reviewable upstream merges;
- prefer sending generally useful, October-neutral fixes upstream when practical;
- keep October-specific inference, Bus, permission, Desktop, and product behavior in this repository;
- resolve upstream conflicts without weakening October's public harness or Bus contracts;
- document meaningful divergence so contributors can tell which project owns a behavior.

For substantial October-specific work, open an issue before implementation. If a change belongs cleanly in Pi, contributors are encouraged to coordinate it upstream first and then bring it back through the normal sync path.

## Roadmap

- Make the October Harness the clearest reference implementation of the October Bus compatibility contract.
- Reduce standalone Bus setup to a single, well-documented local workflow.
- Expand adapter and conformance examples for mixed-harness teams.
- Keep provider and model support current without coupling the harness to one inference backend.
- Improve session portability between standalone, Desktop, RPC, and SDK usage.
- Continue upstreaming generally useful runtime, TUI, provider, and session improvements.
- Grow the extension ecosystem without moving proprietary orchestration into the open harness.

## Security

October Harness is a local coding agent. It runs with the operating-system permissions of the user who starts it and does not claim to provide an in-process sandbox.

- Review project trust before loading repository-owned settings, extensions, skills, prompts, themes, or packages.
- Choose an October permission mode appropriate for the task.
- Use a container, VM, micro-VM, or policy-controlled sandbox for untrusted or unattended work.
- Mount only the files and credentials the task needs.
- Treat third-party extensions and skills as executable code and instructions.
- Review changes before committing or deploying them.
- Remember that Bus peers can request work but cannot grant new local authority.

Credentials are stored under `~/.october/agent/`; Bus capabilities, tokens, process identity, and readiness evidence are execution-scoped and remain local.

Report vulnerabilities privately through this repository's [security policy](https://github.com/october-dev/october-harness/blob/main/SECURITY.md) or [GitHub Security Advisories](https://github.com/october-dev/october-harness/security/advisories/new). Do not open a public issue for a security-sensitive report.

## License and attribution

October Harness is licensed under the [MIT License](https://github.com/october-dev/october-harness/blob/main/LICENSE).

It began as a fork of [Pi](https://github.com/earendil-works/pi), and substantial portions of the agent core, AI layer, TUI, sessions, extensions, and supporting packages originate from Pi and its contributors. The required upstream copyright, license, package names, and attribution notices are preserved.

October-specific changes are distributed under the same MIT terms. The license covers the code in this repository; it does not grant rights to October's names, logos, or other brand assets.

---

<div align="center">

Built in the open by [October](https://october.dev), on the open-source [Pi](https://github.com/earendil-works/pi) foundation.

</div>
