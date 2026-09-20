import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { GenericMcpConnection } from "../src/extensions/mcp/client.ts";
import { createSecretRedactor, parseMcpServers } from "../src/extensions/mcp/config.ts";
import { mcpToolName } from "../src/extensions/mcp/index.ts";
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
	});

	it("namespaces tools deterministically so normalized collisions are detectable", () => {
		expect(mcpToolName("Issue Tracker", "find/issues")).toBe("mcp__issue_tracker__find_issues");
		expect(mcpToolName("issue-tracker", "Find Issues")).toBe("mcp__issue-tracker__find_issues");
		expect(mcpToolName("A B", "run")).toBe(mcpToolName("a_b", "run"));
		expect(classifyTool(mcpToolName("Issue Tracker", "find/issues"))).toBe("command");
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
});
