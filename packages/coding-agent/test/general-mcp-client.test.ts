import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { GenericMcpConnection } from "../src/extensions/mcp/client.ts";
import { createSecretRedactor, parseMcpServers } from "../src/extensions/mcp/config.ts";
import { mapMcpContent, mcpToolName } from "../src/extensions/mcp/index.ts";
import { classifyTool } from "../src/extensions/october/permissions.ts";

type McpHttpRequest = Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
type McpHttpResponse = Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];

const openConnections: GenericMcpConnection[] = [];
const openServers: HttpServer[] = [];

afterEach(async () => {
	await Promise.allSettled(openConnections.splice(0).map((connection) => connection.close()));
	await Promise.all(
		openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

function fakeServer(): Server {
	const server = new Server({ name: "october-mcp-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{
				name: "echo",
				description: "Echo synthetic text",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, (request) => ({
		content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }],
	}));
	return server;
}

// Regression coverage for October Harness issue #8.
describe("general MCP client extension", () => {
	it("validates settings without including credential values in errors", () => {
		expect(() => parseMcpServers({ unsafe: { transport: "http", url: "file:///secret" } })).toThrow(
			"must use http or https",
		);
		const servers = parseMcpServers({
			private: {
				transport: "http",
				url: "https://example.invalid/mcp",
				headers: { Authorization: "Bearer synthetic-secret" },
			},
		});
		const redact = createSecretRedactor(servers);
		expect(redact("authorization: Bearer synthetic-secret token=abc123")).toBe(
			"authorization=[REDACTED] token=[REDACTED]",
		);
		expect(redact("Invalid credential synthetic-secret")).toBe("Invalid credential [REDACTED]");
	});

	it("namespaces tools deterministically so normalized collisions are detectable", () => {
		expect(mcpToolName("Issue Tracker", "find/issues")).toBe("mcp__issue_tracker__find_issues");
		expect(mcpToolName("issue-tracker", "Find Issues")).toBe("mcp__issue-tracker__find_issues");
		expect(mcpToolName("A B", "run")).toBe(mcpToolName("a_b", "run"));
		expect(classifyTool(mcpToolName("Issue Tracker", "find/issues"))).toBe("command");
		const longName = mcpToolName("a".repeat(100), "b".repeat(100));
		expect(longName).toHaveLength(64);
		expect(longName).toBe(mcpToolName("a".repeat(100), "b".repeat(100)));
		expect(longName).not.toBe(mcpToolName("a".repeat(100), `${"b".repeat(99)}c`));
	});

	it("renders embedded and unsupported result content explicitly", () => {
		expect(
			mapMcpContent({
				content: [{ type: "resource", uri: "fixture://guide", text: "embedded guidance" }],
				isError: false,
			}),
		).toEqual([{ type: "text", text: "MCP resource fixture://guide:\nembedded guidance" }]);
		expect(mapMcpContent({ content: [{ type: "unsupported", contentType: "audio" }], isError: false })).toEqual([
			{ type: "text", text: "MCP returned unsupported audio content." },
		]);
	});

	it("bounds initialization when the initialized notification stalls", async () => {
		const httpServer = createServer((request, response) => {
			let rawBody = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				rawBody += chunk;
			});
			request.on("end", () => {
				const message = JSON.parse(rawBody) as {
					id?: string | number;
					method?: string;
					params?: { protocolVersion?: string };
				};
				if (message.method === "initialize") {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: message.params?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "stalled-fixture", version: "1.0.0" },
							},
						}),
					);
					return;
				}
				if (message.method !== "notifications/initialized") {
					response.writeHead(500).end();
				}
			});
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		openServers.push(httpServer);
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
		const connection = new GenericMcpConnection("stalled-http", {
			transport: "http",
			url: `http://127.0.0.1:${address.port}/mcp`,
			timeoutMs: 100,
		});
		openConnections.push(connection);

		await expect(connection.connect()).rejects.toThrow("timed out after 100ms");
	});

	it("discovers, calls, cancels, and closes a stdio server", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/general-mcp-stdio-server.mjs", import.meta.url));
		const connection = new GenericMcpConnection("stdio-test", {
			transport: "stdio",
			command: process.execPath,
			args: [fixture],
			timeoutMs: 2_000,
		});
		openConnections.push(connection);
		const tools = await connection.connect();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "wait"]);
		const result = await connection.callTool("echo", { text: "synthetic" });
		expect(result.content).toEqual([{ type: "text", text: "synthetic" }]);

		const controller = new AbortController();
		const waiting = connection.callTool("wait", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow(/abort/iu);
		await connection.close();
		openConnections.splice(openConnections.indexOf(connection), 1);
	});

	it("uses Streamable HTTP with configured headers", async () => {
		const app = createMcpExpressApp();
		app.post("/mcp", async (request: McpHttpRequest, response: McpHttpResponse) => {
			if (request.headers.authorization !== "Bearer synthetic-http-token") {
				response.writeHead(401).end();
				return;
			}
			const server = fakeServer();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await server.connect(transport);
			const body = "body" in request ? (request as { body?: unknown }).body : undefined;
			await transport.handleRequest(request, response, body);
			response.on("close", () => {
				void transport.close();
				void server.close();
			});
		});
		const httpServer = await new Promise<HttpServer>((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});
		openServers.push(httpServer);
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");

		const connection = new GenericMcpConnection("http-test", {
			transport: "http",
			url: `http://127.0.0.1:${address.port}/mcp`,
			headers: { Authorization: "Bearer synthetic-http-token" },
			timeoutMs: 2_000,
		});
		openConnections.push(connection);
		const tools = await connection.connect();
		expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
		const result = await connection.callTool("echo", { text: "over-http" });
		expect(result.content).toEqual([{ type: "text", text: "over-http" }]);
	});

	it("terminates a stateful HTTP session before closing", async () => {
		const app = createMcpExpressApp();
		const server = fakeServer();
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "synthetic-session" });
		await server.connect(transport);
		let deleteRequests = 0;
		app.all("/mcp", async (request: McpHttpRequest, response: McpHttpResponse) => {
			if (request.method === "DELETE") deleteRequests++;
			const body = "body" in request ? (request as { body?: unknown }).body : undefined;
			await transport.handleRequest(request, response, body);
		});
		const httpServer = await new Promise<HttpServer>((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});
		openServers.push(httpServer);
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
		const connection = new GenericMcpConnection("stateful-http", {
			transport: "http",
			url: `http://127.0.0.1:${address.port}/mcp`,
			timeoutMs: 2_000,
		});
		openConnections.push(connection);

		await connection.connect();
		await connection.close();
		expect(deleteRequests).toBe(1);
		openConnections.splice(openConnections.indexOf(connection), 1);
		await transport.close();
		await server.close();
	});
});
