# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

For programmatic creation, persistence, and tree navigation, see the [`SessionManager` API](sdk.md#sessionmanager-api).


## File Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

By default, `<session-id>` is a UUID. Callers can supply a custom ID through the SDK or `--session-id`. For `<path>`, Pi removes the leading path separator and replaces `/`, `\\`, and `:` with `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Source Files

Source on GitHub ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [Message Types](message-types.md) - Shared message and content-block reference
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - Base message and content-block types
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - Extensible `AgentMessage` union

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Messages

A `message` entry stores an [`AgentMessage`](message-types.md). Message content blocks, roles, usage, and message timestamps are defined in [Message Types](message-types.md).

Session entry timestamps are ISO 8601 strings. The nested message timestamp is a Unix timestamp in milliseconds.

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually an 8-char hex ID; may fall back to a full UUID
  parentId: string | null;  // Parent entry ID (null for a root entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`. System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry.

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant...","tools":"<tools>\n- read: ...\n</tools>","cwd":"/project"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:04:00.000Z","message":{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},"toolsRemoved":[{"name":"write"}],"timestamp":1733234640000}}
```

Sessions created before system messages existed have no leading system message; the first request declares the current prompt as a later system message, which replays the same way.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

Assistant messages name the model that produced them. Newer messages also record `thinkingLevel`, the Pi thinking level requested for that response.

### ModelChangeEntry

Emitted when the user switches models mid-session. The latest entry is the selected model, which may be a [virtual model](virtual-models.md); assistant messages then name the physical model that answered.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### UsageEntry

Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `"cache_warm"`.

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

Usage entries contribute to session token and cost totals. Pi hides them from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them.

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages and a complete system prompt/tool checkpoint.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older summarized entries with the compaction summary and keeps the range beginning at this entry. A retain-none compaction stores its own ID in this field, so no preceding entries are retained.

Optional fields:
- `systemMessage`: The replayed prompt sections and tool declarations at the compaction boundary; it becomes the leading system message of the compacted context, and system messages among the kept entries are dropped in its favor. It is absent on older session entries.
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` is the entry from which the new branch continues. `fromId` is the previous leaf whose abandoned path was summarized.

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

Pi stores [virtual model](virtual-models.md) router state as custom entries with `customType` `pi.virtual-model-state` and `data` `{ provider, modelId, state }`.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries normally form one tree, but navigation APIs can create multiple roots:
- A root entry has `parentId: null`; the first entry is initially the root
- Each non-root entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree
- Calling `resetLeaf()` or `branchWithSummary(null, ...)` allows a later entry to become another root

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` walks from the current leaf to the root, producing the active entry list while honoring compaction:

1. Collects all entries on the path
2. If one or more `CompactionEntry` values are on the path, uses the latest one:
   - Includes the compaction entry first
   - Includes non-system entries from `firstKeptEntryId` up to, but not including, the compaction entry
   - Includes entries after the compaction entry
3. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionProjection()` then applies the latest `context_edit` for each selected target. It returns the model-visible messages together with their source entries. Omitted targets produce no message; replacements retain the source entry's role and metadata while changing only content. The raw selected entries are not modified.

`buildSessionContext()` builds on that projection to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `compaction` -> complete system checkpoint followed by `compactionSummary`
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `context_edit` -> no context message of its own
   - `usage` and `custom` -> no context message

The compaction summary replaces entries before `firstKeptEntryId`. Pre-compaction system messages are folded into the complete checkpoint rather than replayed from the retained range. Retained non-system entries and all entries after the compaction remain available to the LLM.

## Portable Sessions

A portable session moves a conversation between machines and entry points (CLI, RPC, SDK). Its structured fields carry no harness credentials, provider replay secrets, or source-machine path fields. Transcript content is not redacted: message text, tool arguments, and command output are kept verbatim and can contain paths or secrets (see [Security boundary](#security-boundary)). Native session files stay the storage format; a portable file is an interchange copy.

| Entry point | Export | Import |
|-------------|--------|--------|
| CLI | `--export <session.jsonl> <out>.jsonl` | `--import <portable.jsonl>` |
| Interactive | `/export <out>.jsonl` | `/import <portable.jsonl>` |
| RPC | [`export_jsonl`](rpc-commands.md#export_jsonl) | [`import_jsonl`](rpc-commands.md#import_jsonl) |
| SDK | `session.exportToJsonl()`, `exportPortableSession()`, `serializePortableSession()` | `runtime.importPortable()`, `importPortableSession()` |

### Format

A portable file is JSONL v3 with a `portable: 1` marker in the header:

```json
{"type":"session","version":3,"portable":1,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z"}
```

- The header has exactly these five fields. `cwd` and `parentSession` are excluded.
- Only the active branch is exported: the path from the root to the current leaf. Entries on other branches are left out and reported once with a count.
- Entries keep their `type`, original `id`, and original `timestamp`, in path order. `parentId` is re-chained to the previous exported entry, so the file is one linear path and its last entry is the leaf.
- The session `id` and header `timestamp` are kept. Importing restores the same session id.

### Fields

Each entry is built field by field from this allowlist. Anything else present in the source is left out and reported.

| Entry | Kept | Excluded |
|-------|------|----------|
| Header | `type`, `version`, `portable`, `id`, `timestamp` | `cwd`, `parentSession` |
| `message` user | `role`, `content` (string, or `text`/`image` blocks), `timestamp` | `textSignature` |
| `message` assistant | `role`, `content`, `api`, `provider`, `model`, `responseModel?`, `providerThinkingLevel?`, `usage`, `stopReason`, `endTurn?`, `timestamp` | `textSignature`, `thinkingSignature`, `thoughtSignature`, redacted thinking blocks, `responseId`, `deferred`, `diagnostics`, `errorMessage`, `rawStopReason` |
| `message` assistant with `stopReason` `pending` or `deferred` | nothing | the whole entry |
| `message` toolResult | `role`, `toolCallId`, `toolName`, `content` (`text`/`image`), `isError`, `usage?`, `timestamp` | `details` |
| `message` bashExecution | `role`, `command`, `output`, `exitCode?`, `cancelled`, `truncated`, `excludeFromContext?`, `timestamp` | `fullOutputPath` |
| `message` system | nothing | the whole entry |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, `usage?`, `fromHook?` | `details`, `systemMessage` |
| `branch_summary` | `fromId`, `summary`, `usage?`, `fromHook?` | `details` |
| `custom_message` | `customType`, `content` (string, or `text`/`image` blocks), `display` | `details` |
| `context_edit` | `targetId`, `replacement` (`null` or `{ content }` with the target role's content rules) | fields the target role excludes |
| `model_change` | `provider`, `modelId` | - |
| `thinking_level_change` | `thinkingLevel` | - |
| `usage` | `kind`, `provider`, `model`, `usage` | `note` |
| `session_info` | `name?` | - |
| `label` | `targetId`, `label?` | - |
| `custom` | nothing | the whole entry |
| Any other entry type, message role, or content block | nothing | the whole value |

Content blocks keep only their content fields: `text` keeps `type`/`text`; non-redacted `thinking` keeps `type`/`thinking`; `toolCall` keeps `type`/`id`/`name`/`arguments`/`namespace?`; `image` keeps `type`/`mimeType`/`data` in its original position. Image blocks are how attachments are stored, so attachments round-trip inline.

Legacy or hand-built sessions can hold missing or `null` content, or string content on assistant and tool-result messages. Export writes these as content blocks (`[]`, or one `text` block), which is how native loading and context building already treat them, and reports each as `normalized_value`.

Why these exclusions:

- **Signatures and redacted thinking** are opaque provider state tied to an account. Providers already handle messages without them; the loss is same-model reasoning replay.
- **`details`, `custom.data`** are untyped extension data that can hold paths or secrets. They are not sent to the model.
- **`errorMessage`, `rawStopReason`, `usage.note`** are free-form provider or extension text. `stopReason` stays, so a failed turn is still recorded as failed.
- **System messages and `compaction.systemMessage`** describe the source prompt and tools. The destination declares its own prompt and tools on the next request.
- **`fullOutputPath`** is a source-machine path. The destination context therefore has no `[Output truncated. Full output: <path>]` footer for that bash message; `truncated: true` is kept.
- **Unsettled assistant turns** need their excluded provider handle to resume.

### References

Entry ids are never rewritten.

- `compaction.firstKeptEntryId` that names an excluded entry moves to the next exported entry before the compaction. With no such entry, or when the value is missing or names no earlier entry on the path (legacy v1 sessions), it becomes the compaction's own id, which means "retain nothing before the compaction". Both keep the retained context unchanged and are reported as `remapped_reference`.
- A `label` or `context_edit` whose target is not exported is dropped and reported.
- `branch_summary.fromId` is provenance only. It usually names an entry on the abandoned branch and is not checked.
- Tool results are not matched against earlier tool calls, as in native sessions.

### Diagnostics

Export returns every excluded or changed value:

```typescript
interface PortableSessionDiagnostic {
  code: "excluded_field" | "excluded_entry" | "inactive_branch" | "normalized_value" | "remapped_reference";
  entryId?: string; // absent for header and branch-level items
  field: string;    // e.g. "header.cwd", "assistant.content.thinkingSignature", "custom"
  message: string;
}
```

Order is header diagnostics, then the `inactive_branch` count, then entries in path order and content order. SDK and RPC return the full list. The CLI and interactive mode print one line per `code` and `field` with a count.

### Import

Import has no lossy mode. It accepts exactly the contract above or fails with `PortableSessionError`, which carries a stable `code`, the physical `line`, a JSON `path`, and a message with both:

```
Invalid portable session /tmp/portable.jsonl (line 4, $.message.content[0].thinkingSignature): unexpected field
```

- Every non-blank line must be JSON. The first record must be the only header, with `portable: 1`, `version: 3`, a valid session id, and a string timestamp. A file without the marker is rejected; open native session files with `--session` or `switch_session` instead.
- Unknown entry types, roles, blocks, and fields are rejected, not stripped.
- Ids must be unique, the path must be linear, and `firstKeptEntryId` and `targetId` must name earlier entries.
- If the session directory already holds a file with the same session id, import fails with `SessionImportIdConflictError`. This includes the portable file itself when it sits in the session directory.

These rejections happen before anything is written or the active session changes, and all extend `SessionImportError`: an invalid file (`PortableSessionError`), a session id conflict (`SessionImportIdConflictError`), a missing input file (`SessionImportFileNotFoundError`), and importing into a runtime with session persistence disabled (`--no-session`). A `session_before_switch` handler can also cancel the import before anything is written; the import then returns `{ cancelled: true }`.

Failures after validation are not transactional. A filesystem error while creating the session directory or writing the file is thrown as is and can leave the new directory behind. If the runtime fails to start the imported session after the file is written, the file stays in the session directory.

On success, import writes a new native session `<sessionDir>/<import-time>_<id>.jsonl` whose header has the destination `cwd` and no marker, followed by the validated entries. The input file is never opened in place or modified, and nothing is written when validation fails. Reopening the new file resumes at the exported leaf.

### Security boundary

The portable structure (header, entry fields, message fields) contains no harness credentials, provider replay secrets, or source-machine path fields. Transcript content is kept verbatim: message text, tool-call arguments, tool-result text, bash `command`/`output`, and summaries. That content can still contain paths or secrets written by the user, the model, a tool, or the harness, such as a bash tool result's `Full output: <path>` text or the file lists in a compaction summary. Review a portable file before sharing it.

### Deliberate losses

- Same-model reasoning replay (signatures and redacted thinking). A session exported between a Gemini 3 tool call and its answer loses the call's `thoughtSignature`; the provider may reject the continued request, as after a mid-turn model switch.
- Extension state (`custom` entries) and tool render metadata (`details`).
- The source prompt and tool loadout.
- Inactive branches.
- Provider error text and raw stop reasons.
- Usage notice qualifiers.
- The truncated-output footer of `!` bash messages.
- Unsettled (`pending`/`deferred`) assistant turns.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "usage":
      console.log(`[${entry.id}] Usage (${entry.kind}): ${entry.usage.totalTokens} tokens`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```
