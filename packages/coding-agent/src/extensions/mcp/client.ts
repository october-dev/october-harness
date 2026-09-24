import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VERSION } from "../../config.ts";
import type { McpServerSettings } from "../../core/settings-manager.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_PAGES = 100;

export interface DiscoveredMcpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export type GenericMcpContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; uri: string; text?: string; blob?: string; mimeType?: string }
	| { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
	| { type: "unsupported"; contentType: string };

export interface GenericMcpToolResult {
	content: GenericMcpContentPart[];
	isError: boolean;
	structuredContent?: unknown;
}

export class GenericMcpConnection {
	private readonly client = new Client({ name: "october-general-mcp", version: VERSION });
	private transport: Transport | undefined;
	readonly name: string;
	private readonly settings: McpServerSettings;

	constructor(name: string, settings: McpServerSettings) {
		this.name = name;
		this.settings = settings;
	}

	async connect(signal?: AbortSignal): Promise<DiscoveredMcpTool[]> {
		this.transport = this.createTransport();
		const timeoutMs = this.settings.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const connectController = new AbortController();
		let rejectBoundary: (reason: Error) => void = () => {};
		const boundary = new Promise<never>((_resolve, reject) => {
			rejectBoundary = reject;
		});
		let boundaryClosed = false;
		const stopConnection = (reason: Error): void => {
			if (boundaryClosed) return;
			boundaryClosed = true;
			connectController.abort(reason);
			void this.client.close().catch(() => {});
			rejectBoundary(reason);
		};
		const onAbort = (): void => {
			const reason = signal?.reason;
			stopConnection(reason instanceof Error ? reason : new Error("MCP connection aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => stopConnection(new Error(`MCP connection timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		if (signal?.aborted) onAbort();
		try {
			await Promise.race([
				this.client.connect(this.transport, { signal: connectController.signal, timeout: timeoutMs }),
				boundary,
			]);
		} finally {
			boundaryClosed = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		const tools: DiscoveredMcpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const result = await this.client.listTools(cursor ? { cursor } : undefined, {
				signal,
				timeout: this.settings.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
			});
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					...(tool.description === undefined ? {} : { description: tool.description }),
					...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
				});
			}
			cursor = result.nextCursor;
			if (!cursor) return tools;
		}
		throw new Error(`tools/list exceeded ${MAX_TOOL_PAGES} pages`);
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<GenericMcpToolResult> {
		const result = await this.client.callTool({ name, arguments: args }, undefined, {
			signal,
			timeout: this.settings.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
		});
		if (!Array.isArray(result.content)) throw new Error("tools/call returned malformed content");
		const content: GenericMcpContentPart[] = [];
		for (const part of result.content) {
			if (!part || typeof part !== "object" || !("type" in part)) continue;
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				content.push({ type: "text", text: part.text });
				continue;
			}
			if (
				part.type === "image" &&
				"data" in part &&
				typeof part.data === "string" &&
				"mimeType" in part &&
				typeof part.mimeType === "string"
			) {
				content.push({ type: "image", data: part.data, mimeType: part.mimeType });
				continue;
			}
			if (part.type === "resource" && "resource" in part && part.resource && typeof part.resource === "object") {
				const resource = part.resource;
				if ("uri" in resource && typeof resource.uri === "string") {
					content.push({
						type: "resource",
						uri: resource.uri,
						...("text" in resource && typeof resource.text === "string" ? { text: resource.text } : {}),
						...("blob" in resource && typeof resource.blob === "string" ? { blob: resource.blob } : {}),
						...("mimeType" in resource && typeof resource.mimeType === "string"
							? { mimeType: resource.mimeType }
							: {}),
					});
					continue;
				}
			}
			if (part.type === "resource_link" && "uri" in part && typeof part.uri === "string") {
				content.push({
					type: "resource_link",
					uri: part.uri,
					...("name" in part && typeof part.name === "string" ? { name: part.name } : {}),
					...("description" in part && typeof part.description === "string"
						? { description: part.description }
						: {}),
					...("mimeType" in part && typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
				});
				continue;
			}
			content.push({ type: "unsupported", contentType: typeof part.type === "string" ? part.type : "unknown" });
		}
		return {
			content,
			isError: result.isError === true,
			...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		};
	}

	async close(): Promise<void> {
		const transport = this.transport;
		if (transport instanceof StreamableHTTPClientTransport) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					transport.terminateSession(),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, this.settings.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
					}),
				]);
			} catch {
				// MCP servers may reject or omit DELETE session termination.
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		await this.client.close();
		this.transport = undefined;
	}

	private createTransport(): Transport {
		if (this.settings.transport === "stdio") {
			const transport = new StdioClientTransport({
				command: this.settings.command,
				...(this.settings.args === undefined ? {} : { args: this.settings.args }),
				env: { ...getDefaultEnvironment(), ...this.settings.env },
				...(this.settings.cwd === undefined ? {} : { cwd: this.settings.cwd }),
				stderr: "pipe",
			});
			// Drain server stderr without printing it: third-party servers may echo
			// credentials or authorization details in diagnostics.
			transport.stderr?.on("data", () => {});
			return transport;
		}
		return new StreamableHTTPClientTransport(new URL(this.settings.url), {
			requestInit: { headers: this.settings.headers },
		});
	}
}
