export interface OctoberBusEnv {
	port: number;
	canvas: string;
	node: string;
	capability?: string;
	token?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Gate for every bus feature. If PORT/CANVAS/NODE are not all present and
 * well-formed, the extension registers nothing bus-related.
 */
export function parseOctoberBusEnv(env: NodeJS.ProcessEnv = process.env): OctoberBusEnv | undefined {
	const portRaw = nonEmpty(env.OCTOBER_BUS_PORT);
	const canvas = nonEmpty(env.OCTOBER_BUS_CANVAS);
	const node = nonEmpty(env.OCTOBER_BUS_NODE);
	if (!portRaw || !canvas || !node) return undefined;

	const port = Number(portRaw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

	return {
		port,
		canvas,
		node,
		capability: nonEmpty(env.OCTOBER_BUS_MCP_CAPABILITY),
		token: nonEmpty(env.OCTOBER_BUS_TOKEN),
	};
}

export function octoberBusUrl(env: OctoberBusEnv, route: string): string {
	return `http://127.0.0.1:${env.port}${route}`;
}
