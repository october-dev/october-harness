import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { GenericMcpConnection, type GenericMcpToolResult } from "./client.ts";
import { createSecretRedactor, parseMcpServers } from "./config.ts";

interface CandidateTool {
	registeredName: string;
	serverName: string;
	remoteName: string;
	description: string;
	inputSchema: unknown;
	connection: GenericMcpConnection;
}

function segment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gu, "_")
			.replace(/^_+|_+$/gu, "") || "unnamed"
	);
}

export function mcpToolName(serverName: string, remoteName: string): string {
	const fullName = `mcp__${segment(serverName)}__${segment(remoteName)}`;
	if (fullName.length <= 64) return fullName;
	const suffix = createHash("sha256").update(fullName).digest("hex").slice(0, 12);
	return `${fullName.slice(0, 50)}__${suffix}`;
}

function resultText(result: GenericMcpToolResult): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function schemaFor(value: unknown): TSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? Type.Unsafe(value) : Type.Object({});
}

export function mapMcpContent(result: GenericMcpToolResult): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const part of result.content) {
		if (part.type === "text") {
			content.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		if (part.type === "resource") {
			if (part.text !== undefined) {
				content.push({ type: "text", text: `MCP resource ${part.uri}:\n${part.text}` });
			} else {
				const mediaType = part.mimeType ? ` (${part.mimeType})` : "";
				content.push({
					type: "text",
					text: `MCP resource ${part.uri}${mediaType} contains binary content that October cannot render.`,
				});
			}
		}
		if (part.type === "resource_link") {
			const label = part.name ?? "MCP resource";
			const description = part.description ? ` — ${part.description}` : "";
			content.push({ type: "text", text: `${label}: ${part.uri}${description}` });
		}
		if (part.type === "unsupported") {
			content.push({ type: "text", text: `MCP returned unsupported ${part.contentType} content.` });
		}
	}
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return content;
}

export function mcpServersFromContext(ctx: Pick<ExtensionContext, "settings">): ReturnType<typeof parseMcpServers> {
	return parseMcpServers(ctx.settings.mcpServers);
}

export default function generalMcpExtension(pi: ExtensionAPI): void {
	let status = "not initialized";
	let connections: GenericMcpConnection[] = [];
	let redact = (message: string): string => message;

	pi.registerCommand("mcp", {
		description: "Show third-party MCP connection and tool discovery status",
		handler: async (args, ctx) => {
			if (args.trim() && args.trim() !== "status") {
				ctx.ui.notify("Usage: /mcp status", "warning");
				return;
			}
			ctx.ui.notify(status, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		let servers: ReturnType<typeof parseMcpServers>;
		try {
			servers = mcpServersFromContext(ctx);
		} catch (error) {
			status = `MCP configuration error: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(status, "error");
			return;
		}
		if (servers.size === 0) {
			status = "No third-party MCP servers configured.";
			return;
		}

		redact = createSecretRedactor(servers);
		const attempts = await Promise.all(
			[...servers].map(async ([name, server]) => {
				const connection = new GenericMcpConnection(name, server);
				try {
					const tools = await connection.connect(ctx.signal);
					return { name, connection, tools };
				} catch (error) {
					await connection.close().catch(() => {});
					return { name, error: redact(error instanceof Error ? error.message : String(error)) };
				}
			}),
		);

		const candidates: CandidateTool[] = [];
		const failures: string[] = [];
		for (const attempt of attempts) {
			if ("error" in attempt) {
				failures.push(`${attempt.name}: ${attempt.error}`);
				continue;
			}
			connections.push(attempt.connection);
			for (const tool of attempt.tools) {
				candidates.push({
					registeredName: mcpToolName(attempt.name, tool.name),
					serverName: attempt.name,
					remoteName: tool.name,
					description: tool.description ?? tool.name,
					inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
					connection: attempt.connection,
				});
			}
		}

		const names = new Map<string, string>();
		const collisions: string[] = [];
		for (const tool of candidates) {
			const owner = `${tool.serverName}:${tool.remoteName}`;
			const previous = names.get(tool.registeredName);
			if (previous) collisions.push(`${tool.registeredName} (${previous}, ${owner})`);
			else names.set(tool.registeredName, owner);
		}
		const existing = new Set(pi.getAllTools().map((tool) => tool.name));
		for (const tool of candidates) {
			if (existing.has(tool.registeredName)) collisions.push(`${tool.registeredName} (already registered)`);
		}
		if (collisions.length > 0) {
			await Promise.allSettled(connections.map((connection) => connection.close()));
			connections = [];
			status = `MCP tool registration blocked by collisions: ${collisions.join("; ")}`;
			ctx.ui.notify(status, "error");
			return;
		}

		for (const tool of candidates) {
			pi.registerTool({
				name: tool.registeredName,
				label: `${tool.serverName}: ${tool.remoteName}`,
				description: tool.description,
				parameters: schemaFor(tool.inputSchema),
				async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ server: string; tool: string }>> {
					try {
						const result = await tool.connection.callTool(
							tool.remoteName,
							params as Record<string, unknown>,
							signal,
						);
						if (result.isError) throw new Error(resultText(result) || "MCP tool returned an error");
						return {
							content: mapMcpContent(result),
							details: { server: tool.serverName, tool: tool.remoteName },
						};
					} catch (error) {
						throw new Error(redact(error instanceof Error ? error.message : String(error)));
					}
				},
			});
		}

		const connected = connections.map((connection) => connection.name).join(", ");
		status = `${candidates.length} tools from ${connections.length} servers (${connected}).`;
		if (failures.length > 0) status += ` Unavailable: ${failures.join("; ")}`;
	});

	pi.on("session_shutdown", async () => {
		const active = connections;
		connections = [];
		await Promise.allSettled(active.map((connection) => connection.close()));
	});
}
