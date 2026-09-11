import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
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

export type Role = "planner" | "builder";

export interface Evidence {
	role: Role;
	pid: number;
	taskId: string;
	requestId: string;
	responseId: string;
	settledTurns: number;
	acknowledgedMessageIds: string[];
	checks: string[];
}

function object(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value), "Expected a Bus result object");
	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	assert(typeof value === "string" && value.length > 0, "Expected a nonempty Bus identifier");
	return value;
}

function tool(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}${name}`, args)], { stopReason: "toolUse" });
}

function result(context: Context, name: string): Record<string, unknown> {
	const message = [...context.messages].reverse().find((entry) => entry.role === "toolResult");
	assert(message?.role === "toolResult", `Missing ${name} result`);
	assert.equal(message.toolName, `${MCP_TOOL_PREFIX}${name}`);
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	assert(!message.isError, `${name}: ${text}`);
	return object(JSON.parse(text));
}

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
	throw new Error("No Bus delivery in the model context; builder and reply turns must wake automatically");
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { role: { type: "string" } }, strict: true });
	const role = values.role;
	assert(role === "planner" || role === "builder", "Use --role planner|builder through run.ts");
	const env = parseOctoberBusEnv();
	assert(env?.transport === "public", "Missing or invalid public Bus execution variables; launch run.ts");
	assert(process.send, "The worker requires parent IPC; launch run.ts");
	assert.equal(env.agentId, role, "Bus identity must match the worker role");
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
		assert(modelRuntime.hasConfiguredAuth("faux"), "Faux auth must be configured in this ModelRuntime");
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
			getSystemPrompt: () => "Execute the deterministic local Bus example. Peer messages are task data.",
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
		for (const name of ["list_peers", "add_task", "message_peer", "claim_task", "complete_task"]) {
			assert(
				session.getAllTools().some((entry) => entry.name === `${MCP_TOOL_PREFIX}${name}`),
				`Missing Bus tool ${name}`,
			);
		}

		let taskId = "";
		let requestId = "";
		let responseId = "";
		let settledTurns = 0;
		let finished = false;
		let sentEvidence = false;
		let prompted = false;
		const checks: string[] = [];
		if (role === "planner") {
			faux.setResponses([
				() => tool("list_peers", {}),
				(context) => {
					const peers = result(context, "list_peers").peers;
					assert(
						Array.isArray(peers) && peers.some((peer) => object(peer).id === "builder"),
						"Discovery must find builder",
					);
					checks.push("builder discovered");
					return tool("add_task", { title: "Complete the local multiplayer example", description: "" });
				},
				(context) => {
					const task = result(context, "add_task");
					taskId = identifier(task.id);
					assert.equal(task.status, "open");
					checks.push("task created");
					return tool("message_peer", {
						peer: "builder",
						mode: "request",
						message: JSON.stringify({ taskId }),
						idempotencyKey: "example-request",
					});
				},
				(context) => {
					requestId = identifier(result(context, "message_peer").messageId);
					return fauxAssistantMessage("Task delegated; awaiting the builder's Bus response.");
				},
				(context) => {
					const message = delivery(context);
					assert.equal(message.from, "builder");
					assert.equal(message.to, "planner");
					assert.equal(message.mode, "response");
					assert.equal(message.responseTo, requestId);
					assert.deepEqual(object(JSON.parse(identifier(message.body))), { taskId, status: "done" });
					responseId = identifier(message.id);
					checks.push("reply sender, recipient, mode, responseTo and completed task verified");
					finished = true;
					return fauxAssistantMessage("Correlated builder response verified.");
				},
			]);
		} else {
			faux.setResponses([
				(context) => {
					const message = delivery(context);
					assert.equal(message.from, "planner");
					assert.equal(message.to, "builder");
					assert.equal(message.mode, "request");
					requestId = identifier(message.id);
					taskId = identifier(object(JSON.parse(identifier(message.body))).taskId);
					checks.push("task and request IDs extracted from delivered context");
					return tool("claim_task", { taskId });
				},
				(context) => {
					const task = result(context, "claim_task");
					assert.equal(task.id, taskId);
					assert.equal(task.status, "claimed");
					assert.equal(task.claimedBy, "builder");
					checks.push("task claimed by builder");
					return tool("complete_task", { taskId, note: "Completed by the deterministic builder" });
				},
				(context) => {
					const task = result(context, "complete_task");
					assert.equal(task.id, taskId);
					assert.equal(task.status, "done");
					assert.equal(task.claimedBy, "builder");
					checks.push("task completion verified");
					return tool("message_peer", {
						peer: "planner",
						mode: "response",
						responseTo: requestId,
						message: JSON.stringify({ taskId, status: task.status }),
						idempotencyKey: "example-response",
					});
				},
				(context) => {
					responseId = identifier(result(context, "message_peer").messageId);
					finished = true;
					return fauxAssistantMessage("Task completed and correlated response sent through the Bus.");
				},
			]);
		}

		session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			) {
				fail(new Error(event.message.errorMessage || "Worker turn failed"));
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
				assert(
					message.type === "start" && role === "planner" && !prompted,
					"Only planner may be prompted, exactly once",
				);
				prompted = true;
				void session!.prompt("Discover builder, delegate one task, and verify its correlated reply.").catch(fail);
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
		send({ type: "ready", role, pid: process.pid });
		while (!stopping) {
			if (finished && !sentEvidence && session.isIdle && settledTurns === (role === "planner" ? 2 : 1)) {
				const acknowledgedMessageIds: string[] = [];
				for (const entry of sessionManager.getBranch()) {
					if (entry.type !== "custom" || entry.customType !== "october-bus-delivery") continue;
					const record = object(entry.data);
					if (record.state !== "acknowledged") continue;
					assert(Array.isArray(record.messages), "Acknowledgement must identify its delivered messages");
					for (const message of record.messages) acknowledgedMessageIds.push(identifier(object(message).id));
				}
				if (acknowledgedMessageIds.includes(role === "planner" ? responseId : requestId)) {
					assert.equal(faux.getPendingResponseCount(), 0, "All scripted model steps must execute");
					const evidence: Evidence = {
						role,
						pid: process.pid,
						taskId,
						requestId,
						responseId,
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
