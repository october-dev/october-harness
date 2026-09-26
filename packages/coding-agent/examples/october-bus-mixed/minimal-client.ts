// A second, non-October harness client for the mixed-harness example.
// It deliberately imports nothing from October Harness: only Node built-ins and the public
// October Bus HTTP contract (protocol 0.1). Run it with plain `node`; no build step is needed.

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

interface BusMessage {
	id: string;
	from: string;
	to: string;
	mode: string;
	body: string;
	responseTo?: string;
}

interface ClientEvidence {
	requestIds: string[];
	responseIds: string[];
	acknowledgedMessageIds: string[];
	checks: string[];
}

// The only operation this client implements. Anything else gets an application-level error response.
function handleRequest(body: string): Record<string, unknown> {
	let request: unknown;
	try {
		request = JSON.parse(body);
	} catch {
		return { ok: false, error: { code: "invalid_request", message: "Request body must be JSON" } };
	}
	const { op, values } = (request ?? {}) as { op?: unknown; values?: unknown };
	if (op !== "add") {
		return { ok: false, error: { code: "unsupported_operation", message: `Unsupported operation: ${String(op)}` } };
	}
	if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
		return { ok: false, error: { code: "invalid_request", message: "values must be an array of numbers" } };
	}
	return { ok: true, result: values.reduce((sum, value) => sum + value, 0) };
}

async function main(): Promise<void> {
	const address = process.env.OCTOBER_BUS_ADDRESS;
	const token = process.env.OCTOBER_BUS_AGENT_TOKEN;
	const expectedRequests = Number(process.env.EXAMPLE_EXPECTED_REQUESTS ?? "2");
	assert(address && token, "Missing OCTOBER_BUS_ADDRESS or OCTOBER_BUS_AGENT_TOKEN; launch run.ts");
	assert(process.send, "The client requires parent IPC; launch run.ts");

	let stopping = false;
	process.once("disconnect", () => {
		stopping = true;
	});
	process.on("message", (value: unknown) => {
		if ((value as { type?: unknown })?.type === "shutdown") stopping = true;
	});

	// Every call uses the execution-bound agent token issued at registration.
	const call = async (method: string, route: string, input?: unknown): Promise<unknown> => {
		const response = await fetch(`${address}${route}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: input === undefined ? undefined : JSON.stringify(input),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		const envelope = (await response.json()) as { ok?: boolean; result?: unknown; error?: { code?: string } };
		assert(
			response.ok && envelope.ok === true,
			`${method} ${route}: HTTP ${response.status} ${envelope.error?.code ?? ""}`,
		);
		return envelope.result;
	};

	await call("PATCH", "/v1/me/heartbeat", { lifecycle: "idle", ready: true });

	// Bus 0.1.0-rc.4 returns the linked peers as an array of agents.
	const peers = (await call("GET", "/v1/peers")) as { id: string }[];
	assert(
		peers.some((peer) => peer.id === "planner"),
		"Discovery must find the October Harness planner",
	);
	const evidence: ClientEvidence = {
		requestIds: [],
		responseIds: [],
		acknowledgedMessageIds: [],
		checks: ["planner discovered"],
	};
	process.send({ type: "ready", role: "reviewer", pid: process.pid });

	while (!stopping && evidence.requestIds.length < expectedRequests) {
		// Pull delivery: reserve waits up to 1 s for work, then commit hands the batch to this execution.
		const reservation = (await call("POST", "/v1/inbox/reserve", { limit: 10, waitMs: 1000 })) as {
			id: string;
		} | null;
		if (!reservation) continue;
		const messages = (await call("POST", `/v1/inbox/${reservation.id}/commit`)) as BusMessage[];
		for (const message of messages) {
			assert.equal(message.to, "reviewer");
			assert.equal(message.from, "planner");
			assert.equal(message.mode, "request", "The planner only sends requests to this client");
			const reply = handleRequest(message.body);
			const sent = (await call("POST", "/v1/messages", {
				to: message.from,
				mode: "response",
				responseTo: message.id,
				body: JSON.stringify(reply),
				idempotencyKey: `reply-${message.id}`,
			})) as { messageId: string };
			evidence.requestIds.push(message.id);
			evidence.responseIds.push(sent.messageId);
			evidence.checks.push(`${reply.ok === true ? "success" : "error"} response correlated to ${message.id}`);
		}
		const { acknowledged } = (await call("POST", "/v1/messages/ack", {
			messageIds: messages.map((message) => message.id),
		})) as { acknowledged: number };
		assert.equal(acknowledged, messages.length, "Every processed request must be acknowledged once");
		evidence.acknowledgedMessageIds.push(...messages.map((message) => message.id));
	}

	if (!stopping) process.send({ type: "complete", role: "reviewer", pid: process.pid, ...evidence });
	while (!stopping) await delay(25);
	if (process.connected) process.disconnect();
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const token = process.env.OCTOBER_BUS_AGENT_TOKEN;
	console.error(token ? message.replaceAll(token, "[redacted]") : message);
	process.exitCode = 1;
});
