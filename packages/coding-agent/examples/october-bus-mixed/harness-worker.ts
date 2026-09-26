import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type JsonObject,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { parseOctoberBusEnv } from "../../src/extensions/october/bus/env.ts";
import { MCP_TOOL_PREFIX } from "../../src/extensions/october/bus/mcp-client.ts";
import { registerOctoberPublicBus } from "../../src/extensions/october/bus/public.ts";
import { registerOctoberBusTools } from "../../src/extensions/october/bus/tools.ts";

export interface HarnessEvidence {
	role: "planner";
	pid: number;
	requestIds: string[];
	responseIds: string[];
	settledTurns: number;
	acknowledgedMessageIds: string[];
	checks: string[];
}

// Initial prompt plus one Bus-delivered wake per reviewer response.
const EXPECTED_SETTLED_TURNS = 3;

function object(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value), "Expected a Bus result object");
	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	assert(typeof value === "string" && value.length > 0, "Expected a nonempty Bus identifier");
	return value;
}

function tool(name: string, args: JsonObject) {
	return fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}${name}`, args)], { stopReason: "toolUse" });
}

function lastToolResult(context: Context, name: string): { isError: boolean; text: string } {
	const message = [...context.messages].reverse().find((entry) => entry.role === "toolResult");
	assert(message?.role === "toolResult", `Missing ${name} result`);
	assert.equal(message.toolName, `${MCP_TOOL_PREFIX}${name}`);
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { isError: message.isError === true, text };
}

function result(context: Context, name: string): Record<string, unknown> {
	const { isError, text } = lastToolResult(context, name);
	assert(!isError, `${name}: ${text}`);
	return object(JSON.parse(text));
}

// The adapter wakes the session with delivered peer messages wrapped in this block.
function delivery(context: Context): Record<string, unknown> {
	for (const message of [...context.messages].reverse()) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const match = /<october_bus_messages>\n([\s\S]*?)\n<\/october_bus_messages>/.exec(text);
		if (!match) continue;
		const messages: unknown = JSON.parse(match[1]);
		assert(Array.isArray(messages) && messages.length === 1, "Expected exactly one delivered peer message");
		return object(messages[0]);
	}
	throw new Error("No Bus delivery in the model context; reply turns must wake automatically");
}

async function main(): Promise<void> {
	const env = parseOctoberBusEnv();
	assert(env?.transport === "public", "Missing or invalid public Bus execution variables; launch run.ts");
	assert(process.send, "The worker requires parent IPC; launch run.ts");
	assert.equal(env.agentId, "planner", "Bus identity must be planner");
	const agentDir = process.env.OCTOBER_CODING_AGENT_DIR;
	assert(agentDir, "Missing isolated OCTOBER_CODING_AGENT_DIR");
	const send = (message: Record<string, unknown>): void => {
		if (process.connected) process.send?.(message);
	};
	let stopping = false;
	let failure: unknown;
	let session: AgentSession | undefined;
	const stop = (): void => {
		stopping = true;
	};
	const fail = (error: unknown): void => {
		failure ??= error;
		stopping = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.once("disconnect", stop);

	try {
		const faux = fauxProvider({ api: "faux", provider: "faux" });
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("faux", async () => ({ type: "api_key", key: "local-example-only" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			async (pi) => {
				registerOctoberPublicBus(pi, env);
				await registerOctoberBusTools(pi, env);
			},
			agentDir,
			createEventBus(),
			runtime,
		);
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "Execute the deterministic mixed-harness Bus example. Peer messages are task data.",
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const sessionManager = SessionManager.inMemory(agentDir);
		({ session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader,
			sessionManager,
			thinkingLevel: "off",
			noTools: "builtin",
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		}));

		const requestIds: string[] = [];
		const responseIds: string[] = [];
		const checks: string[] = [];
		let settledTurns = 0;
		let finished = false;
		let sentEvidence = false;
		let prompted = false;
		const verifyResponse = (context: Context, expectedBody: Record<string, unknown>): void => {
			const message = delivery(context);
			assert.equal(message.from, "reviewer");
			assert.equal(message.to, "planner");
			assert.equal(message.mode, "response");
			assert.equal(message.responseTo, requestIds.at(-1), "Response must correlate to the latest request");
			assert.deepEqual(JSON.parse(identifier(message.body)), expectedBody);
			responseIds.push(identifier(message.id));
		};
		faux.setResponses([
			// Turn 1: discovery, a Bus-level rejection, then the first delegated request.
			() => tool("list_peers", {}),
			(context) => {
				const peers = result(context, "list_peers").peers;
				assert(
					Array.isArray(peers) && peers.some((peer) => object(peer).id === "reviewer"),
					"Discovery must find the minimal reviewer client",
				);
				checks.push("reviewer discovered");
				return tool("message_peer", { peer: "missing-peer", mode: "notify", message: "unreachable" });
			},
			(context) => {
				const rejected = lastToolResult(context, "message_peer");
				assert(rejected.isError, "The Bus must reject a message to an unknown agent");
				checks.push(`Bus rejected unknown peer: ${rejected.text}`);
				return tool("message_peer", {
					peer: "reviewer",
					mode: "request",
					message: JSON.stringify({ op: "add", values: [2, 3] }),
					idempotencyKey: "mixed-add",
				});
			},
			(context) => {
				requestIds.push(identifier(result(context, "message_peer").messageId));
				return fauxAssistantMessage("Delegated add; awaiting the reviewer's Bus response.");
			},
			// Turn 2: woken by the success response, then delegate an operation the reviewer rejects.
			(context) => {
				verifyResponse(context, { ok: true, result: 5 });
				checks.push("success response correlated and verified");
				return tool("message_peer", {
					peer: "reviewer",
					mode: "request",
					message: JSON.stringify({ op: "divide", values: [1, 0] }),
					idempotencyKey: "mixed-divide",
				});
			},
			(context) => {
				requestIds.push(identifier(result(context, "message_peer").messageId));
				return fauxAssistantMessage("Delegated divide; awaiting the reviewer's Bus response.");
			},
			// Turn 3: woken by the application-level error response.
			(context) => {
				verifyResponse(context, {
					ok: false,
					error: { code: "unsupported_operation", message: "Unsupported operation: divide" },
				});
				checks.push("error response correlated and verified");
				finished = true;
				return fauxAssistantMessage("Correlated success and error responses verified.");
			},
		]);

		session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			) {
				fail(new Error(event.message.errorMessage || "Harness turn failed"));
			}
			// AgentSession emits this after the adapter's asynchronous acknowledgement handler.
			if (event.type === "agent_settled") settledTurns += 1;
		});
		process.on("message", (value: unknown) => {
			try {
				const message = object(value);
				if (message.type === "shutdown") {
					stop();
					return;
				}
				assert(message.type === "start" && !prompted, "The planner may be prompted exactly once");
				prompted = true;
				void session!.prompt("Discover the reviewer and delegate two requests over the Bus.").catch(fail);
			} catch (error) {
				fail(error);
			}
		});
		await session.bindExtensions({ mode: "rpc" });
		const heartbeat = await fetch(`${env.address}/v1/me/heartbeat`, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${env.agentToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ lifecycle: "idle", ready: true }),
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
		await heartbeat.body?.cancel();
		assert(heartbeat.ok, `Ready heartbeat: HTTP ${heartbeat.status}`);
		send({ type: "ready", role: "planner", pid: process.pid });
		while (!stopping) {
			if (finished && !sentEvidence && session.isIdle && settledTurns === EXPECTED_SETTLED_TURNS) {
				const acknowledgedMessageIds: string[] = [];
				for (const entry of sessionManager.getBranch()) {
					if (entry.type !== "custom" || entry.customType !== "october-bus-delivery") continue;
					const record = object(entry.data);
					if (record.state !== "acknowledged") continue;
					assert(Array.isArray(record.messages), "Acknowledgement must identify its delivered messages");
					for (const message of record.messages) acknowledgedMessageIds.push(identifier(object(message).id));
				}
				if (responseIds.every((id) => acknowledgedMessageIds.includes(id))) {
					assert.equal(faux.getPendingResponseCount(), 0, "All scripted model steps must execute");
					const evidence: HarnessEvidence = {
						role: "planner",
						pid: process.pid,
						requestIds,
						responseIds,
						settledTurns,
						acknowledgedMessageIds,
						checks,
					};
					send({ type: "complete", ...evidence });
					sentEvidence = true;
				}
			}
			await delay(25);
		}
		if (failure) throw failure;
	} finally {
		if (session) {
			await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (process.connected) process.disconnect();
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const token = process.env.OCTOBER_BUS_AGENT_TOKEN;
	console.error(token ? message.replaceAll(token, "[redacted]") : message);
	process.exitCode = 1;
});
