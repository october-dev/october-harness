# Background Jobs

Reference extension for running long-lived commands (development servers, watchers, test loops, data jobs) while the conversation continues. The agent starts a job, keeps working, reads bounded output when it needs it, and cancels the job when it is done.

The extension is opt-in and uses only public Harness APIs.

```bash
# Load it for one run
october --extension examples/extensions/background-jobs

# Or install it for auto-discovery (copy the whole directory, including index.capabilities.json)
cp -r examples/extensions/background-jobs ~/.october/agent/extensions/
```

## Operations

One tool, `background_jobs`, with an `action` field:

| Action | Fields | Result |
| --- | --- | --- |
| `start` | `command` | Job ID and PID once the process has spawned. It does not wait for the process to exit. |
| `list` | none | One summary line per job. |
| `status` | `id` | State, exit code or signal, reason, timestamps, and output counters. |
| `log` | `id`, optional `tail`, optional `since` | Recent output plus cursor and omission metadata. |
| `cancel` | `id` | Cleanup outcome. Cancelling a finished job returns its result unchanged. |

A field that an action does not use is rejected, as are unknown IDs.

Job IDs look like `job-<UUID>`. They are never reused, and they are never derived from process IDs. An ID only resolves in the extension runtime that created it. After a reload, a new or resumed session, or a restart, old IDs are unknown. That says nothing about whether the old process is still running.

Job states:

| State | Meaning |
| --- | --- |
| `starting` | The slot is reserved and the process is being launched. |
| `running` | The process has spawned and has not exited. |
| `exited` | The leader exited with code 0. |
| `failed` | The leader exited with a nonzero code or a signal, or the launch failed (bad directory, missing shell). |
| `cancelled` | Cancellation completed: signalling was accepted, the leader exit was observed, and both output pipes closed. |
| `unreachable` | Cleanup could not be confirmed. The reason lists exactly what was not observed, for example "output pipes did not close within 2000 ms". |

When a job ends on its own, the extension adds one short `background-job` message to the session. It never contains output, and it is sent with `triggerTurn: false`. It never starts a model turn or steers a running one. During a turn, it is appended after that turn. Cancelled jobs, and jobs ended by shutdown, produce no message.

### `/jobs` command

`/jobs`, `/jobs status <id>`, `/jobs log <id>` (last 20 lines), and `/jobs cancel <id>` inspect and cancel jobs directly. They make no model call and add nothing to the session. `/jobs` cannot start processes: to start one, ask the agent, so the start goes through the normal permission checks. `/jobs cancel` only accepts IDs of jobs this runtime owns, never arbitrary PIDs.

## Output limits and cursors

- stdout and stderr are both read continuously, so a chatty process never blocks on a full pipe. Each stream has its own UTF-8 decoder. A character split across chunks stays intact even when the other stream writes in between. The two streams are merged in arrival order, and that order across streams is approximate.
- Each job retains at most the last **262,144 UTF-16 code units** of decoded output. A UTF-16 code unit is one element of a JavaScript string: most characters use one, and emoji and other supplementary characters use two (a surrogate pair). Older output is evicted, and a surrogate pair is never split.
- `log` returns the last **100 lines** by default; `tail` accepts 1 to 2000. The whole response, metadata included, stays within the standard tool limit of **50KB and 2000 lines**. A single line longer than the limit is cut to its end.
- Cursors are absolute offsets in UTF-16 code units of everything the job has produced. Each `log` result reports `next`. Passing it back as `since` returns only output written after that point, so nothing is repeated.
- This is tail polling, not lossless paging. Output can be skipped in two ways, and each is reported in UTF-16 code units in an `[omitted ...]` line:
  - *evicted*: output requested by `since` (or, without `since`, any output) that had already left the 262,144-unit buffer;
  - *outside the tail or response limit*: retained output dropped by `tail` or by the 50KB/2000-line limit.
- `since` greater than `next` is rejected. So is a `since` that falls between the two halves of a retained surrogate pair. Cursors returned by `log` are always valid.
- Terminal control sequences and other control characters are removed from displayed and returned text. Cursors and counts refer to the stored text before that cleanup.

There are no log files, no live-follow view, and no automatic log messages.

## Limits

- Up to **8** jobs can be starting, running, awaiting cleanup, or `unreachable` at once. A ninth start is rejected before anything is spawned. An `unreachable` job keeps its slot until Harness shuts down. Repeated failed cleanups therefore cannot be used to start an unlimited number of processes.
- Up to **32** finished records are kept. The oldest record is evicted first, and its ID then reports as unknown.
- Commands are limited to 4096 characters.

## Process lifecycle

`start` runs `command` through the shell from `getShellConfig()`: bash (Git Bash on Windows), or `sh` when no bash exists. It runs in the session's working directory, inherits the Harness process environment, and has stdin closed. This is not the built-in `bash` tool's execution path: the `shellPath` setting, `bash` spawn hooks, and `bash` operation overrides (sandbox, SSH, Gondolin) do not apply.

The process belongs to the extension runtime that started it. Aborting the turn during launch kills the new process. Aborting a later turn does not stop a job that has already started.

### Linux and macOS

- Each job runs in its own process group. `cancel` sends `SIGKILL` to the whole group at once. There is no graceful `SIGTERM` stage, so a process that needs a clean stop should be stopped by other means first.
- When the leader exits on its own, the remaining members of its group are killed too, so a shell exit does not leave its children running. The leader's own exit code is still reported.
- A job is `cancelled` only after signalling was accepted (or the group was already gone), the leader's exit was observed, and both output pipes closed, all within 2 seconds. This is a cleanup outcome for ordinary processes of the same user that stay in the group. It is not an independent check that every descendant is dead.
- Processes that leave the group (`setsid`, `nohup ... &` with a new session, daemons), or that change credentials, are outside this guarantee. When such a process keeps the output pipes open, the job becomes `unreachable` after the deadline. If it closed the pipes first, it may survive unnoticed. Keep job commands in the foreground of their shell.
- A signalling error other than "no such process" (for example `EPERM`) is reported unchanged, and the job becomes `unreachable`.

### Windows

- Cancellation runs `%SystemRoot%\System32\taskkill.exe /F /T /PID <pid>` while the leader is still running. A nonzero exit, an error, or a timeout from `taskkill` is reported, and the job becomes `unreachable`.
- After the leader has exited, its PID no longer reliably identifies the job's process tree, so `taskkill` is never run against it. Children that outlive the leader cannot be controlled. If they keep the output pipes open, the job becomes `unreachable` after 2 seconds.
- Tree termination is best effort and not equivalent to POSIX process groups. Processes that leave the tree, including anything started inside WSL, are not reached.

### Deadline and unreachable jobs

Cancellation, shutdown, and cleanup after a natural exit wait at most 2 seconds for leader exit and pipe closure. Output never extends the wait. At the deadline the extension closes its pipe ends, removes its listeners and timers, and stops reading output. A still-running process is detached from the Harness event loop. Its record becomes `unreachable` with the missing observations, and it keeps its ID and PID for investigation. Later events from that process never change the record or produce messages.

### Session shutdown

Every `session_shutdown` reason attempts to stop this runtime's jobs: quit, reload, `/new`, resume, and fork. The extension first rejects new starts and suppresses completion messages. It then cleans up all jobs concurrently within one shared 2-second deadline. Jobs that could not be confirmed are reported through a UI notification (interactive and RPC modes), or on stderr in print and JSON modes (never on stdout, which carries their output). `/jobs` output follows the same rule. A repeated shutdown is harmless.

Compaction and tree navigation do not affect jobs. A cancelled session switch leaves them running. A new runtime never adopts jobs or PIDs from an earlier one.

**Jobs are not restored after a restart.** Job IDs, output, and control belong to one runtime and are never recovered. Survival is not guaranteed either way: if Harness crashes, is killed with `SIGKILL`, or the machine restarts, no cleanup runs, and jobs may keep running unmanaged or may die. Even a normal shutdown only attempts cleanup; jobs it cannot confirm stopped are reported as described above. Interactive, print, and RPC modes dispose the runtime on normal exit and on handled signals. SDK hosts must call `dispose()` on the runtime to get cleanup.

## Permissions and security

- Starting a job is an ordinary tool call. Every `tool_call` handler sees it, so blocking hooks apply. Under October permission modes, `background_jobs` is a command-class tool: `ask` and `accept-edits` prompt in the UI and block in non-interactive modes, `bypass` allows it, and a read-only delegation ceiling blocks it. Hooks that match only `toolName === "bash"` do not see these commands.
- Approval covers the job until it ends. A later permission mode change does not stop a running job.
- `index.capabilities.json` declares `{ "shell": true }`. This is disclosure metadata checked when the extension loads. It is not a sandbox.
- Jobs run with the full privileges and environment of the Harness process, outside any sandbox that only wraps the `bash` tool.
- Output can contain secrets. Anything returned by `log` enters the model context. Completion messages never include output.
