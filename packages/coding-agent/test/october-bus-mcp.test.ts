import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { type OctoberBusEnv, parseOctoberBusEnv } from "../src/extensions/october/bus/env.ts";
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
	"OCTOBER_BUS_ADDRESS",
	"OCTOBER_BUS_MCP_URL",
	"OCTOBER_BUS_AGENT_ID",
	"OCTOBER_BUS_EXECUTION_ID",
	"OCTOBER_BUS_AGENT_TOKEN",
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
	vi.restoreAllMocks();
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
			transport: "desktop",
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
	// Issue #3: tools/list must aggregate pages and forward the server cursor.
	it("aggregates tools/list pages, forwards the cursor, and stops at an empty cursor", async () => {
		const requests: RecordedRequest[] = [];
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (body.method === "initialize") {
				writeJson(
					response,
					{ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
					{ "mcp-session-id": "sess-1" },
				);
				return;
			}
			if (body.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			if (body.method === "tools/list") {
				requests.push({ method: body.method, headers: request.headers, body });
				const params = body.params as { cursor?: string };
				const result =
					params.cursor === undefined
						? { tools: [{ name: "alpha" }], nextCursor: "c2" }
						: params.cursor === "c2"
							? { tools: [{ name: "beta" }], nextCursor: "" }
							: { tools: [] };
				writeJson(response, { jsonrpc: "2.0", id: body.id, result });
				return;
			}
			response.writeHead(404).end();
		});
		const env: OctoberBusEnv = {
			transport: "desktop",
			port,
			canvas: "canvas-1",
			node: "node-1",
			capability: "cap-1",
		};
		const listed = await new OctoberMcpClient(env).listTools();

		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
		expect(requests).toHaveLength(2);
		expect(requests[0].body.params).toEqual({});
		expect(requests[1].body.params).toEqual({ cursor: "c2" });
	});

	// Issue #3: unbounded discovery must stop at the client page limit.
	it("rejects tools/list pagination after exactly 100 requests", async () => {
		let listRequests = 0;
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (body.method === "initialize") {
				writeJson(
					response,
					{ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
					{ "mcp-session-id": "sess-1" },
				);
				return;
			}
			if (body.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			if (body.method === "tools/list") {
				listRequests += 1;
				writeJson(response, { jsonrpc: "2.0", id: body.id, result: { tools: [], nextCursor: "more" } });
				return;
			}
			response.writeHead(404).end();
		});
		const env: OctoberBusEnv = {
			transport: "desktop",
			port,
			canvas: "canvas-1",
			node: "node-1",
			capability: "cap-1",
		};

		expect(await new OctoberMcpClient(env).listTools()).toEqual({
			ok: false,
			error: "MCP tools/list exceeded 100 pages",
		});
		expect(listRequests).toBe(100);
	});

	// Issue #3: each RPC must wire its own internal deadline and preserve the abort reason.
	it.each(["tools/list", "tools/call"] as const)(
		"wires a fresh internal deadline for %s and preserves its timeout error",
		async (method) => {
			const requests: unknown[] = [];
			const deadlines: { method: string; controller: AbortController }[] = [];
			let deadlineMethod = "initialize";
			let recordArrival!: () => void;
			const arrived = new Promise<void>((resolve) => {
				recordArrival = resolve;
			});
			const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
				const controller = new AbortController();
				deadlines.push({ method: deadlineMethod, controller });
				return controller.signal;
			});
			try {
				const { port } = await listen(async (request, response) => {
					const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
					requests.push(body.method);
					if (body.method === "initialize") {
						deadlineMethod = "notifications/initialized";
						writeJson(
							response,
							{ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
							{ "mcp-session-id": "sess-1" },
						);
						return;
					}
					if (body.method === "notifications/initialized") {
						deadlineMethod = method;
						response.writeHead(202).end();
						return;
					}
					if (body.method === method) {
						recordArrival();
						return;
					}
					response.writeHead(404).end();
				});
				const env: OctoberBusEnv = {
					transport: "desktop",
					port,
					canvas: "canvas-1",
					node: "node-1",
					capability: "cap-1",
				};
				const client = new OctoberMcpClient(env);
				const result = method === "tools/list" ? client.listTools() : client.callTool("echo", { message: "hi" });
				await arrived;

				expect(requests).toEqual(["initialize", "notifications/initialized", method]);
				// Fail before awaiting the hung RPC if it reused an initialization deadline or omitted its own.
				expect(deadlines.map((deadline) => deadline.method)).toEqual(requests);
				deadlines[2].controller.abort(new DOMException("The operation timed out", "TimeoutError"));
				expect(await result).toEqual({ ok: false, error: "The operation timed out" });
			} finally {
				timeout.mockRestore();
			}
		},
	);

	// Issue #3: an expired session must be cleared before the next call initializes again.
	it("reinitializes after a session HTTP 404 on the next call without retrying the failed call", async () => {
		const requests: RecordedRequest[] = [];
		let initializations = 0;
		let calls = 0;
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			requests.push({ method: body.method, headers: request.headers, body });
			if (body.method === "initialize") {
				initializations += 1;
				writeJson(
					response,
					{ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
					{ "mcp-session-id": `s${initializations}` },
				);
				return;
			}
			if (body.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			if (body.method === "tools/call") {
				calls += 1;
				if (calls === 1) {
					response.writeHead(404).end();
					return;
				}
				writeJson(response, {
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: "recovered" }], isError: false },
				});
				return;
			}
			response.writeHead(404).end();
		});
		const env: OctoberBusEnv = {
			transport: "desktop",
			port,
			canvas: "canvas-1",
			node: "node-1",
			capability: "cap-1",
		};
		const client = new OctoberMcpClient(env);

		expect(await client.callTool("echo", { message: "first" })).toEqual({ ok: false, error: "MCP HTTP 404" });
		expect(calls).toBe(1);
		expect(requests.map((request) => request.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect(requests[2].headers["mcp-session-id"]).toBe("s1");

		expect(await client.callTool("echo", { message: "second" })).toEqual({
			ok: true,
			value: { content: [{ type: "text", text: "recovered" }], isError: false },
		});
		expect(requests.map((request) => request.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/call",
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect(requests[3].headers["mcp-session-id"]).toBeUndefined();
		expect(requests[3].headers["mcp-protocol-version"]).toBeUndefined();
		expect(requests[5].headers["mcp-session-id"]).toBe("s2");
		expect(requests[5].headers["mcp-protocol-version"]).toBe("2025-03-26");
	});

	it.each([null, 1, {}, { jsonrpc: "2.0", id: 999999, result: {} }, { jsonrpc: "1.0", id: 1, result: {} }])(
		"rejects invalid or mismatched responses: %j",
		async (payload) => {
			const { port } = await listen((_request, response) => writeJson(response, payload));
			setBusEnv(port);
			expect((await new OctoberMcpClient(parseOctoberBusEnv()!).listTools()).ok).toBe(false);
		},
	);

	it("rejects HTTP failures even when the body contains a matching result", async () => {
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as { id: number };
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }));
		});
		setBusEnv(port);
		expect(await new OctoberMcpClient(parseOctoberBusEnv()!).listTools()).toEqual({
			ok: false,
			error: "MCP HTTP 500",
		});
	});

	it("rejects oversized chunked responses", async () => {
		const { port } = await listen((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(" ".repeat(8 * 1024 * 1024 + 1));
		});
		setBusEnv(port);
		const result = await new OctoberMcpClient(parseOctoberBusEnv()!).listTools();
		expect(result).toEqual({ ok: false, error: expect.stringContaining("exceeds") });
	});

	it.each(["\n", "\r\n"])("finishes SSE requests without waiting for EOF (separator=%j)", async (newline) => {
		const { port } = await listen(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as { id?: number; method: string };
			if (!body.id) {
				response.writeHead(202).end();
				return;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [] };
			response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}${newline}${newline}`);
			response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}${newline}${newline}`);
		});
		setBusEnv(port);
		expect(await new OctoberMcpClient(parseOctoberBusEnv()!).listTools(AbortSignal.timeout(1000))).toEqual({
			ok: true,
			value: [],
		});
	});

	it("automatically attaches public launcher identities with bearer auth and native lifecycle", async () => {
		const stub = await startStubBus().ready;
		process.env.OCTOBER_BUS_ADDRESS = `http://127.0.0.1:${stub.port}`;
		process.env.OCTOBER_BUS_MCP_URL = `http://127.0.0.1:${stub.port}/mcp`;
		process.env.OCTOBER_BUS_AGENT_ID = "reviewer";
		process.env.OCTOBER_BUS_EXECUTION_ID = "exec-1";
		process.env.OCTOBER_BUS_AGENT_TOKEN = "public-secret";
		const harness = await createHarness({ extensionFactories: [octoberExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(`${MCP_TOOL_PREFIX}echo`, { message: "public" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(harness.session.messages.some((message) => message.role === "toolResult" && !message.isError)).toBe(true);
		expect(stub.hits.count).toBeGreaterThan(stub.requests.length);
		for (const request of stub.requests) {
			expect(request.headers.authorization).toBe("Bearer public-secret");
			expect(request.headers["x-october-node"]).toBeUndefined();
		}
		const context = harness.session.messages.filter((message) => message.role === "custom");
		expect(JSON.stringify(context)).toContain("reviewer");
		expect(JSON.stringify(context)).not.toContain("public-secret");
	});

	it("rejects partial public configuration, cross-origin MCP URLs and plaintext remote tokens", () => {
		const env = {
			OCTOBER_BUS_ADDRESS: "http://127.0.0.1:4765",
			OCTOBER_BUS_MCP_URL: "http://127.0.0.1:4765/mcp",
			OCTOBER_BUS_AGENT_ID: "a",
			OCTOBER_BUS_EXECUTION_ID: "e",
			OCTOBER_BUS_AGENT_TOKEN: "secret",
		};
		expect(parseOctoberBusEnv(env)?.transport).toBe("public");
		expect(parseOctoberBusEnv({ ...env, OCTOBER_BUS_AGENT_TOKEN: undefined })).toBeUndefined();
		expect(parseOctoberBusEnv({ ...env, OCTOBER_BUS_MCP_URL: "https://other.example/mcp" })).toBeUndefined();
		expect(
			parseOctoberBusEnv({
				...env,
				OCTOBER_BUS_ADDRESS: "http://remote.example",
				OCTOBER_BUS_MCP_URL: "http://remote.example/mcp",
			}),
		).toBeUndefined();
	});
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
