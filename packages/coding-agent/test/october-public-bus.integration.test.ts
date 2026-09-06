import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOctoberBusEnv } from "../src/extensions/october/bus/env.ts";
import { MCP_TOOL_PREFIX } from "../src/extensions/october/bus/mcp-client.ts";
import { registerOctoberPublicBus } from "../src/extensions/october/bus/public.ts";
import { registerOctoberBusTools } from "../src/extensions/october/bus/tools.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

// Explicit opt-in to a pinned, locally built Bus. Never uses live model APIs or an existing daemon.
const binary = process.env.OCTOBER_BUS_TEST_BINARY;

describe.skipIf(!binary)("October public Bus integration", () => {
	let daemon: ChildProcess;
	let root: string;
	let address: string;
	let scopeToken: string;
	const harnesses: Harness[] = [];

	async function api<T>(route: string, token: string, input: unknown, method = "POST"): Promise<T> {
		const response = await fetch(`${address}${route}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(5000),
		});
		expect(response.ok, `Bus ${method} ${route}: HTTP ${response.status}`).toBe(true);
		const body = (await response.json()) as { result: T };
		return body.result;
	}

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "october-bus-integration-"));
		daemon = spawn(binary!, ["start"], {
			env: {
				PATH: process.env.PATH,
				OCTOBER_BUS_DATA_DIR: join(root, "data"),
				OCTOBER_BUS_RUNTIME_DIR: join(root, "run"),
			},
			stdio: "ignore",
		});
		const runFile = join(root, "run", "bus.json");
		for (let attempt = 0; attempt < 200 && !existsSync(runFile); attempt++) await delay(25);
		const run = JSON.parse(readFileSync(runFile, "utf8")) as { address: string; adminToken: string };
		address = run.address;
		const scope = await api<{ scopeToken: string }>("/v1/scopes", run.adminToken, { id: "harness-test" });
		scopeToken = scope.scopeToken;
	});

	afterAll(async () => {
		for (const harness of harnesses) harness.cleanup();
		if (daemon && daemon.exitCode === null) {
			const exited = once(daemon, "exit");
			daemon.kill("SIGTERM");
			await exited;
		}
		if (root) rmSync(root, { recursive: true, force: true });
	});

	async function peer(id: string, connectTo: string[] = []): Promise<Harness> {
		const registration = await api<{ agentId: string; executionId: string; agentToken: string }>(
			"/v1/agents",
			scopeToken,
			{ id, displayName: id, connectTo, leaseMs: 300000 },
		);
		const env = parseOctoberBusEnv({
			OCTOBER_BUS_ADDRESS: address,
			OCTOBER_BUS_MCP_URL: `${address}/mcp`,
			OCTOBER_BUS_AGENT_ID: registration.agentId,
			OCTOBER_BUS_EXECUTION_ID: registration.executionId,
			OCTOBER_BUS_AGENT_TOKEN: registration.agentToken,
		});
		if (env?.transport !== "public") throw new Error("Public Bus launch contract was rejected");
		const harness = await createHarness({
			extensionFactories: [
				async (pi) => {
					registerOctoberPublicBus(pi, env);
					await registerOctoberBusTools(pi, env);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		await api("/v1/me/heartbeat", registration.agentToken, { lifecycle: "idle", ready: true }, "PATCH");
		return harness;
	}

	async function call<T>(harness: Harness, name: string, args: Record<string, unknown>, error = false): Promise<T> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}${name}`, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt(`Run ${name}`);
		const result = [...harness.session.messages].reverse().find((message) => message.role === "toolResult");
		expect(result, `Missing ${name} tool result`).toBeDefined();
		expect(!!result?.isError, getMessageText(result)).toBe(error);
		return (error ? getMessageText(result) : JSON.parse(getMessageText(result))) as T;
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await delay(25);
		}
		throw new Error("timed out waiting for active Bus delivery");
	}

	function acknowledged(harness: Harness, messageId: string): boolean {
		return harness.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== "october-bus-delivery") return false;
			const data = entry.data;
			return (
				!!data &&
				typeof data === "object" &&
				"state" in data &&
				data.state === "acknowledged" &&
				"messages" in data &&
				Array.isArray(data.messages) &&
				data.messages.some(
					(message) => !!message && typeof message === "object" && "id" in message && message.id === messageId,
				)
			);
		});
	}

	it("discovers peers, sends durable correlated messages, acknowledges, coordinates dependencies and rejects replaced credentials", async () => {
		const planner = await peer("planner");
		const builder = await peer("builder", ["planner"]);
		expect((await call<{ peers: { id: string }[] }>(planner, "list_peers", {})).peers.map((p) => p.id)).toContain(
			"builder",
		);
		builder.setResponses([fauxAssistantMessage("Request received")]);
		const args = { peer: "builder", mode: "request", message: "Review auth", idempotencyKey: "review-request-1" };
		planner.setResponses([
			fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}message_peer`, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("Request sent"),
		]);
		await planner.session.prompt("Send review request");
		const sendResult = planner.session.messages.find(
			(message) => message.role === "toolResult" && getMessageText(message).includes("messageId"),
		);
		const sent = JSON.parse(getMessageText(sendResult)) as { messageId: string };
		const retried = await call<{ messageId: string }>(planner, "message_peer", args);
		expect(retried.messageId).toBe(sent.messageId);
		await waitFor(() => acknowledged(builder, sent.messageId));
		expect(
			builder.session.messages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === "october-bus-inbox" &&
					getMessageText(message).includes("Review auth"),
			),
		).toBe(true);
		planner.setResponses([fauxAssistantMessage("Reply received")]);
		const replied = await call<{ messageId: string }>(builder, "message_peer", {
			peer: "planner",
			message: "Reviewed",
			mode: "response",
			responseTo: sent.messageId,
			idempotencyKey: "review-response-1",
		});
		await waitFor(() =>
			planner.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "october-bus-inbox" &&
						getMessageText({ content: entry.content }).includes(`"responseTo":"${sent.messageId}"`),
				),
		);
		await waitFor(() => acknowledged(planner, replied.messageId));
		const first = await call<{ id: string }>(planner, "add_task", { title: "Implement", description: "" });
		const next = await call<{ id: string }>(planner, "add_task", {
			title: "Review",
			description: "",
			dependencies: [first.id],
		});
		await call(builder, "claim_task", { taskId: next.id }, true);
		await call(builder, "claim_task", { taskId: first.id });
		await call(builder, "complete_task", { taskId: first.id });
		await call(builder, "claim_task", { taskId: next.id });
		await call(builder, "complete_task", { taskId: next.id });
		await peer("builder", ["planner"]);
		expect(await call<string>(builder, "list_peers", {}, true)).toContain("401");
	}, 30000);
});
