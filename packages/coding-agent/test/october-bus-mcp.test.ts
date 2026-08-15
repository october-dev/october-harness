import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { parseOctoberBusEnv } from "../src/extensions/october/bus/env.ts";
import { MCP_TOOL_PREFIX, OctoberMcpClient } from "../src/extensions/october/bus/mcp-client.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const servers: Server[] = [];
const harnesses: Harness[] = [];

const BUS_ENV_KEYS = [
	"OCTOBER_BUS_PORT",
	"OCTOBER_BUS_CANVAS",
	"OCTOBER_BUS_NODE",
	"OCTOBER_BUS_MCP_CAPABILITY",
	"OCTOBER_BUS_TOKEN",
] as const;

interface RecordedRequest {
	method: unknown;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, value: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(200, { "Content-Type": "application/json", ...extraHeaders });
	response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, value: unknown): void {
	response.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	response.write(`id: evt-1\ndata: ${JSON.stringify(value)}\n\n`);
	response.end();
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; port: number; url: string; hits: { count: number } }> {
	const hits = { count: 0 };
	const server = createServer((request, response) => {
		hits.count += 1;
		void Promise.resolve(handler(request, response)).catch(() => {
			response.writeHead(500).end();
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, port: address.port, url: `http://127.0.0.1:${address.port}`, hits };
}

function setBusEnv(port: number): void {
	process.env.OCTOBER_BUS_PORT = String(port);
	process.env.OCTOBER_BUS_CANVAS = "canvas-1";
	process.env.OCTOBER_BUS_NODE = "node-1";
	process.env.OCTOBER_BUS_MCP_CAPABILITY = "cap-1";
	process.env.OCTOBER_BUS_TOKEN = "token-1";
}

function clearBusEnv(): void {
	for (const key of BUS_ENV_KEYS) {
		delete process.env[key];
	}
}

function startStubBus(options?: { sseCall?: boolean; callError?: boolean; dropCall?: boolean }): {
	ready: Promise<{ port: number; requests: RecordedRequest[]; hits: { count: number } }>;
} {
	const requests: RecordedRequest[] = [];
	const ready = listen(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
		requests.push({ method: body.method, headers: request.headers, body });

		if (body.method === "initialize") {
			writeJson(
				response,
				{
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "stub-bus" },
					},
				},
				{ "mcp-session-id": "sess-1" },
			);
			return;
		}
		if (body.method === "notifications/initialized") {
			response.writeHead(202).end();
			return;
		}
		if (body.method === "tools/list") {
			writeJson(response, {
				jsonrpc: "2.0",
				id: body.id,
				result: {
					tools: [
						{
							name: "echo",
							description: "Echo a message",
							inputSchema: {
								type: "object",
								properties: { message: { type: "string" } },
								required: ["message"],
							},
						},
					],
				},
			});
			return;
		}
		if (body.method === "tools/call") {
			if (options?.dropCall) {
				response.destroy();
				return;
			}
			const params = body.params as { name?: string; arguments?: { message?: string } };
			const result = {
				content: [{ type: "text", text: `echo:${params.arguments?.message ?? ""}` }],
				isError: options?.callError === true,
			};
			const payload = { jsonrpc: "2.0", id: body.id, result };
			if (options?.sseCall) {
				writeSse(response, payload);
				return;
			}
			writeJson(response, payload);
			return;
		}
		writeJson(response, { jsonrpc: "2.0", id: body.id, error: { message: "unknown method" } });
	}).then(({ port, hits }) => ({ port, requests, hits }));
	return { ready };
}

afterEach(async () => {
	clearBusEnv();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("october bus env gate", () => {
	it("is unset when any required variable is missing or malformed", () => {
		expect(parseOctoberBusEnv({})).toBeUndefined();
		expect(parseOctoberBusEnv({ OCTOBER_BUS_PORT: "9", OCTOBER_BUS_CANVAS: "c" })).toBeUndefined();
		expect(
			parseOctoberBusEnv({
				OCTOBER_BUS_PORT: "not-a-port",
				OCTOBER_BUS_CANVAS: "c",
				OCTOBER_BUS_NODE: "n",
			}),
		).toBeUndefined();
		expect(
			parseOctoberBusEnv({
				OCTOBER_BUS_PORT: "4377",
				OCTOBER_BUS_CANVAS: "c",
				OCTOBER_BUS_NODE: "n",
			}),
		).toEqual({
			port: 4377,
			canvas: "c",
			node: "n",
			launch: undefined,
			capability: undefined,
			token: undefined,
		});
	});
});

describe("october bus inertness", () => {
	it("performs zero network calls and registers no bus tools when env is unset", async () => {
		const { hits } = await listen((_request, response) => {
			response.writeHead(200).end();
		});
		clearBusEnv();

		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			octoberExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:october>",
		);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);

		expect(hits.count).toBe(0);
		expect([...extension.tools.keys()].filter((name) => name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
		expect(harness.session.getAllTools().filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
	});
});

describe("october bus MCP client", () => {
	it("lists prefixed tools, echoes the session id, and round-trips a call", async () => {
		const stub = await startStubBus().ready;
		setBusEnv(stub.port);
		const env = parseOctoberBusEnv();
		expect(env).toBeDefined();

		const client = new OctoberMcpClient(env!);
		const listed = await client.listTools();
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value.map((tool) => tool.name)).toEqual(["echo"]);

		const called = await client.callTool("echo", { message: "hi" });
		expect(called.ok).toBe(true);
		if (!called.ok) return;
		expect(called.value).toEqual({
			content: [{ type: "text", text: "echo:hi" }],
			isError: false,
		});

		expect(stub.requests.length).toBeGreaterThanOrEqual(4);
		for (const request of stub.requests) {
			expect(request.headers["x-october-canvas"]).toBe("canvas-1");
			expect(request.headers["x-october-node"]).toBe("node-1");
			expect(request.headers["x-october-mcp-capability"]).toBe("cap-1");
		}
		const afterInit = stub.requests.filter((request) => request.method !== "initialize");
		expect(afterInit.length).toBeGreaterThan(0);
		for (const request of afterInit) {
			expect(request.headers["mcp-session-id"]).toBe("sess-1");
		}
	});

	it("parses SSE-mode JSON-RPC responses", async () => {
		const stub = await startStubBus({ sseCall: true }).ready;
		setBusEnv(stub.port);
		const client = new OctoberMcpClient(parseOctoberBusEnv()!);
		const called = await client.callTool("echo", { message: "sse" });
		expect(called).toEqual({
			ok: true,
			value: { content: [{ type: "text", text: "echo:sse" }], isError: false },
		});
	});

	it("registers mcp__october-bus__ tools on the session and executes a call", async () => {
		const stub = await startStubBus().ready;
		setBusEnv(stub.port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);

		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(`${MCP_TOOL_PREFIX}echo`);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}echo`, { message: "roundtrip" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call echo");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role !== "toolResult") return;
		expect(toolResult.isError).toBeFalsy();
		expect(toolResult.content).toEqual([{ type: "text", text: "echo:roundtrip" }]);
	});

	it("constructs a session when the bus is down and returns a tool error for a failed call", async () => {
		const stub = await startStubBus({ dropCall: true }).ready;
		setBusEnv(stub.port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(`${MCP_TOOL_PREFIX}echo`);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}echo`, { message: "x" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text || "failed");
			},
		]);
		await harness.session.prompt("call echo");
		expect(harness.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("still constructs a session when env is set and nothing is listening", async () => {
		const { port, server } = await listen((_request, response) => {
			response.writeHead(200).end();
		});
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
		const index = servers.indexOf(server);
		if (index >= 0) servers.splice(index, 1);

		setBusEnv(port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		expect(harness.session.getAllTools().filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
	});

	it("returns a typed error (never throws) when tools/list has a null result", async () => {
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (body.method === "initialize") {
				writeJson(response, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
				return;
			}
			if (body.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			writeJson(response, { jsonrpc: "2.0", id: body.id, result: null });
		});
		setBusEnv(port);
		const client = new OctoberMcpClient(parseOctoberBusEnv()!);
		const listed = await client.listTools();
		expect(listed.ok).toBe(false);
	});

	it("keeps the October provider registered when bus tool discovery fails", async () => {
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (body.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			writeJson(response, { jsonrpc: "2.0", id: body.id, result: null });
		});
		setBusEnv(port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		// Malformed bus responses must not discard the earlier registrations or the session.
		expect(harness.session.getAllTools().filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
		expect(harness.session.getAllTools().length).toBeGreaterThan(0);
	});
});
