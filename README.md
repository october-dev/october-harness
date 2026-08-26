<div align="center">

<pre>
  ___   ____ _____ ___  ____  _____ ____  
 / _ \ / ___|_   _/ _ \| __ )| ____|  _ \ 
| | | | |     | || | | |  _ \|  _| | |_) |
| |_| | |___  | || |_| | |_) | |___|  _ < 
 \___/ \____| |_| \___/|____/|_____|_| \_\
</pre>

**The October coding agent** — a fast, extensible terminal coding harness with October inference built in.

<p align="center">
  <a href="https://www.npmjs.com/package/@october-dev/october"><img alt="npm" src="https://img.shields.io/npm/v/@october-dev/october?style=flat-square&color=8250df" /></a>
  <a href="https://github.com/october-dev/october-harness/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-black?style=flat-square" /></a>
  <a href="https://github.com/earendil-works/pi"><img alt="fork of pi" src="https://img.shields.io/badge/fork%20of-pi-555?style=flat-square" /></a>
</p>

</div>

---

**October** is a terminal-native coding agent. It runs entirely in your shell — an interactive TUI for pairing, a headless mode for scripts and CI, an RPC surface for embedding, and an SDK for building on top. October inference is baked in: signed in through the October app it is zero-config, and standalone you sign in with a single `october login`.

October is a fork of [pi](https://github.com/earendil-works/pi) (MIT), published as [`@october-dev/october`](packages/coding-agent). It keeps pi's extensible core — TypeScript extensions, skills, prompt templates, and themes — and adds first-party October inference, the October canvas bus for multi-agent work, and deep integration with the October desktop app.

## Quick Start

```bash
npm install -g --ignore-scripts @october-dev/october
october login        # sign in with your October account
october              # start the interactive agent
```

Prefer another provider? `october` speaks to any of the model providers pi supports — run `/login` inside the agent to add one.

## Highlights

- **October inference, built in.** The `october/` models are available out of the box. Inside the October app it's fully zero-config using your signed-in session; standalone, `october login` gets you a token in seconds.
- **Four ways to run.** Interactive TUI, print / `--mode json` for pipelines and CI, RPC for process integration, and an SDK for embedding October in your own apps.
- **Yours to shape.** Extend October with TypeScript **extensions**, teach it **skills**, capture workflows as **prompt templates**, and restyle it with **themes** — no forking the internals.
- **Real sessions.** Persistent, resumable sessions with branching and automatic compaction so long tasks stay in context.
- **Multi-agent ready.** A built-in [october-bus](#the-october-canvas) client lets October collaborate with other agents on the October canvas.
- **Safe updates.** October only ever updates itself — the self-updater refuses to install or replace with any other package.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Modes](#modes)
- [Customization](#customization)
- [The October Canvas](#the-october-canvas)
- [Inside the October App](#inside-the-october-app)
- [Packages](#packages)
- [Development](#development)
- [Relationship to pi](#relationship-to-pi)
- [License](#license)

## Providers & Models

October ships pointed at the **October inference gateway**, exposing `october/`-namespaced models. Authentication is a Bearer token:

- **Inside the October app** — your Supabase session is injected automatically; no login step.
- **Standalone** — `october login` runs a device-code flow and stores a revocable token. `october logout` revokes it.

Because October is built on pi's multi-provider core, you can also bring your own provider (OpenAI, Anthropic, Google, and more) with `/login` from inside the agent, and switch models with `/model`.

## Modes

| Mode | How | For |
|------|-----|-----|
| **Interactive** | `october` | Pairing in a rich TUI |
| **Print / JSON** | `october -p "…"` · `--mode json` | Scripts, pipelines, CI |
| **RPC** | `--mode rpc` | Driving October from another process |
| **SDK** | import the package | Embedding October in your own app |

## Customization

October adapts to your workflow instead of the other way around:

- **Extensions** — add tools, commands, providers, and lifecycle behavior in TypeScript.
- **Skills** — package repeatable know-how the agent can invoke on demand.
- **Prompt Templates** — turn recurring instructions into reusable commands.
- **Themes** — restyle the TUI to taste.

Bundle any of these and share them via npm or git.

## The October Canvas

When October runs on the October canvas it joins the **october-bus** — a shared context bus for multi-agent work. Agents on the canvas can message each other, coordinate on tasks, and drive canvas nodes (documents, terminals, browsers, and more) through a rich tool surface, so a fleet of October agents can collaborate on one problem.

## Inside the October App

October is the first-party harness of the [October](https://www.october.dev) desktop app:

- **Zero-config auth** — the app injects your signed-in session, so inference just works.
- **Managed runtime** — the app installs and pins a verified October build on a private Node runtime.
- **Long-session auth** — October keeps its inference token fresh for the length of a session without you re-authenticating.

## Packages

This monorepo contains October's published CLI plus the upstream workspace packages it builds on. October publishes **only** `@october-dev/october`.

| Package | Description |
|---------|-------------|
| **[@october-dev/october](packages/coding-agent)** | The October coding agent CLI |
| `@earendil-works/pi-agent-core` | Agent runtime with tool calling and state management |
| `@earendil-works/pi-ai` | Unified multi-provider LLM API |
| `@earendil-works/pi-tui` | Terminal UI library with differential rendering |
| `@earendil-works/pi-protocol` · `@earendil-works/pi-client` | Protocol and client libraries |

## Development

```bash
npm install --ignore-scripts   # install dependencies without lifecycle scripts
npm run build                  # refresh model data, then build all packages
npm run build:offline          # rebuild from existing model data, no network
npm run check                  # lint, format, type check, lockfile checks
npm test                       # run the test suite
```

## Relationship to pi

October is a downstream fork of [earendil-works/pi](https://github.com/earendil-works/pi). We track upstream and merge it forward, layering October's inference, canvas, and desktop integration on top. Credit for the underlying harness — the agent core, the multi-provider AI layer, and the TUI — belongs to the pi project. October does **not** publish `@earendil-works/pi-coding-agent`.

## License

MIT. Upstream: [earendil-works/pi](https://github.com/earendil-works/pi).
