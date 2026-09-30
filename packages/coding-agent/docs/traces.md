# Execution Traces

An execution trace is a local JSONL recording of agent runs: model requests and their streamed output, tool calls and results, extension hook invocations, cancellations, and errors. Credentials are redacted before anything is written. A trace can be replayed offline to reproduce the recorded model and tool boundaries without calling a provider, so a real failure can become a bug report or a regression fixture.

Capture is off unless you ask for it. No setting or environment variable enables it, and nothing is uploaded: the file stays where you put it.

## Record a trace

```sh
pi --trace run.trace.jsonl -p "Fix the failing test"
pi --trace run.trace.jsonl          # interactive, RPC, and JSON modes work too
```

The trace covers every session the command runs, including sessions created by `/new`, `/resume`, or `/fork`. It is closed when the command exits. If capture fails (for example, the disk is full), Pi prints a warning to stderr and the run itself continues unchanged.

`--trace` cannot be combined with `--export` or `--import`.

From the SDK:

```typescript
import { createAgentSession, TraceRecorder } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
const recorder = TraceRecorder.open("run.trace.jsonl", {
  // Values to redact that Pi cannot discover, such as keys held by a custom credential store.
  secrets: [process.env.MY_GATEWAY_KEY ?? ""],
});
try {
  recorder.attach(session);
  await session.prompt("Fix the failing test");
} finally {
  recorder.close();
  if (recorder.error) console.error(`Trace capture stopped: ${recorder.error.message}`);
}
```

`attach()` requires an idle session. Attaching another session detaches the previous one and keeps writing to the same file. `close()` is idempotent.

The file is created with mode `0600`. Pi refuses to write to a path that already exists, including a symlink.

## Replay a trace

```sh
pi --replay-trace run.trace.jsonl
```

Replay validates the file, prints one timeline line per record, replays every complete run, and prints a summary:

```text
#0 +0ms header pi-trace v1 october 0.87.1
#17 +11ms model_request run2 req2 session faux/faux-1 tools=3
#45 +17ms tool_start run2 req3 tool=call-2 slow
...
replay: 2 runs, 4 model responses, 4 tool calls, 0 mismatches
```

Timeline lines contain record types, correlation IDs, and short summaries, never payload content. The exit code is `0` only for a complete trace that replays with no mismatches, and `1` for an invalid, incomplete, or mismatched trace. `--replay-trace` reads nothing but the trace file: it runs before settings, extensions, credentials, and migrations are loaded, and it cannot be combined with `--trace`, `--export`, `--import`, or prompt messages.

From the SDK, `readTrace(path)` or `parseTrace(text)` validates a trace and `replayTrace(trace)` replays it. `createTraceReplay(trace, runId)` returns the adapters for one run if you want to drive your own `Agent`.

A synthetic example is in [`test/fixtures/trace/synthetic.trace.jsonl`](../test/fixtures/trace/synthetic.trace.jsonl): a text turn, a tool call, two parallel tools with interleaved updates, and a call blocked by an extension.

### What replay reproduces

Each recorded run (one `agent_start` to `agent_end`) is replayed through a real agent-core `Agent`. Its provider stream serves the recorded response frames, its tools return the recorded updates and results, and its tool hooks return the recorded decisions. Everything inside a turn is the real loop: stream consumption, tool argument validation, parallel or sequential dispatch, hook application, and tool result construction. Updates, raw results, hook decisions, and completions are released in recorded order, so parallel interleavings are reproduced exactly.

Replay never calls a provider, reads credentials, loads extensions, runs a real tool, or opens a network connection. Turn boundaries come from the recording; replay does not reconstruct steering, follow-ups, compaction, or arbitrary extension side effects. Compaction and summary requests are shown in the timeline but are not replayed.

Replay reports a mismatch, with the run ID and the seq of the recorded record, when the loop:

- calls a tool call ID, tool name, or arguments that differ from the recording;
- makes a model request or tool call the recording does not have;
- leaves recorded responses, tool calls, updates, or hook decisions unconsumed;
- completes tools in a different order, or cannot reach the next recorded event;
- produces a tool-result transcript message that differs from the recorded one;
- would serve a response whose provider, API, or model differs from the recorded request.

A mismatch stops that run; replay never falls back to live execution and never waits indefinitely. Recorded data that replay cannot reproduce exactly (an omitted image, for example) is reported as a fidelity note. A tool with a `prepareArguments` shim, or a redacted value that a tool schema constrains, can produce a mismatch because the shim and the original value are not recorded.

## Format

Each line is one JSON record. Every record has `type`, a contiguous `seq` starting at `0`, and `ts` (milliseconds since the Unix epoch, when the event was observed). File order, `seq` order, and timeline order are the same.

The first record is the header:

```json
{"type":"header","seq":0,"ts":1790791632592,"format":"pi-trace","version":1,"traceId":"...","createdAt":"2026-09-30T18:07:12.592Z","harness":{"name":"october","version":"0.87.1"}}
```

The format version is independent of the session file version. A reader rejects any other version and names it.

| Record | Meaning |
|---|---|
| `session_attach`, `session_detach` | Capture started or stopped for a session. `openOperations` counts work still running at detach |
| `session` | A session event such as `agent_settled`, `queue_update`, `compaction_end`, or `auto_retry_start`, with its data |
| `run_start`, `run_end` | One agent run: model, thinking level, tool execution mode; `willRetry` at the end |
| `turn_start`, `turn_end` | One assistant response and its tool calls, numbered from `0` within the run |
| `message` | A non-assistant message entering the transcript, or, with `requestId`, an assistant message that an extension replaced after the provider returned it |
| `model_request` | A provider request. `kind` is `session` for the conversation or `auxiliary` for compaction, branch summaries, bug-report summaries, and calls made outside a turn. Session requests carry the executable tool definitions, as prepared for that request, when they change. Cache-warming requests the model runtime sends on its own are not recorded |
| `model_frame` | One streamed provider frame (`start`, `text_delta`, `toolcall_end`, ...) |
| `model_response` | The provider's final message and stop reason. `error` is set when the stream function threw, or its stream failed while being read, instead of producing a message; the message then holds the content streamed before the failure, and replay reproduces the same frames followed by the failure |
| `tool_start`, `tool_update`, `tool_end` | Tool execution as the session observed it: requested arguments, partial results, final result |
| `tool_executed` | The raw result the tool itself returned, before result hooks, with the validated arguments |
| `tool_hook` | The `before_tool_call` or `after_tool_call` decision, or the error it threw |
| `hook` | One extension handler invocation: `start` with event, extension path, and handler index; `end` with `ok` (and whether it returned a value) or `error`. Payloads are not copied |
| `cancel` | The run's abort signal fired |
| `error` | A model error, tool hook exception, or extension handler exception |
| `trace_end` | The capture finished cleanly. `eventCount` equals its `seq` |

Correlation IDs: `traceId` names the file; `sessionId` the session; `runId` one agent run; `turn` the turn within it; `requestId` one provider request; `toolCallId` a tool call, scoped by `requestId` because providers may reuse IDs; `hookId` one handler invocation. `traceId`, `runId`, `requestId`, and `hookId` are random IDs generated by the recorder. Session IDs and tool call IDs come from the session and the provider, so they are written as trace-local pseudonyms (`session-1`, `call-1`, ...) assigned at their first appearance. Blocked, invalid, unknown, and truncated tool calls have `tool_end` without `tool_executed`.

### Completeness

`readTrace()` returns `complete: true` only when the file ends with a valid `trace_end` and nothing is unfinished. A truncated final line, a gap in `seq`, an unfinished run, turn, request, tool call, or hook, or a missing `trace_end` makes the trace incomplete; each reason is listed with the line and seq that started the operation. Records after a gap are ignored.

These are errors: malformed JSON elsewhere; a record, message, or frame that does not match its schema; a duplicate `seq`; a record that refers to an unknown or ended parent, a different run or session than its parent, or a turn that is not open; turns out of order; a second session request in one turn; frames that do not form a valid stream or differ from the terminal message; a terminal reason that differs from the message's stop reason; a second terminal for one request or tool call; and any record after `trace_end`. A turn's session request and tool calls must finish before its `turn_end`, a tool call or replacement message must belong to the turn of its request, and a replacement or tool-result message must appear while that turn is open (after the response or tool call it follows). Error messages give the line and seq but never echo record content or identifiers.

A run that failed or was cancelled in an orderly way is complete. An incomplete trace still replays every run that finished before the problem, and `--replay-trace` exits `1`.

### When data is written

Pi snapshots each record when it happens and writes it later, after redaction. A record is written only when every record before it can be written:

- A model stream is held until its response finishes, and a tool invocation until its result is final, so a secret split across fragments can be removed from every fragment.
- Messages before a model request are held until that request's credentials are resolved, so a key first learned for the request is also removed from the prompt that preceded it.
- Everything else is written at the next of these points: a request's credentials resolved, a model response or tool call finished, an extension handler finished, a run ended, or the capture detached or closed.

At most 64 MiB of unwritten data is held. If a stream or tool output exceeds that, or a write or serialization fails, capture stops: unwritten data is discarded, already written runs stay in the file, `trace_end` is not written, and `recorder.error` (or the CLI warning) says why. The agent run is never affected. If the process is killed, the unwritten tail is lost and the trace is incomplete.

## Redaction

Before a record is written, Pi replaces with `<redacted>`:

- stored API keys, OAuth access and refresh tokens, and credential-named `env` values of stored credentials already loaded from `auth.json` (`!command` values are never executed for tracing);
- the API key, credential headers (whole value and the part after the scheme), and credential-named environment values resolved for each request, including values a header hook moves to another header;
- values of environment variables whose names contain `api_key`, `key`, `secret`, `token`, `password`, `pass`, `passphrase`, `private`, `credential`, `authorization`, or `cookie` as a word (for example `SERVICE_KEY` or `SSH_PRIVATE_KEY`), and values passed as `secrets` to `TraceRecorder.open()`, at any length;
- the value of an explicitly named credential in text, such as `Authorization: Basic YTpi`, `"password": "..."`, or `SERVICE_KEY=...`. A quoted value is removed up to its closing quote, including spaces, punctuation, and escaped quotes, also when the assignment sits inside another field's value (`log: password="..."`, `note="password='...'"`);
- `Bearer` tokens of eight or more characters, bare `Basic` values that decode to `user:password` (auth schemes in any letter case, such as `bearer` or `BASIC`), and user info and credential-named query parameters in URLs;
- any value stored under a credential-named key in messages, tool arguments, results, and details.

A secret split across streamed text fragments or across tool updates is removed from every fragment that holds part of it. Tool-call argument streams that contain a secret are coalesced: the first JSON fragment carries the redacted arguments and the rest are empty (marked `coalesced: true`). Session and tool call IDs never reach the file: their pseudonyms are fixed at first appearance, so an ID written before a matching secret became known is still written the same way afterwards.

Record types, stop reasons, model identity, tool names, numbers, and usage counters are never rewritten, so a redacted trace stays valid and replayable. Tool names come from tool definitions, not credentials; a secret registered with the same text as a tool name is not removed from it.

Image data becomes `{"type":"image","omitted":true,"mimeType":"image/png","bytes":1234}`. Text, thinking, and thought signatures and redacted thinking become `"<omitted>"`. Replay turns an omitted image into a text placeholder and reports it.

Short secret values are redacted wherever they appear in text. If a credential-named variable holds `1` or `true`, every `1` or `true` in prompts and output becomes `<redacted>`. This is deliberate: Pi cannot tell a flag from a short password.

## What may still be sensitive

Redaction removes credentials Pi knows about. Review a trace before sharing it. It can still contain:

- your prompts, the system prompt, and project context files such as `AGENTS.md`;
- model output, including thinking text;
- tool arguments and results: file contents, command output, search results, and anything a tool printed;
- file paths, usernames, hostnames, and the working directory;
- extension paths and the names and order of extension handlers;
- timestamps and the recorder's random run, request, and hook IDs;
- the rest of an unquoted credential value after its first space, such as `password: two words` (only `two` is recognized; quoted values are removed whole);
- secrets Pi was never told about, secrets that are encoded or transformed (for example base64 or URL encoded), and keys held only by a custom credential store unless passed as `secrets`;
- a secret first learned after data containing it was already written, for example a `!command` key resolved for a provider used late in the session whose value a tool printed earlier. Written records are not rewritten.
