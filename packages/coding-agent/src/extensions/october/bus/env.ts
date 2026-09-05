export interface OctoberDesktopBusEnv {
	transport: "desktop";
	port: number;
	canvas: string;
	node: string;
	launch?: string;
	capability?: string;
	token?: string;
}

export interface OctoberPublicBusEnv {
	transport: "public";
	address: string;
	mcpUrl: string;
	agentId: string;
	executionId: string;
	agentToken: string;
}

export type OctoberBusEnv = OctoberDesktopBusEnv | OctoberPublicBusEnv;

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Public launcher variables select the public protocol. Partial/invalid public
 * configuration never falls back to Desktop and sends credentials elsewhere.
 */
export function parseOctoberBusEnv(env: NodeJS.ProcessEnv = process.env): OctoberBusEnv | undefined {
	const publicKeys = [
		"OCTOBER_BUS_ADDRESS",
		"OCTOBER_BUS_MCP_URL",
		"OCTOBER_BUS_AGENT_ID",
		"OCTOBER_BUS_EXECUTION_ID",
		"OCTOBER_BUS_AGENT_TOKEN",
	];
	if (publicKeys.some((key) => env[key] !== undefined)) {
		const address = nonEmpty(env.OCTOBER_BUS_ADDRESS);
		const mcpUrl = nonEmpty(env.OCTOBER_BUS_MCP_URL);
		const agentId = nonEmpty(env.OCTOBER_BUS_AGENT_ID);
		const executionId = nonEmpty(env.OCTOBER_BUS_EXECUTION_ID);
		const agentToken = nonEmpty(env.OCTOBER_BUS_AGENT_TOKEN);
		if (!address || !mcpUrl || !agentId || !executionId || !agentToken) return undefined;
		try {
			const base = new URL(address);
			const mcp = new URL(mcpUrl);
			const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
			if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) return undefined;
			if (base.username || base.password || base.search || base.hash || base.pathname !== "/") return undefined;
			if (mcp.origin !== base.origin || mcp.username || mcp.password || mcp.search || mcp.hash) return undefined;
			return { transport: "public", address: base.origin, mcpUrl: mcp.toString(), agentId, executionId, agentToken };
		} catch {
			return undefined;
		}
	}
	const portRaw = nonEmpty(env.OCTOBER_BUS_PORT);
	const canvas = nonEmpty(env.OCTOBER_BUS_CANVAS);
	const node = nonEmpty(env.OCTOBER_BUS_NODE);
	if (!portRaw || !canvas || !node) return undefined;

	const port = Number(portRaw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

	return {
		transport: "desktop",
		port,
		canvas,
		node,
		launch: nonEmpty(env.OCTOBER_BUS_LAUNCH),
		capability: nonEmpty(env.OCTOBER_BUS_MCP_CAPABILITY),
		token: nonEmpty(env.OCTOBER_BUS_TOKEN),
	};
}

export function octoberBusUrl(
	env: OctoberDesktopBusEnv,
	route: string,
	query?: Record<string, string | undefined>,
): string {
	const url = new URL(`http://127.0.0.1:${env.port}${route}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value) url.searchParams.set(key, value);
		}
	}
	return url.toString();
}
