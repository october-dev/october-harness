import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for the October Bus MCP endpoint, so Bus scenarios need no daemon. It answers the
 * MCP handshake, lists the scenario's tools, and records every `tools/call` for checks to inspect.
 */

export type ScenarioBusTool = { name: string; description?: string; result?: string };
export type ScenarioBusCall = { name: string; arguments: Record<string, unknown> };

export type ScenarioBus = {
	port: number;
	calls: ScenarioBusCall[];
	close: () => Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

function reply(response: ServerResponse, id: unknown, result: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

export async function startScenarioBus(tools: ScenarioBusTool[]): Promise<ScenarioBus> {
	const calls: ScenarioBusCall[] = [];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(await readBody(request)) as {
			id?: unknown;
			method?: string;
			params?: { name?: string; arguments?: Record<string, unknown> };
		};
		switch (body.method) {
			case "initialize":
				reply(response, body.id, {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "scenario-bus", version: "1" },
				});
				return;
			case "notifications/initialized":
				response.writeHead(202).end();
				return;
			case "tools/list":
				reply(response, body.id, {
					tools: tools.map(({ name, description }) => ({
						name,
						description: description ?? name,
						inputSchema: { type: "object", additionalProperties: true },
					})),
				});
				return;
			case "tools/call": {
				const name = body.params?.name ?? "";
				calls.push({ name, arguments: body.params?.arguments ?? {} });
				const tool = byName.get(name);
				reply(response, body.id, {
					content: [{ type: "text", text: tool ? (tool.result ?? "{}") : `Unknown Bus tool: ${name}` }],
					isError: !tool,
				});
				return;
			}
			default:
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } }));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		port: (server.address() as AddressInfo).port,
		calls,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
