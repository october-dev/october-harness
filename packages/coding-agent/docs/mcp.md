# Third-party MCP servers

October can expose tools from user-configured Model Context Protocol (MCP)
servers. This is separate from the specialized October Bus adapter: third-party
servers do not receive October Bus credentials, identity, or capabilities.

Configure servers under `mcpServers` in global
`~/.october/agent/settings.json` or trusted project `.october/settings.json`.
Project configuration is ignored until the project is trusted.

## stdio

```json
{
  "mcpServers": {
    "local-files": {
      "transport": "stdio",
      "command": "node",
      "args": ["./tools/synthetic-mcp-server.mjs"],
      "env": { "EXAMPLE_TOKEN": "replace-me" },
      "timeoutMs": 30000
    }
  }
}
```

October starts stdio servers directly, sends MCP messages over their standard
input/output streams, and terminates them when the session shuts down. Server
stderr is drained but not printed because third-party diagnostics may contain
credentials.

## Streamable HTTP

```json
{
  "mcpServers": {
    "team-tools": {
      "transport": "http",
      "url": "https://mcp.example.invalid/mcp",
      "headers": { "Authorization": "Bearer replace-me" },
      "timeoutMs": 30000
    }
  }
}
```

Only `http` and `https` URLs are accepted. Configured environment values and
headers are redacted from errors and `/mcp status` output.

## Tool names and permissions

Tools are registered as `mcp__<server>__<tool>`, using normalized lowercase
segments. October discovers every configured server before registering any
tools and fails closed if normalization creates a collision or a name is
already registered. Run `/mcp status` to inspect connection and discovery
status without displaying credentials.

MCP tools use the existing October tool-permission policy. They are classified
as command tools, so `ask` and `accept-edits` require confirmation and
non-interactive sessions block calls that need confirmation. Cancellation of
an October tool call is forwarded to the MCP request.

## Security model

An MCP server is executable code or a remote service with the authority granted
to its process, credentials, and account. Project trust controls whether
project-owned definitions load; it is not a sandbox.

- Review the server package, command, URL, arguments, and requested credentials.
- Prefer a dedicated account and least-privilege tokens.
- Use absolute commands or pinned packages for stdio servers.
- Treat tool descriptions and results as untrusted data.
- Do not configure secrets in a shared project settings file.
- Tool permission prompts govern calls, not server startup. A stdio server can
  run code as soon as the trusted configuration is loaded.
- October does not send Bus credentials to general-purpose MCP servers and does
  not log configured MCP headers, environment values, or server stderr.

Connection, protocol negotiation, timeout, and malformed-response failures are
reported by server name. One unavailable server does not prevent independent,
non-colliding servers from registering.
