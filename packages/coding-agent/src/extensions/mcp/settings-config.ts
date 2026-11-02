import type { McpServerSettings } from "../../core/settings-manager.ts";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object of string values`);
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!key || typeof entry !== "string") throw new Error(`${field} must contain only string values`);
		output[key] = entry;
	}
	return output;
}

function timeout(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < MIN_TIMEOUT_MS || (value as number) > MAX_TIMEOUT_MS) {
		throw new Error(`${field} must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
	}
	return value as number;
}

function parseServer(name: string, value: unknown): McpServerSettings {
	if (!name.trim() || name.length > 100) throw new Error("MCP server names must contain 1-100 characters");
	if (!isRecord(value)) throw new Error(`mcpServers.${name} must be an object`);
	if (value.transport === "stdio") {
		if (typeof value.command !== "string" || !value.command.trim()) {
			throw new Error(`mcpServers.${name}.command must be a non-empty string`);
		}
		if (
			value.args !== undefined &&
			(!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))
		) {
			throw new Error(`mcpServers.${name}.args must be an array of strings`);
		}
		if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd.trim())) {
			throw new Error(`mcpServers.${name}.cwd must be a non-empty string`);
		}
		return {
			transport: "stdio",
			command: value.command,
			...(value.args === undefined ? {} : { args: [...value.args] as string[] }),
			...(value.env === undefined ? {} : { env: stringRecord(value.env, `mcpServers.${name}.env`) }),
			...(value.cwd === undefined ? {} : { cwd: value.cwd as string }),
			...(value.timeoutMs === undefined
				? {}
				: { timeoutMs: timeout(value.timeoutMs, `mcpServers.${name}.timeoutMs`) }),
		};
	}
	if (value.transport === "http") {
		if (typeof value.url !== "string") throw new Error(`mcpServers.${name}.url must be a URL string`);
		let parsed: URL;
		try {
			parsed = new URL(value.url);
		} catch {
			throw new Error(`mcpServers.${name}.url must be a valid URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`mcpServers.${name}.url must use http or https`);
		}
		return {
			transport: "http",
			url: parsed.toString(),
			...(value.headers === undefined ? {} : { headers: stringRecord(value.headers, `mcpServers.${name}.headers`) }),
			...(value.timeoutMs === undefined
				? {}
				: { timeoutMs: timeout(value.timeoutMs, `mcpServers.${name}.timeoutMs`) }),
		};
	}
	throw new Error(`mcpServers.${name}.transport must be "stdio" or "http"`);
}

export function parseMcpServers(value: unknown): Map<string, McpServerSettings> {
	if (value === undefined) return new Map();
	if (!isRecord(value)) throw new Error("mcpServers must be an object keyed by server name");
	return new Map(Object.entries(value).map(([name, config]) => [name, parseServer(name, config)]));
}

/** Redact configured environment/header values from transport and server errors. */
export function createSecretRedactor(servers: ReadonlyMap<string, McpServerSettings>): (message: string) => string {
	const secrets = new Set<string>();
	for (const server of servers.values()) {
		const values =
			server.transport === "stdio" ? Object.values(server.env ?? {}) : Object.values(server.headers ?? {});
		for (const value of values) {
			if (value.length >= 4) secrets.add(value);
			const bearer = /^Bearer\s+(\S+)$/iu.exec(value);
			if (bearer?.[1] && bearer[1].length >= 4) secrets.add(bearer[1]);
		}
	}
	return (message) => {
		let redacted = message;
		for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
		return redacted.replace(/(authorization|api[-_]?key|token)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
	};
}
