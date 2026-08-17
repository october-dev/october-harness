# October

October is a coding agent CLI: a TUI, headless `-p` / `--mode json`, and an october-bus client. It is a fork of [pi](https://github.com/earendil-works/pi) (MIT), published as `@october-dev/october`.

## Install

```bash
npm install -g --ignore-scripts @october-dev/october
```

Requires Node.js `>=22.19.0`. Then:

```bash
october login
```

Sign-in uses your October account (device-code). Inside the October app, Desktop injects the session and you do not need to log in again.

```bash
october --provider october
october -p --mode json "summarize this repo"
```

Docs: [october.dev](https://www.october.dev) · issues: [october-dev/october-harness](https://github.com/october-dev/october-harness)

## Commands

| Command | Purpose |
|---|---|
| `october` | Interactive TUI |
| `october login` | Sign in with your October account |
| `october -p "…"` | One-shot print mode |
| `october --mode json -p "…"` | NDJSON event stream |
| `october --provider october --model october/Kimi-K2.7-Code` | Use October inference |
| `october update --self` | Update this package only (never installs upstream pi) |

Config lives in `~/.october/agent`. Sessions, settings, and credentials stay there.

## Providers

October inference is first-party (`--provider october`). Other providers still work via `/login` or their env keys. See [docs/providers.md](docs/providers.md) and [docs/index.md](docs/index.md).

## License

MIT. This package is a fork of [pi](https://github.com/earendil-works/pi) by Mario Zechner / Earendil Works.
