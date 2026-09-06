import { VERSION } from "../../../config.ts";
import type { OctoberBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";
import { readBusResponse } from "./response.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_TOOL_PREFIX = "mcp__october-bus__";

const INIT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_PAGES = 100;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
	structuredContent?: unknown;
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
			const parsed: unknown = JSON.parse(raw);
			if (isResponse(parsed)) messages.push(parsed);
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

function isResponse(value: unknown): value is JsonRpcSuccess {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as JsonRpcSuccess;
	if (message.jsonrpc !== "2.0") return false;
	if ("result" in message === "error" in message) return false;
	return (
		!("error" in message) ||
		(!!message.error && typeof message.error === "object" && typeof message.error.message === "string")
	);
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
		let pages = 0;
		do {
			if (++pages > MAX_TOOL_PAGES) {
				return { ok: false, error: `MCP tools/list exceeded ${MAX_TOOL_PAGES} pages` };
			}
			const params = cursor ? { cursor } : {};
			const result = await this.rpc<{ tools?: unknown; nextCursor?: unknown }>(
				"tools/list",
				params,
				INIT_TIMEOUT_MS,
				signal,
			);
			if (!result.ok) return result;
			const batch = result.value.tools;
			if (!Array.isArray(batch)) return { ok: false, error: "MCP tools/list: malformed tools" };
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
		// Early protocol 0.1 builds exposed incompatible task shapes through MCP.
		// The public HTTP route lets this client normalize both shapes at one boundary.
		if (this.env.transport === "public" && name === "add_task") {
			return this.callPublicAddTask(args, signal);
		}
		const ready = await this.ensureInitialized(signal);
		if (!ready.ok) return ready;

		const result = await this.rpc<{ content?: unknown; isError?: unknown; structuredContent?: unknown }>(
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
				...(result.value.structuredContent === undefined
					? {}
					: { structuredContent: result.value.structuredContent }),
			},
		};
	}

	private async callPublicAddTask(
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpResult<McpToolCallResult>> {
		if (this.env.transport !== "public") return { ok: false, error: "Public Bus configuration is required" };
		try {
			const attempts = [args];
			if (typeof args.title === "string") {
				const description = typeof args.description === "string" ? args.description.trim() : "";
				const legacyArgs = { ...args };
				delete legacyArgs.title;
				legacyArgs.description = description ? `${args.title}\n\n${description}` : args.title;
				attempts.push(legacyArgs);
			}
			for (let index = 0; index < attempts.length; index++) {
				const response = await fetch(`${this.env.address}/v1/tasks`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.env.agentToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(attempts[index]),
					redirect: "error",
					signal: combineSignals(CALL_TIMEOUT_MS, signal),
				});
				const body = await readBusResponse(response, MAX_RESPONSE_BYTES);
				const parsed: unknown = body.trim() ? JSON.parse(body) : undefined;
				const message =
					parsed &&
					typeof parsed === "object" &&
					"error" in parsed &&
					parsed.error &&
					typeof parsed.error === "object" &&
					"message" in parsed.error &&
					typeof parsed.error.message === "string"
						? parsed.error.message
						: `HTTP ${response.status}`;
				if (!response.ok) {
					if (index === 0 && response.status === 400 && message.includes('unknown field "title"')) continue;
					return { ok: false, error: `October Bus add_task: ${message}` };
				}
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("result" in parsed) ||
					!parsed.result ||
					typeof parsed.result !== "object"
				) {
					return { ok: false, error: "October Bus add_task: malformed response" };
				}
				const result =
					!("title" in parsed.result) && typeof args.title === "string"
						? { ...parsed.result, title: args.title }
						: parsed.result;
				return {
					ok: true,
					value: {
						content: [{ type: "text", text: JSON.stringify(result) }],
						isError: false,
						structuredContent: result,
					},
				};
			}
			return { ok: false, error: "October Bus add_task: no compatible task shape" };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	private async ensureInitialized(signal?: AbortSignal): Promise<McpResult<void>> {
		if (this.initialized) return { ok: true, value: undefined };

		const result = await this.rpc<{ protocolVersion?: unknown }>(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "october", version: VERSION },
			},
			INIT_TIMEOUT_MS,
			signal,
		);
		if (!result.ok) return result;
		if (result.value.protocolVersion !== MCP_PROTOCOL_VERSION) {
			return { ok: false, error: "MCP initialize: unsupported protocol version" };
		}

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
		const response = await this.post(payload, timeoutMs, signal, id);
		if (!response.ok) return response;

		const message = this.selectMessage(response.value.messages, id);
		if (!message) {
			return { ok: false, error: `MCP ${method}: no matching JSON-RPC response` };
		}
		if (message.error) {
			return { ok: false, error: message.error.message ?? `MCP ${method} error ${message.error.code ?? ""}`.trim() };
		}
		if (message.result === null || typeof message.result !== "object") {
			return { ok: false, error: `MCP ${method}: malformed result` };
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
		return messages.find((message) => message.id === id);
	}

	private async post(
		payload: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		id?: number,
	): Promise<McpResult<{ messages: JsonRpcSuccess[] }>> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			};
			if (this.env.transport === "public") {
				headers.Authorization = `Bearer ${this.env.agentToken}`;
			} else {
				headers["X-October-Canvas"] = this.env.canvas;
				headers["X-October-Node"] = this.env.node;
				if (this.env.capability) headers["X-October-MCP-Capability"] = this.env.capability;
			}
			if (this.initialized) headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
			if (this.sessionId) {
				headers["Mcp-Session-Id"] = this.sessionId;
			}

			const url = this.env.transport === "public" ? this.env.mcpUrl : octoberBusUrl(this.env, "/mcp");
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				redirect: "error",
				signal: combineSignals(timeoutMs, signal),
			});

			const contentType = response.headers.get("content-type") ?? "";
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 404) {
					this.initialized = false;
					this.sessionId = undefined;
				}
				return { ok: false, error: `MCP HTTP ${response.status}` };
			}
			const sse = contentType.includes("text/event-stream");
			const body = await readBusResponse(
				response,
				MAX_RESPONSE_BYTES,
				sse && id !== undefined
					? (text) => {
							const boundary = Math.max(text.lastIndexOf("\n\n") + 2, text.lastIndexOf("\r\n\r\n") + 4);
							return parseSseMessages(text.slice(0, boundary)).some((message) => message.id === id);
						}
					: undefined,
			);

			const parsed: unknown = !sse && body.trim() ? JSON.parse(body) : undefined;
			const messages = sse ? parseSseMessages(body) : isResponse(parsed) ? [parsed] : [];
			const issued = response.headers.get("mcp-session-id");
			if (issued && id !== undefined && messages.some((message) => message.id === id && message.result))
				this.sessionId = issued;
			return { ok: true, value: { messages } };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
}
