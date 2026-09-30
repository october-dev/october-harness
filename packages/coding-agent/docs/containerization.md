# Run Pi in an isolated environment

Use an isolated environment to limit the files, credentials, processes, and network services that generated commands can access or affect.

You can isolate the complete Pi process or keep Pi on the host and route selected tools into an isolated environment.

## Choose an isolation method

| Method | Where Pi runs | What is isolated | Credential handling | Best for |
|---|---|---|---|---|
| Plain Docker | Container | Pi, built-in tools, `!` commands, and extensions | Credentials passed into the container | A straightforward local container boundary |
| Docker Sandboxes | Managed sandbox | Pi, built-in tools, `!` commands, and extensions | Provider credentials remain on the host and are substituted by the proxy | Managed local isolation without exposing the real provider key |
| OpenShell | Local or remote sandbox | Pi, built-in tools, `!` commands, and extensions | Policy-controlled credentials and inference routing | Filesystem, process, network, and credential policies |
| Gondolin extension | Host | Built-in tools and `!` commands | Stored Pi credentials remain on the host, but commands inherit host environment variables | A local micro-VM for tool execution while retaining the host interface |
| Docker shell runner | Host | Built-in `bash` tool and default `!`, `!!` and RPC `bash` commands | Only allowlisted environment variables reach the container | Containing shell commands with a setting, while other tools stay on the host |

The method changes where extensions run. When the complete Pi process runs inside an isolated environment, its extensions run there too. When host Pi delegates built-in tools through Gondolin, other extension tools still run on the host unless they also delegate their work.

## Decide what Pi can access

An isolated process can still affect resources you expose to it:

- A read-write host mount lets Pi modify those host files.
- Mounting `~/.pi/agent` exposes your Pi credentials, settings, extensions, and sessions.
- Environment variables passed into a container are available to processes inside it.
- Network access may allow code or tool output to leave the environment.
- Tool-only isolation does not constrain the host Pi process or extension tools that do not use the isolated backend.

Expose only the working folder, credentials, and network destinations needed for the task. Use read-only mounts or copy files into and out of the environment when you do not want writes to affect the host.

## Run Pi in plain Docker

Plain Docker provides the simplest whole-process container boundary.

### Build the image

Create `Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

Build it from the directory containing the file:

```bash
docker build -t pi-sandbox -f Dockerfile.pi .
```

### Start Pi

From the working folder you want Pi to access, run:

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

Replace `ANTHROPIC_API_KEY` with the credential required by your provider. The named `pi-agent-home` volume keeps container-local settings, credentials, and sessions between runs.

Do not mount the host's `~/.pi/agent` unless the container should have access to your host Pi configuration and credentials.

### Verify the workspace

Inside Pi, run:

```text
!pwd
```

The command should report `/workspace`. Changes under `/workspace` write through to the mounted host folder. Remove the bind mount or use a read-only mount when that is not acceptable.

## Run Pi with Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) runs the complete Pi process inside a managed sandbox. Its proxy can keep the real provider credential on the host and substitute it when requests leave the sandbox.

Configure credentials before creating the sandbox. Do not run `/login` inside the sandbox because that writes a real credential into it.

### Use a Claude Pro or Max token

Generate the token with `claude setup-token` on a machine with Claude Code. If an `anthropic` secret is already configured, remove it first so the proxy does not add an API-key header alongside the bearer token:

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`sbx secret set-custom` reads the real token from standard input. The sandbox receives an OAuth-shaped placeholder, which the proxy replaces only for requests to the configured host.

For an Anthropic API key, use `sbx secret set anthropic` instead.

### Start Pi

Run this from the working folder you want mounted:

```bash
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
```

For an existing sandbox, run Pi non-interactively with:

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

See the [Pi kit documentation](https://github.com/docker/sbx-kits-contrib/tree/main/pi) for other providers, troubleshooting, and image pinning.

## Run Pi with OpenShell

[NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) provides local or remote sandboxes with filesystem, process, network, credential, and inference policies.

### Select a gateway

Every sandbox requires an active gateway:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

### Create the sandbox

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

Pi, its built-in tools, `!` commands, and extension tools run inside the OpenShell boundary.

### Transfer files to a remote sandbox

A remote gateway does not bind-mount your host working folder. Clone the repository inside the sandbox or transfer files explicitly:

```bash
openshell sandbox upload pi-sandbox ./working-folder /workspace
openshell sandbox download pi-sandbox /workspace/working-folder ./working-folder-out
```

OpenShell inference routing can keep raw model credentials outside the sandbox. When configured, point Pi at the corresponding OpenAI-compatible or Anthropic-compatible endpoint exposed by the gateway.

## Route tools through Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM. Its example extension keeps the Pi process and file-based provider credentials on the host while routing the built-in tools and user `!` commands into the VM.

Commands inside the VM inherit the host process environment. Provider keys supplied through environment variables can therefore be visible inside the VM. Do not use this pattern as a credential boundary unless you remove sensitive variables or change the extension's environment handling.

Gondolin requires Node.js 23.6 or newer and QEMU installed through your operating-system package manager.

### Install the extension

From a Pi source checkout:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

### Start Pi

Run Pi from the working folder you want mounted:

```bash
cd /path/to/working-folder
pi -e ~/.pi/agent/extensions/gondolin
```

The extension mounts the host working folder at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. File changes under `/workspace` write through to the host.

Other extension tools still run on the host unless they explicitly delegate their operations. Review the [Gondolin example](../examples/extensions/gondolin/) before adding tools that could bypass the VM boundary.

## Route shell commands through the Docker runner

The Docker shell runner keeps Pi on the host and runs each shell command in a new `docker run --rm` container. Permission prompts still decide whether a command may run; the runner decides what that command can reach.

### Scope

The first milestone isolates shell execution only:

- Routed: the built-in `bash` tool, and `!`, `!!` and RPC `bash` commands that no extension handles.
- Not routed: `read`, `write`, `edit`, `grep`, `find`, `ls`, the Pi process itself, `pi.exec`, tools supplied through the SDK `baseToolsOverride`, and extension tools.
- Extension-owned: a `user_bash` extension that returns its own operations or result decides where those commands run. Such routes are outside this policy.
- The `powershell` tool is disabled while any runner other than `host` is configured.
- Network access is not restricted.

### Configure the runner

Set `shellRunner` in the agent-directory settings file (`~/.october/agent/settings.json`). Project `.october/settings.json` files cannot set it.

```json
{
  "shellRunner": {
    "type": "docker",
    "image": "my-shell:reviewed",
    "mounts": [{ "path": "." }, { "path": ".git", "readOnly": true }],
    "envAllowlist": ["CI", "TERM", "HTTPS_PROXY"],
    "user": "1000:1000"
  }
}
```

The policy is read once when Pi starts. Reload, `/new`, `/resume` and forks keep it, even if the settings file changes. Restart Pi to apply a change.

At startup Pi prints the active runner, each mount and whether it is read-only, and the allowlist. In print and RPC modes this line goes to stderr; in JSON mode it is a [`diagnostic` record](json.md#startup-diagnostics) with `code` `shell_runner` on stdout. `{ "type": "host" }` selects the normal host shell explicitly and prints a one-line notice; without the setting nothing is printed.

### Prepare the image

- The image must have `bash` on its `PATH`. The runner starts it with `--entrypoint bash`.
- Pull the image in advance. The runner uses `--pull=never`, so a missing image fails with Docker's error instead of downloading.
- Commands run as your host `uid:gid` so files written to mounts keep your ownership. With rootless or user-namespace-remapped Docker, set `user` (for example `"0:0"` for rootless Docker, which maps container root to your user).
- Containers run with `--cap-drop=ALL` and `--security-opt=no-new-privileges`.

### Mounts

Each mount is bind-mounted at the same path inside the container, so paths in commands and output match the host.

- Paths may be absolute, start with `~`, or be relative to the session's working directory when Pi starts.
- Without `mounts`, the session working directory is mounted read-write. An explicit list replaces this default; an empty list mounts nothing, so every command fails.
- The default read-write mount includes the project's `.git/` and `.october/` directories. Git hooks, git config and project extensions stored there are later run by processes on the host, so a command in the container can plant code that runs outside it. Mount `.git` (and `.october`, if present) read-only, as in the example above, unless commands must write to them.
- A mount that contains the agent directory (for example `~`) exposes its credentials, such as `auth.json`. Pi adds a warning to the startup notice when this happens.
- Nested mounts are allowed, for example a read-only `.git` inside a read-write project.
- Two entries that resolve to the same directory are rejected. So are paths that are missing, not directories, or contain a comma, a double quote or a control character.
- A command runs only when its working directory is inside a mount. If a mount is replaced or a symlink in it is retargeted after startup, commands are rejected until Pi restarts.
- Files written outside mounts disappear with the container.

### Environment

Only variables named in `envAllowlist` reach the container, with the values the command would have had on the host. Variables such as `PATH`, `HOME`, `DOCKER_HOST` and proxy settings are passed only when listed. Image `ENV` values still apply to everything else.

Values are written to a private env file (mode 0600, removed after each command), never to the command line. An env file cannot carry a line break or NUL character, so a listed variable containing one makes the command fail without running. `HOME` is set to `/tmp` unless an allowlisted `HOME` value is passed.

Docker normally adds proxy variables from `~/.docker/config.json` to every container. The runner uses an empty private client configuration for `docker run`, so this does not happen. If commands need a proxy, allowlist it:

```json
{ "envAllowlist": ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] }
```

### Docker endpoint

At startup Pi resolves the `docker` executable to an absolute path and asks it for the current endpoint, so the Docker CLI's own order applies: a non-empty `DOCKER_HOST` wins, then `DOCKER_CONTEXT`, then the `currentContext` in your Docker configuration, then the default socket. (Docker's reference page lists `DOCKER_CONTEXT` as overriding `DOCKER_HOST`, but the CLI selects the default context whenever `DOCKER_HOST` is set.) Both are then fixed for the process: later changes to the environment, the Docker context or `PATH` do not affect commands or cleanup. Only a local `unix://` socket is accepted; `tcp://`, `ssh://` and other endpoints make every command fail.

### Failures never fall back to the host

If the runner cannot be used, every shell command fails with the cause and nothing runs on the host. Causes include:

- an agent-directory settings file that cannot be parsed, holds a non-object value such as `null` or a number, or cannot be read (including a permission error on its directory). An empty file or a JSON array cannot hold a policy and means the host shell, like a missing file;
- an invalid `shellRunner` value, such as an unknown type or field, an empty image, an invalid mount, allowlist name or `user`;
- a Windows host, a missing `docker` CLI, or an unsupported endpoint;
- a working directory outside every mount, or a mount that changed after startup.

Fix the cause and restart Pi. A missing image or a stopped daemon fails the individual command with Docker's own error.

### Cleanup and recovery

Each container is named `october-shell-<pid>-<random>` and labeled with its owner: `dev.october.shell-runner=1` plus `.pid`, `.host`, `.uid` and `.pidns`.

- After every command, including aborted and timed-out ones, Pi runs `docker rm -f -v <name>` for up to 10 seconds. If removal cannot be confirmed, Pi adds a line naming the container to the command output; the command keeps its own result.
- When Pi exits, including on Ctrl+C (SIGINT), SIGTERM and SIGHUP, it removes containers that may still exist, within 5 seconds.
- Replacing the session (`/new`, `/resume`, fork) waits for running commands and their cleanup to finish. Quitting does not wait.
- On startup, Pi removes containers left by earlier Pi processes of the same user on the same host and PID namespace whose owner process no longer exists. Containers whose owner may still be alive are kept. If a process ID was reused, the container is kept for manual cleanup.

A killed Pi process (SIGKILL or power loss) can leave containers and private env/config directories under the system temp directory. To recover, list containers:

```bash
docker ps -a --filter label=dev.october.shell-runner=1 \
  --format '{{.Names}} {{.Label "dev.october.shell-runner.pid"}} {{.Label "dev.october.shell-runner.host"}}'
```

Confirm that the owner process is gone, then remove the exact container:

```bash
docker rm -f -v october-shell-12345-0a1b2c3d
```

Each command starts a new container, which adds startup latency.
