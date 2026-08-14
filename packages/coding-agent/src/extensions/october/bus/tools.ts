import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import type { OctoberBusEnv } from "./env.ts";
import { logOctoberDebug } from "./log.ts";
import { MCP_TOOL_PREFIX, type McpContentPart, type McpToolDefinition, OctoberMcpClient } from "./mcp-client.ts";

const RETRY_MS = 5_000;

function schemaFor(tool: McpToolDefinition) {
	const schema = tool.inputSchema;
	if (schema && typeof schema === "object") {
		return Type.Unsafe(schema);
	}
	return Type.Object({});
}

function mapContent(parts: McpContentPart[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const part of parts) {
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "" });
	}
	return content;
}

function textFromParts(parts: McpContentPart[]): string {
	return parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function registerTools(pi: ExtensionAPI, client: OctoberMcpClient, tools: McpToolDefinition[]): void {
	for (const tool of tools) {
		const rawName = tool.name;
		pi.registerTool({
			name: `${MCP_TOOL_PREFIX}${rawName}`,
			label: rawName,
			description: tool.description ?? rawName,
			parameters: schemaFor(tool),
			async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ mcpName: string }>> {
				const result = await client.callTool(rawName, params as Record<string, unknown>, signal);
				if (!result.ok) {
					throw new Error(result.error);
				}
				if (result.value.isError) {
					throw new Error(textFromParts(result.value.content) || `MCP tool ${rawName} failed`);
				}
				return {
					content: mapContent(result.value.content),
					details: { mcpName: rawName },
				};
			},
		});
	}
}

export async function registerOctoberBusTools(pi: ExtensionAPI, env: OctoberBusEnv): Promise<void> {
	const client = new OctoberMcpClient(env);
	let listed: Awaited<ReturnType<OctoberMcpClient["listTools"]>>;
	try {
		listed = await client.listTools();
	} catch (error) {
		// Never let bus-tool discovery discard the provider/permissions/hooks already registered.
		listed = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (listed.ok) {
		registerTools(pi, client, listed.value);
		return;
	}

	logOctoberDebug(`october-bus mcp unavailable: ${listed.error}`);
	const timer = setTimeout(() => {
		void (async () => {
			try {
				const retry = await client.listTools();
				if (!retry.ok) return;
				registerTools(pi, client, retry.value);
			} catch (error) {
				// The session (or an unreachable October) must never crash the process.
				logOctoberDebug(`october-bus mcp retry failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}, RETRY_MS);
	timer.unref();
}
