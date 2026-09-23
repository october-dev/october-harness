# October documentation

October Harness is October's open, multiplayer-first coding agent. It works standalone and connects agents through October Bus. It ships as `@october-dev/october` and retains Pi's extensible agent foundation.

## Start using October

Follow the [Quickstart](quickstart.md) to install October, connect a model, and complete your first task.

```bash
npm install -g --ignore-scripts @october-dev/october
october
```

Run `/login` inside October to choose **October account**, **Another provider account**, or **API key**. Existing credentials are reused. Start multiplayer mode with `october --team`; see [Two harnesses, one Bus](../README.md#two-harnesses-one-bus).

If October is already installed, choose what you want to do:

- [Use October interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure October](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand the inherited agent runtime](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customize October

October can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-october) to select the smallest mechanism that meets your need.

## Automate or embed October

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate October process.
- Use the [TypeScript SDK](sdk.md) to run October inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [provider authentication](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

Some inherited reference pages use Pi names and examples. For October, use the `october` executable, the `@october-dev/october` SDK package, and `.october` configuration paths. Keep inherited `PI_*` environment variables and the `@earendil-works/pi-*` supporting package names as documented.

## Work safely

October's tools and extensions run with the permissions of the October process. Project trust controls which project resources load, but it does not sandbox tool calls. October also provides `ask`, `accept-edits`, and `bypass` tool-permission modes; see [Tool permissions](../README.md#tool-permissions). Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.

## Development

See the [repository README](https://github.com/october-dev/october-harness#contributing-and-upstream-sync), [CONTRIBUTING.md](https://github.com/october-dev/october-harness/blob/main/CONTRIBUTING.md), and [AGENTS.md](https://github.com/october-dev/october-harness/blob/main/AGENTS.md) for setup, checks, and contribution rules. Product docs: [october.dev](https://www.october.dev).
