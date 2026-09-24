# Quickstart

October runs in your terminal and works with files on your machine. Use October inference, another supported provider, or a local model. Connect October Bus when you want agents to collaborate.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install October

October is distributed as an npm package and requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @october-dev/october
october --version
```

`--ignore-scripts` disables dependency lifecycle scripts. October does not require install scripts for normal npm installations.

## 2. Start October

Change to the folder you want October to work with, then start it:

```bash
cd /path/to/project
october
```

The working folder controls resource discovery and groups saved sessions. The interface shows your conversation, an editor for prompts and commands, and a footer with the folder, model, and session status. See [Interactive usage](usage.md) for files, commands, and queued messages.

## 3. Connect a model

A **model** generates responses. A **provider** is the service or account used to access that model.

Run `/login` inside October, or optionally `october login` in your shell. Both offer **October account**, **Another provider account**, and **API key**. Existing credentials are reused. Use `/login <provider>` or `october login <provider>` to go directly to a provider's authentication methods.

### October account

Select **October account** to open the October website. Sign in, confirm that the code matches your terminal, and click **Approve CLI**. The CLI stores an inference-only token in `~/.october/agent/auth.json`; it does not receive your browser session or password. Inside October Desktop, the app injects the session, so no separate login is required.

For SSH or a terminal without a browser, run `october login --no-browser` and open the printed link on another device. Codes expire after ten minutes; run the command again if needed. Only approve a code from a login you started yourself.

Logging in again saves the new credential before revoking the previous CLI token. Concurrent login and logout operations use the credential-store lock so logout cannot erase a later login.

Run `october logout` to revoke this installation's tokens and remove the local credential. If revocation fails, the command reports failure and retains the credential and pending cleanup for retry. Do not delete `auth.json.october-pending.json`: it is an owner-only file containing tokens awaiting cleanup. A later login retries cleanup before issuing another token; `october logout` retries all pending revocations.

If local persistence and remote revocation both fail, October prints the path to a private recovery file and an `october logout --recovery-file <path>` command. Keep that file until recovery succeeds. This command revokes only those uncommitted tokens without changing your current login. If no recovery file can be written either, October reports that account-side token cleanup is required.

These lifecycle protections also apply to interactive `/login` and `/logout` with the built-in credential store. SDK in-memory `AuthStorage` retains pending cleanup only for that store's lifetime; custom credential-store implementations remain responsible for their own token lifecycle. Desktop's current JWT continues to take precedence for discovery and inference without replacing a saved standalone credential.

### Another provider account

Select **Another provider account**, then a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### API key

Select **API key** in `/login` to store a provider key in `~/.october/agent/auth.json`, or set an environment variable before launching October:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
october
```

Use `/model` to choose a model. See [Models](models.md) and [Providers](providers.md) for provider authentication, local models, and custom endpoints.

## 4. Give October a task

October shows the file reads, commands, and edits it performs. The default permission mode is `bypass`; use `--permission-mode ask` or `--permission-mode accept-edits` for tool approvals. Permission prompts are not an operating-system sandbox. See [Tool permissions](../README.md#tool-permissions).

Enter a task that matches your work:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` to search for a file. When October finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Work with other agents

Launch October from the same project in two terminals:

```bash
october --team
```

October can then discover peers, exchange messages, delegate work, and coordinate shared tasks through October Bus. The launcher installs the pinned Bus runtime when needed. See [Two harnesses, one Bus](../README.md#two-harnesses-one-bus) for identities, scopes, and permissions.

## Continue later

October saves sessions automatically. Resume the most recent session for the same working folder with:

```bash
october --continue
```

Use `/resume` to choose another saved session. See [Sessions](sessions.md) for naming, branching, compaction, export, and sharing.

## Next steps

- [Interactive usage](usage.md) for input, commands, shortcuts, and queued messages.
- [Configuration](configuration.md#context-files) for persistent instructions.
- [Models](models.md) for model and provider selection.

### Choose how to customize October

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give October persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Package](packages.md) |

## Uninstall October

Use the package manager that installed October:

```bash
# npm
npm uninstall -g @october-dev/october

# pnpm
pnpm remove -g @october-dev/october

# Yarn
yarn global remove @october-dev/october

# Bun
bun uninstall -g @october-dev/october
```

Uninstalling leaves configuration, credentials, sessions, and installed packages in `~/.october/agent/`.
