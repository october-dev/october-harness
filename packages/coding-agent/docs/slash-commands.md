# Slash commands

Type `/` in October's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current October release.

Extensions, prompt templates, and skills can add commands. The command menu in October is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Resume another session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/permissions` | Explain this session's tool permission policy: the selected mode and its source, any trusted project restriction, the delegation ceiling (`inherit` adds no restriction), and whether read, edit and command tools are allowed, ask, or are blocked |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import and resume a JSONL session. [Portable sessions](session-format.md#portable-sessions) are validated and take the current directory; other session files are copied as-is |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML, or as a [portable session](session-format.md#portable-sessions) when the path ends in `.jsonl` |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a diagnostic report to export and attach to an October issue |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future October processes |
| `/capabilities [name]` | Show remembered capability manifests for project and installed extensions, or the full manifest for one match (interactive terminal) |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit October |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
