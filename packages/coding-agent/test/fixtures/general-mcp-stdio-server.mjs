import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "october-mcp-stdio-fixture", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

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
		{
			name: "wait",
			description: "Wait for cancellation",
			inputSchema: { type: "object", properties: {} },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "wait") {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	const text = request.params.arguments?.text;
	return {
		content: [{ type: "text", text: typeof text === "string" ? text : "waited" }],
	};
});

await server.connect(new StdioServerTransport());
