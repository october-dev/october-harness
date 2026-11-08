# Testing Extensions

`@october-dev/october/testing` provides a public harness for testing extension factories with October's extension runtime and a deterministic faux model. It is intended for extension projects and test suites outside the October monorepo.

The harness does not make provider requests or need API credentials. It runs the extension and tool code you supply, so keep test tools safe and use temporary workspaces for filesystem tests.

## Install

Use Node.js 22.19 or newer. Install October and the public packages used to define tools and faux responses:

```sh
npm install --save-dev @october-dev/october @earendil-works/pi-ai typebox
```

Import the harness from the public testing subpath:

```typescript
import { createExtensionTestHarness } from "@october-dev/october/testing";
```

Faux response helpers are exported by `@earendil-works/pi-ai/compat`. They create scripted assistant messages and tool calls; they do not contact an AI provider.

## Complete example

This example registers a tool, scripts a model tool call and follow-up response, then checks the tool result and captured runtime events:

```typescript
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { createExtensionTestHarness } from "@october-dev/october/testing";

let executions = 0;
const harness = await createExtensionTestHarness({
  extensions: [
    (pi) => {
      pi.registerTool({
        name: "greet",
        label: "Greet",
        description: "Return a greeting for a name",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_toolCallId, params) {
          executions++;
          return {
            content: [{ type: "text", text: `Hello, ${params.name}!` }],
            details: {},
          };
        },
      });
    },
  ],
  responses: [
    fauxAssistantMessage(fauxToolCall("greet", { name: "Ada" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Greeting complete."),
  ],
});

try {
  await harness.prompt("Greet Ada");

  assert.equal(executions, 1);
  const result = harness.session.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") {
    assert.equal(result.content[0]?.type, "text");
    if (result.content[0]?.type === "text") assert.equal(result.content[0].text, "Hello, Ada!");
  }

  assert.ok(harness.events.some((event) => event.type === "tool_execution_start" && event.toolName === "greet"));
  assert.ok(harness.events.some((event) => event.type === "tool_execution_end" && event.toolName === "greet"));
  assert.ok(harness.events.some((event) => event.type === "agent_settled"));
} finally {
  await harness.dispose();
}
```

## Options and methods

`createExtensionTestHarness(options?)` returns a promise for an `ExtensionTestHarness`.

| Option | Type | Behavior |
|---|---|---|
| `extensions` | `InlineExtension[]` | Extension factories loaded through October's standard extension runtime. |
| `cwd` | `string` | Existing workspace to use. The harness does not create or remove it. If omitted, the harness creates and later removes its own temporary workspace. |
| `model` | `FauxModelDefinition` | Optional faux model metadata. When supplied, include its required `id`. Each harness registers an isolated faux provider. |
| `responses` | `FauxResponseStep[]` | Initial scripted responses consumed in order. A step can be an assistant message or a synchronous/asynchronous function that returns one. |

The returned harness exposes:

| Member | Behavior |
|---|---|
| `cwd` | Workspace path used by the session. |
| `session` | Real `AgentSession` created by October's SDK, including its messages and session methods. |
| `events` | Captured `AgentSessionEvent` values and the `session_shutdown` event emitted during disposal. |
| `setResponses(responses)` | Replace the faux provider's remaining scripted responses. |
| `appendResponses(responses)` | Add responses after the current queue. |
| `prompt(input)` | Submit input and resolve when the run completes. |
| `abort()` | Abort the active session operation and wait for the session to become idle. |
| `dispose()` | Asynchronously abort active work and clean up harness resources. Safe to call repeatedly. |

The relevant TypeScript types are exported with the subpath: `ExtensionTestHarnessOptions` and `ExtensionTestHarness`. `extensions` uses the SDK's `InlineExtension` type; faux model and response options use the public `@earendil-works/pi-ai/compat` types.

## Testing behaviors

### Tool execution and errors

Use a faux tool call in `responses` to invoke a tool deterministically. Check the tool's side effects or the matching `toolResult` in `harness.session.messages`. A thrown tool error becomes an error tool result, and the corresponding `tool_execution_end` event has `isError: true`.

For an error case, make the extension tool throw, then assert the matching transcript result and end event:

```typescript
const result = harness.session.messages.find((message) => message.role === "toolResult");
assert.equal(result?.role, "toolResult");
if (result?.role === "toolResult") assert.equal(result.isError, true);
assert.ok(harness.events.some((event) => event.type === "tool_execution_end" && event.isError));
```

### Extension-mediated blocking

A `tool_call` handler can block a specific call before its tool's `execute` method runs:

```typescript
pi.on("tool_call", (event) =>
  event.toolName === "greet" ? { block: true, reason: "denied by test" } : undefined,
);
```

Assert that the tool body did not run, the corresponding `tool_execution_end` has `isError: true` and includes the reason in `result.content`, and the matching `toolResult` has `isError: true`. The agent loop currently emits `tool_execution_start` before it invokes the blocking hook, so do not use that event alone to conclude the tool body ran.

This tests extension policy only. It does not reproduce October's interactive approval dialog, simulate host permission policy, or enforce operating-system permissions.

### Cancellation

`harness.abort()` aborts a running session. Extension tools should observe and honor the `AbortSignal` supplied to their `execute` method, and resolve or reject their work when aborted. The harness cannot forcibly terminate extension code that ignores cancellation.

Synchronize the test on the tool starting, call `await harness.abort()`, await the pending `harness.prompt()`, then assert that the tool's signal was aborted. This avoids timing the assertion against work that has not started.

### Shutdown and workspace cleanup

`dispose()` is asynchronous and idempotent. It aborts session work, waits for active Bash work to settle, emits the extension `session_shutdown` event with reason `quit`, disposes the session, and removes the harness-owned temporary workspace. The shutdown event remains available in `harness.events` after disposal.

Assert shutdown after disposal with `assert.ok(harness.events.some((event) => event.type === "session_shutdown"))`. For a harness-created workspace, save `harness.cwd` before disposal and assert that it no longer exists afterwards. When testing a supplied `cwd`, assert that files you placed there remain after disposal.

When `cwd` is supplied, it is caller-owned and is never removed. Bash operations that ignore cancellation and never settle can prevent `dispose()` from completing because cleanup waits for active Bash work before removing an owned workspace.

## Limits

- The faux model returns the responses you script; it does not simulate real AI provider calls, and the harness makes no provider network requests.
- Extension-mediated `tool_call` blocking is testable. This does not simulate host or operating-system permission enforcement.
- The harness does not reproduce interactive host approval dialogs.
- Tool and extension code executes in the test process. The harness is not a security sandbox.
- Extension code and Bash operations must cooperate with cancellation. In particular, Bash work that never settles can keep disposal pending.
