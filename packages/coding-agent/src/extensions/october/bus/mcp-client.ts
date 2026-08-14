import { VERSION } from "../../../config.ts";
import type { OctoberBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_TOOL_PREFIX = "mcp__october-bus__";

const INIT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpContentPart {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface McpToolCallResult {
	content: McpContentPart[];
	isError: boolean;
}

export type McpResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface JsonRpcSuccess {
	jsonrpc?: string;
	id?: string | number | null;
	result?: unknown;
	error?: { code?: number; message?: string };
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return external ? AbortSignal.any([timeout, external]) : timeout;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") {
			return error.message || "request timed out";
		}
		return error.message;
	}
	return String(error);
}

function parseSseMessages(body: string): JsonRpcSuccess[] {
	const messages: JsonRpcSuccess[] = [];
	const flush = (dataLines: string[]): void => {
		if (dataLines.length === 0) return;
		const raw = dataLines.join("\n");
		if (!raw || raw === "[DONE]") return;
		try {
			messages.push(JSON.parse(raw) as JsonRpcSuccess);
		} catch {
			// Ignore malformed SSE payloads.
		}
	};

	const dataLines: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).replace(/^\s/, ""));
			continue;
		}
		if (line === "") {
			flush(dataLines);
			dataLines.length = 0;
		}
	}
	flush(dataLines);
	return messages;
}

export class OctoberMcpClient {
	private readonly env: OctoberBusEnv;
	private nextId = 1;
	private sessionId: string | undefined;
	private initialized = false;

	constructor(env: OctoberBusEnv) {
		this.env = env;
	}

	async listTools(signal?: AbortSignal): Promise<McpResult<McpToolDefinition[]>> {
		const ready = await this.ensureInitialized(signal);
		if (!ready.ok) return ready;

		const tools: McpToolDefinition[] = [];
		let cursor: string | undefined;
		do {
			const params = cursor ? { cursor } : {};
			const result = await this.rpc<{ tools?: unknown; nextCursor?: unknown }>(
				"tools/list",
				params,
				INIT_TIMEOUT_MS,
				signal,
			);
			if (!result.ok) return result;
			const batch = result.value.tools;
			if (Array.isArray(batch)) {
				for (const entry of batch) {
					if (!entry || typeof entry !== "object") continue;
					const name = (entry as { name?: unknown }).name;
					if (typeof name !== "string" || name.length === 0) continue;
					const description = (entry as { description?: unknown }).description;
					tools.push({
						name,
						description: typeof description === "string" ? description : undefined,
						inputSchema: (entry as { inputSchema?: unknown }).inputSchema,
					});
				}
			}
			const next = result.value.nextCursor;
			cursor = typeof next === "string" && next.length > 0 ? next : undefined;
		} while (cursor);

		return { ok: true, value: tools };
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpResult<McpToolCallResult>> {
		const ready = await this.ensureInitialized(signal);
		if (!ready.ok) return ready;

		const result = await this.rpc<{ content?: unknown; isError?: unknown }>(
			"tools/call",
			{ name, arguments: args },
			CALL_TIMEOUT_MS,
			signal,
		);
		if (!result.ok) return result;

		const content = Array.isArray(result.value.content)
			? result.value.content.filter((part): part is McpContentPart => !!part && typeof part === "object")
			: [];
		return {
			ok: true,
			value: {
				content,
				isError: result.value.isError === true,
			},
		};
	}

	private async ensureInitialized(signal?: AbortSignal): Promise<McpResult<void>> {
		if (this.initialized) return { ok: true, value: undefined };

		const result = await this.rpc<unknown>(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "octo", version: VERSION },
			},
			INIT_TIMEOUT_MS,
			signal,
		);
		if (!result.ok) return result;

		const notified = await this.notify("notifications/initialized", INIT_TIMEOUT_MS, signal);
		if (!notified.ok) return notified;

		this.initialized = true;
		return { ok: true, value: undefined };
	}

	private async rpc<T>(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<McpResult<T>> {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params };
		const response = await this.post(payload, timeoutMs, signal);
		if (!response.ok) return response;

		const message = this.selectMessage(response.value.messages, id);
		if (!message) {
			return { ok: false, error: `MCP ${method}: no matching JSON-RPC response` };
		}
		if (message.error) {
			return { ok: false, error: message.error.message ?? `MCP ${method} error ${message.error.code ?? ""}`.trim() };
		}
		return { ok: true, value: message.result as T };
	}

	private async notify(method: string, timeoutMs: number, signal?: AbortSignal): Promise<McpResult<void>> {
		const payload = { jsonrpc: "2.0", method };
		const response = await this.post(payload, timeoutMs, signal);
		if (!response.ok) return response;
		return { ok: true, value: undefined };
	}

	private selectMessage(messages: JsonRpcSuccess[], id: number): JsonRpcSuccess | undefined {
		return (
			messages.find((message) => message.id === id) ??
			messages.find((message) => message.result !== undefined || message.error !== undefined)
		);
	}

	private async post(
		payload: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<McpResult<{ messages: JsonRpcSuccess[] }>> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"X-October-Canvas": this.env.canvas,
				"X-October-Node": this.env.node,
			};
			if (this.env.capability) {
				headers["X-October-MCP-Capability"] = this.env.capability;
			}
			if (this.sessionId) {
				headers["Mcp-Session-Id"] = this.sessionId;
			}

			const response = await fetch(octoberBusUrl(this.env, "/mcp"), {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: combineSignals(timeoutMs, signal),
			});

			const issued = response.headers.get("mcp-session-id");
			if (issued) this.sessionId = issued;

			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();
			if (!response.ok && body.trim().length === 0) {
				return { ok: false, error: `MCP HTTP ${response.status}` };
			}

			const messages = contentType.includes("text/event-stream")
				? parseSseMessages(body)
				: body.trim().length > 0
					? [JSON.parse(body) as JsonRpcSuccess]
					: [];
			return { ok: true, value: { messages } };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
}
