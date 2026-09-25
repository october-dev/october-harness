# Mixed-harness October Bus example

Run October Harness and a second, unrelated harness client against the same isolated local [October Bus](https://github.com/october-dev/october-bus), and have them exchange delegated work.

- `planner` is a real October Harness SDK session (`harness-worker.ts`). It uses the built-in Bus adapter and the public faux provider, so no API keys or paid models are involved.
- `reviewer` is a minimal client (`minimal-client.ts`). It imports nothing from October Harness: only Node built-ins and the public Bus HTTP contract, protocol `0.1`. It runs with plain `node` and needs no build step. Use it as a starting point for adding another harness to a Bus.

Everything runs on loopback. October Desktop and hosted infrastructure are not used.

## What the run shows

1. **Discovery.** Each side lists its linked peers and finds the other by exact agent ID.
2. **A Bus-level rejection.** The planner messages `missing-peer`. The Bus refuses it (`Linked peer missing-peer was not found`) and the harness reports it as a tool error.
3. **Delegation with a success response.** The planner sends a `request` with body `{"op":"add","values":[2,3]}`. The reviewer pulls it, computes the sum, and sends a `response` with `responseTo` set to the request ID and body `{"ok":true,"result":5}`.
4. **Delegation with an error response.** The planner sends `{"op":"divide","values":[1,0]}`. The reviewer does not implement `divide`, so it replies with `{"ok":false,"error":{"code":"unsupported_operation","message":"Unsupported operation: divide"}}`, correlated the same way.
5. **Acknowledgement.** Each side acknowledges exactly the messages it processed. The runner checks that both processes report the same request and response IDs, although neither can see the other.

The planner is prompted once. Its second and third turns start only because the adapter delivers the reviewer's responses; the runner never relays messages.

## Prerequisites and run

Set up the checkout and install the pinned Bus exactly as in the [single-harness example](../october-bus/README.md#prerequisites) (Node.js 22.19 or newer; `october-bus` v0.1.0-rc.4, verified by SHA-256). Then, from the repository root:

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/october-bus-mixed/run.ts \
  --bus "$bus_install/october-bus"
```

`--bus` falls back to `OCTOBER_BUS_BINARY`, then `october-bus` on `PATH`. A missing or different release fails with installation instructions; it never skips.

A successful run prints each process's evidence and ends with:

```text
PASS: discovery, delegation, correlation, success and error responses verified across two harnesses
```

IDs, ports, and PIDs vary between runs; the asserted exchange does not. The runner exits nonzero on any assertion failure or timeout, removes its temporary directory, and only stops processes it started. That makes it usable as a smoke test.

## Who owns which behavior

| Layer | Owns | In this example |
| --- | --- | --- |
| **October Bus** (the daemon) | Identity and execution authority, links between agents, durable message storage, delivery and acknowledgement state, `responseTo` correlation, and rejecting invalid sends. | Rejects `missing-peer`; stores each request until the reviewer commits it; records which response answers which request. |
| **Harness adapter** (per harness) | Turning Bus operations into something its runtime understands, and keeping credentials out of the model. | For October Harness, the built-in adapter exposes Bus tools such as `message_peer` and injects delivered messages into the session, which wakes it. For the reviewer, the adapter is the ~100-line HTTP loop in `minimal-client.ts`: reserve, commit, reply, acknowledge. |
| **Agent runtime** (model, tools, or code) | Deciding what to do with a message and what the body means. | The planner's scripted model chooses the peer and the request bodies. The reviewer's `handleRequest` decides between a success and an error reply. |

The Bus does not interpret message bodies. `{"ok": ..., "result" | "error": ...}` is an application convention shared by these two clients, not a protocol rule. A response is any message with `mode: "response"` and a `responseTo` that names the request. Bus-level failures, such as an unknown peer or a revoked credential, are HTTP errors on the call itself and never become messages.

## The reviewer's calls

All calls use the reviewer's execution-bound agent token as a bearer token:

| Call | Purpose |
| --- | --- |
| `PATCH /v1/me/heartbeat` | Report `idle` and `ready`. |
| `GET /v1/peers` | Discover the planner. |
| `POST /v1/inbox/reserve` with `waitMs` | Wait up to that long for work; returns a reservation or `null`. |
| `POST /v1/inbox/{reservationId}/commit` | Take delivery of the reserved messages. |
| `POST /v1/messages` with `mode: "response"`, `responseTo` | Reply. `idempotencyKey` makes a retried reply return the original message ID. |
| `POST /v1/messages/ack` | Acknowledge the processed requests. |

See the Bus [HTTP specification](https://github.com/october-dev/october-bus/blob/main/spec/0.1/http.md) for full request and response shapes.

## Limits

The parent process registers both identities with the scope token, as in the single-harness example, so neither client ever handles scope authority. The reviewer uses pull delivery with a short reservation wait. The example covers one request at a time; concurrent delegation and retries are left to the Bus's own conformance tests.
