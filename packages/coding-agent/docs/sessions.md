# Sessions and Context

October saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

October saves sessions automatically unless you start it with `--no-session`.

```bash
october --continue
october --resume
```

`--continue` opens the most recent session for the current directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Each session records the working directory it was created in and never changes it. October runs a session in its working directory, so tools, `@path` references, project configuration, and context files resolve from there.

| Entry point | Working directory |
|---|---|
| `--continue` | The current directory |
| `--resume`, `/resume`, `--session`, `/import` | The session's working directory, which can differ from the current directory |
| `--fork`, or a `--session` ID from another directory that you choose to fork | The current directory, in a new session |

If a session's working directory no longer exists, for example after the project folder was renamed, interactive mode asks how to open it:

- **Continue** runs the session in the current directory. October does not store that choice, so it asks again the next time you open the session.
- **Fork** copies the session into the current directory as a new session with a new ID, like `--fork`. The original stays unchanged. At startup the copy is stored like other new sessions for the current directory; from `/resume` or `/import` it is stored next to the current session, like `/new`.
- **Cancel** leaves the current session open, or exits at startup.

Other modes exit with an error.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

October stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, October can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. October combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How October Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, October normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, October stores sessions under `~/.october/agent/sessions/`, grouped by working directory. Use `--session-dir`, `OCTOBER_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after October exits.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. A `.jsonl` export is a [portable session](session-format.md#portable-sessions): the active branch, whose structured fields leave out harness credentials, provider replay secrets, and source-machine path fields, with every left-out value reported. Transcript content is not redacted, so message text, tool arguments, and command output can still contain paths or secrets. Import it on another machine or entry point with `/import`, `--import`, RPC `import_jsonl`, or the SDK. Use `/share` to upload the session and get a viewer link. October uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist. Set [`sessionShareDestination`](settings.md#sessions-and-context) to `gist` or `radius` to force one destination.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a diagnostic report to attach to an October issue. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. Choose **Export as Zip**, inspect the report, and attach it to an [October issue](https://github.com/october-dev/october-harness/issues/new). The optional **Upload to Radius** action sends the report to Earendil Works, which operates Radius; it does not submit an October issue. Uploads do not require a login; Radius authentication attributes the report to your Radius account. If an upload fails, October offers to export the zip.
