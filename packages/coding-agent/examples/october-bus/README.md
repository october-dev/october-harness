# Local Bus multiplayer example

Run two real October Harness SDK processes, `planner` and `builder`, against an isolated local [October Bus](https://github.com/october-dev/october-bus). The public faux provider drives deterministic model-to-tool calls without API keys, paid models, October Desktop, or a hosted control plane.

This is a checkout-local SDK example using `createAgentSession` and the existing Bus adapters through relative `.ts` imports. It verifies the real harness runtime and Bus transport, not the stock `october` CLI entrypoint. IDs, ports, PIDs, and readiness-log order vary; the asserted exchange is fixed.

## Prerequisites

Use Node.js 22.19 or newer. The installation commands below support Linux and macOS on x86-64 or ARM64 and require `curl`, `tar`, and `sha256sum` or `shasum`.

From a fresh Harness checkout:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
```

Fresh Git clones lack the ignored provider JSON. `hydrate:model-data` downloads public model metadata without credentials and writes only that data; it does not regenerate the tracked model sources. `build:offline` then builds the workspace exports without refreshing the catalog. An already hydrated checkout can omit hydration. Installation and hydration need internet access; the example itself uses loopback only.

## Install the pinned public Bus

Use exactly [v0.1.0-rc.4](https://github.com/october-dev/october-bus/releases/tag/v0.1.0-rc.4), protocol `0.1`. The SHA-256 values below pin the release archives, and verification happens before extraction. Keep this shell open for the run command so `bus_install` remains available.

```bash
bus_install="$(mktemp -d "${TMPDIR:-/tmp}/october-bus-install.XXXXXX")"
(
  set -eu
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)
      bus_platform=linux_amd64
      bus_sha=cd2aa2ecb5f5b6a9dfe7b39e1bf7dc3ec3e43f96edbaa4f93a0838ee883fb16c ;;
    Linux/aarch64|Linux/arm64)
      bus_platform=linux_arm64
      bus_sha=c083d731203657a72c8aad40b5db206324db8b339aedcf67779b283fdd2243c0 ;;
    Darwin/x86_64)
      bus_platform=darwin_amd64
      bus_sha=7cedc16ff0c7df935da966b27ac2c35e6801b9bc66c20c601d066f248878ad45 ;;
    Darwin/arm64)
      bus_platform=darwin_arm64
      bus_sha=21dc184e2114e8a5cce4a437ca8b9a98db0a5f9a6213ddc815d7c3186f19eea3 ;;
    *) printf '%s\n' 'Unsupported platform for these installation commands' >&2; exit 1 ;;
  esac
  bus_archive="october-bus_0.1.0-rc.4_${bus_platform}.tar.gz"
  curl --fail --location --output "$bus_install/$bus_archive" \
    "https://github.com/october-dev/october-bus/releases/download/v0.1.0-rc.4/$bus_archive"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$bus_sha" "$bus_install/$bus_archive" | sha256sum --check -
  else
    printf '%s  %s\n' "$bus_sha" "$bus_install/$bus_archive" | shasum -a 256 --check -
  fi
  tar -xzf "$bus_install/$bus_archive" -C "$bus_install" --strip-components=1
  "$bus_install/october-bus" version
)
```

Expected version: `october-bus 0.1.0-rc.4 (protocol 0.1)`. Do not substitute a development build or another prerelease: operations can differ even when the protocol version is unchanged. The runner checks the version metadata; archive integrity is checked during installation.

## Run

From the Harness repository root, use its pinned `tsx`:

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/october-bus/run.ts \
  --bus "$bus_install/october-bus"
```

`--bus` accepts an executable path or a command on `PATH`. Without it, the runner uses `OCTOBER_BUS_BINARY`, then `october-bus` on `PATH`. Missing or incompatible binaries produce installation instructions and exit nonzero; they never cause a successful skip.

Startup order:

1. Check the pinned binary; create unique data/runtime directories and start the daemon on a loopback port.
2. Validate `run/bus.json`, its loopback address and owned PID, then require matching healthy `doctor --json` output.
3. Create a scope using the runfile's admin token. Register planner, then builder with `connectTo: ["planner"]`.
4. Spawn two Node workers with separate configuration directories and execution credentials. Each binds its session in RPC mode and confirms an idle/ready heartbeat.
5. Once both workers are ready, prompt planner exactly once. Builder's turn and planner's reply turn wake through the existing Bus adapter.
6. Collect successful settlement and acknowledgement evidence, stop workers and daemon in reverse order, and remove the runtime directories.

The parent creates identities and coordinates readiness, completion, and teardown over IPC. It never forwards tasks, requests, or replies between workers. All task operations and both messages pass through the Bus from harness tool calls.

## Expected exchange and evidence

```text
planner -> list_peers() -> builder discovered
planner -> add_task(title=...) -> taskId, status=open
planner -> message_peer(builder, mode=request, body={taskId}) -> requestId
planner -> first turn settles
Bus     -> builder receives request in model context; automatically starts a turn
builder -> claim_task(taskId) -> status=claimed, claimedBy=builder
builder -> complete_task(taskId) -> status=done
builder -> message_peer(planner, mode=response, responseTo=requestId,
                        body={taskId,status:"done"}) -> responseId
builder -> turn settles; adapter acknowledges requestId
Bus     -> planner receives response in model context; automatically starts a turn
planner -> verifies from, to, mode, responseTo, taskId and completed status
planner -> second turn settles; adapter acknowledges responseId
parent  -> verifies matching IDs and both acknowledgement records; tears down
```

The workers derive task and message IDs from actual results and delivered context. In-memory faux credentials are registered in each production `ModelRuntime`; its catalog refresh has `allowModelNetwork: false`. The resource loader supplies only the Bus extension and no discovered settings, skills, prompts, or project instructions. Built-in coding tools are disabled.

Output includes the daemon's PID/address, two distinct worker PIDs, and one JSON `evidence:` record per worker. Planner reports two settled turns; builder reports one. Each record includes the shared task/request/response IDs, assertion descriptions, and the exact acknowledged message ID. The adapter records acknowledgements after its `agent_settled` handler completes; invoking a tool alone is insufficient.

A successful run ends with:

```text
cleanup: all owned processes exited; removed /tmp/october-bus-multiplayer-...
PASS: discovery, task completion, correlated response, settlement and acknowledgements verified
```

Exit status is `0` only after the assertions and cleanup succeed. The workflow has a 45-second deadline, with shorter startup, subprocess, and HTTP limits. Teardown allows each owned process three seconds to exit gracefully, then sends a forced kill and waits at most five more seconds. Forced termination makes the run fail. Directories are removed only after every owned process exits. The runner never calls a global `october-bus stop` or signals a PID from an unrelated runfile.

## Explicit connection failure

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/october-bus/run.ts \
  --bus "$bus_install/october-bus" --revoke-planner
```

After both workers become ready, this replaces planner's execution using the scope credential. The running planner retains its old token. Its first model-driven `list_peers` call must fail with `MCP HTTP 401`; the worker and parent report failure, tear down both workers and the daemon, and exit `1`. This is intentionally a failed workflow, not a successful test that catches and ignores a 401. It prints the cleanup line and a `FAIL:` diagnostic, never `PASS:`.

## Environment and isolation

| Process | Variables |
| --- | --- |
| Parent | Optional `OCTOBER_BUS_BINARY`; `--bus` takes precedence |
| Daemon and doctor | Generated `OCTOBER_BUS_DATA_DIR` and `OCTOBER_BUS_RUNTIME_DIR` |
| Each worker | `OCTOBER_BUS_ADDRESS`, `OCTOBER_BUS_MCP_URL`, `OCTOBER_BUS_AGENT_ID`, `OCTOBER_BUS_EXECUTION_ID`, `OCTOBER_BUS_AGENT_TOKEN` |
| Each worker's local runtime | Its own `OCTOBER_CODING_AGENT_DIR`, plus `PI_OFFLINE=1` and `AWS_EC2_METADATA_DISABLED=true` |

Child environments inherit only `PATH`, Windows system-directory variables when present, and language settings. Inherited Bus addresses, credentials, proxy settings, model API keys, and Node-loader options are excluded. Admin and scope tokens remain in the parent and the private daemon state; neither is exported to a worker. Token values are not logged. Existing daemons and the developer's configuration are not modified.

## Troubleshooting and verification

- **Missing binary or wrong release:** install the pinned archive and pass its executable through `--bus`.
- **Missing provider JSON:** run `npm run hydrate:model-data`, then `npm run build:offline`.
- **Unresolved workspace exports:** run the offline build from the repository root. Use the repository's `tsx`, not an unpinned `npx` download.
- **Worker rejects its environment:** launch through `run.ts`; do not supply partial execution variables or reuse another daemon's credentials.
- **Readiness or turn timeout:** the error includes captured worker stderr. Check local executable permissions and loopback availability. The runner tears down partial startup too.
- **Unexpected protocol/tool shape:** check the exact Bus release. Failures name the missing tool, result, delivery, or correlation assertion.
- **Interrupted run:** SIGINT and SIGTERM trigger owned-process cleanup and a nonzero exit. A cleanup failure retains the directory and reports failure.

Run `npm run check` after changing the example. Verify the happy path exits `0`, the revoked-token path exits `1` with a `list_peers`/401 diagnostic, and neither leaves any of its reported PIDs or runtime directories behind. The downloaded installation directory is intentionally separate; remove it yourself when finished with the pinned binary.
