import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/extensions/types.ts";
import {
	buildMessageHistory,
	type CockpitReceipt,
	parseNodeStatus,
	parsePeerList,
	parseReceipt,
	parseTaskList,
} from "./cockpit-data.ts";
import { type CockpitViewData, OctoberCockpitView } from "./cockpit-view.ts";
import type { OctoberBusEnv, OctoberPublicBusEnv } from "./env.ts";
import type { OctoberMcpClient } from "./mcp-client.ts";
import { callObject, errorMessage, isRecord } from "./public.ts";
import { readBusResponse } from "./response.ts";

const READ_TIMEOUT_MS = 10_000;
const MAX_RECEIPT_BYTES = 64 * 1024;
/** Execution-attachment variables read by `parseOctoberBusEnv`. Launcher-only settings are excluded. */
const ATTACHMENT_KEYS = [
	"OCTOBER_BUS_ADDRESS",
	"OCTOBER_BUS_MCP_URL",
	"OCTOBER_BUS_AGENT_ID",
	"OCTOBER_BUS_EXECUTION_ID",
	"OCTOBER_BUS_AGENT_TOKEN",
	"OCTOBER_BUS_PORT",
	"OCTOBER_BUS_CANVAS",
	"OCTOBER_BUS_NODE",
];

export type CockpitReceiptReader = (messageId: string, signal: AbortSignal) => Promise<CockpitReceipt>;

export interface OctoberCockpitOptions {
	/** Parsed attachment, or undefined when no valid Bus is configured. */
	bus: OctoberBusEnv | undefined;
	client?: Pick<OctoberMcpClient, "callTool">;
	readReceipt?: CockpitReceiptReader;
	/** Raw environment, used only to tell "not configured" from "incomplete or invalid". */
	env?: NodeJS.ProcessEnv;
}

/** Read one public delivery receipt. Returns state and timestamps only, never a message body. */
export function createReceiptReader(bus: OctoberPublicBusEnv): CockpitReceiptReader {
	return async (messageId, signal) => {
		// Bus identifiers start with an alphanumeric, so a peer-supplied ID cannot become a dot segment.
		if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(messageId)) throw new Error("invalid message ID");
		const response = await fetch(`${bus.address}/v1/messages/${encodeURIComponent(messageId)}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${bus.agentToken}`, Accept: "application/json" },
			redirect: "error",
			signal,
		});
		const body = await readBusResponse(response, MAX_RECEIPT_BYTES);
		let parsed: unknown;
		try {
			parsed = body.trim() ? JSON.parse(body) : undefined;
		} catch {
			throw new Error(`Receipt HTTP ${response.status}: malformed response`);
		}
		if (!response.ok || !isRecord(parsed) || parsed.ok !== true) {
			const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.message : undefined;
			throw new Error(
				`Receipt HTTP ${response.status}: ${typeof error === "string" && error ? error : "request failed"}`,
			);
		}
		return parseReceipt(parsed.result);
	};
}

function describeError(error: unknown, bus: OctoberPublicBusEnv): string {
	const message = errorMessage(error).replaceAll(bus.agentToken, "[redacted]");
	if (/\bHTTP 401\b/.test(message))
		return `${message}\nThe Bus rejected this execution's credential; it may have been replaced. Relaunch with \`october --team\`.`;
	return `${message}\nCheck that the October Bus at ${bus.address} is running and reachable.`;
}

function staticData(options: OctoberCockpitOptions): CockpitViewData {
	const { bus } = options;
	if (bus?.transport === "desktop") {
		return {
			transport: "Transport: October Desktop",
			identity: [`Canvas ${bus.canvas} · node ${bus.node}`],
			connection: { text: "Cockpit unavailable for Desktop attachments", tone: "warning" },
			notice: [
				"The cockpit reads the public October Bus launch contract.",
				"October Desktop owns delivery and presence for this session. Use the Desktop canvas,",
				"or launch the harness with `october --team` to inspect peers, tasks and messages here.",
			],
		};
	}
	const env = options.env ?? process.env;
	const invalid = ATTACHMENT_KEYS.some((key) => env[key] !== undefined);
	return {
		transport: "Transport: none",
		identity: [],
		connection: invalid
			? { text: "Bus attachment is incomplete or invalid", tone: "error" }
			: { text: "No October Bus is configured", tone: "warning" },
		notice: invalid
			? [
					"Some October Bus attachment variables are set, but they are incomplete or invalid,",
					"so this session is not attached. Relaunch with `october --team`.",
				]
			: ["This session is not attached to an October Bus. Start a team session with `october --team`."],
	};
}

/** `/cockpit`: read-only TUI view of the Bus connection, peers, tasks and messages observed in this session. */
export function registerOctoberCockpit(pi: ExtensionAPI, options: OctoberCockpitOptions): void {
	const { bus, client } = options;
	let open = false;

	const show = async (ctx: ExtensionCommandContext): Promise<void> => {
		const closing = new AbortController();
		let closeView: (() => void) | undefined;
		const stopShutdown = pi.on("session_shutdown", () => closeView?.());
		try {
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				closeView = () => {
					closing.abort();
					done();
				};
				if (bus?.transport !== "public" || !client) {
					return new OctoberCockpitView(tui, theme, keybindings, staticData(options), closeView);
				}
				const reader = options.readReceipt ?? createReceiptReader(bus);
				// The header summarizes all three reads, so a failed section is visible even when scrolled away.
				const reads: Record<"node status" | "peers" | "tasks", "loading" | "ok" | "error"> = {
					"node status": "loading",
					peers: "loading",
					tasks: "loading",
				};
				const connection = (): CockpitViewData["connection"] => {
					const names = Object.keys(reads) as (keyof typeof reads)[];
					const failed = names.filter((name) => reads[name] === "error");
					const pending = names.filter((name) => reads[name] === "loading");
					const node = reads["node status"];
					const text = [
						node === "ok" ? "Connected" : node === "error" ? "Connection error" : "Connecting…",
						...(failed.length ? [`failed: ${failed.join(", ")}`] : []),
						...(pending.length ? [`loading: ${pending.join(", ")}`] : []),
					].join(" · ");
					const tone =
						node === "error" ? "error" : failed.length ? "warning" : pending.length ? "muted" : "success";
					return { text, tone };
				};
				let data: CockpitViewData = {
					transport: `Transport: public Bus ${bus.address}`,
					identity: [`Agent ${bus.agentId} · execution ${bus.executionId}`],
					connection: connection(),
					snapshotAt: new Date().toISOString(),
					peers: { state: "loading" },
					tasks: { state: "loading" },
					messages: buildMessageHistory(ctx.sessionManager.getBranch()),
				};
				const view = new OctoberCockpitView(tui, theme, keybindings, data, closeView, (messageId, signal) =>
					reader(messageId, AbortSignal.any([closing.signal, signal, AbortSignal.timeout(READ_TIMEOUT_MS)])).catch(
						(error: unknown) => {
							throw new Error(describeError(error, bus));
						},
					),
				);
				const update = (read: keyof typeof reads, ok: boolean, next: Partial<CockpitViewData>): void => {
					if (closing.signal.aborted) return;
					reads[read] = ok ? "ok" : "error";
					data = { ...data, ...next, connection: connection() };
					view.setData(data);
				};
				// Each section settles on its own, so one failure neither blanks nor delays the others.
				const load = <T>(name: string, parse: (value: Record<string, unknown>) => T) =>
					callObject(client, name, {}, AbortSignal.any([closing.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]))
						.then(parse)
						.then(
							(value) => ({ ok: true as const, value }),
							(error: unknown) => ({ ok: false as const, error: describeError(error, bus) }),
						);
				void load("get_node_status", parseNodeStatus).then((result) => {
					if (!result.ok) {
						update("node status", false, { connectionDetail: `get_node_status failed: ${result.error}` });
						return;
					}
					const node = result.value;
					const readiness = node.ready === undefined ? "" : node.ready ? " · ready" : " · not ready";
					update("node status", true, {
						identity: [
							`Agent ${node.agentId}${node.displayName ? ` (${node.displayName})` : ""} · execution ${node.executionId}${node.scopeId ? ` · scope ${node.scopeId}` : ""}`,
							...(node.lifecycle
								? [
										`Lifecycle ${node.lifecycle}${readiness}${node.leaseExpiresAt ? ` · lease until ${node.leaseExpiresAt}` : ""}`,
									]
								: []),
						],
					});
				});
				void load("list_peers", parsePeerList).then((result) =>
					update("peers", result.ok, {
						peers: result.ok ? { state: "ready", ...result.value } : { state: "error", error: result.error },
					}),
				);
				void load("list_tasks", parseTaskList).then((result) =>
					update("tasks", result.ok, {
						tasks: result.ok ? { state: "ready", ...result.value } : { state: "error", error: result.error },
					}),
				);
				return view;
			});
		} finally {
			closing.abort();
			stopShutdown();
		}
	};

	pi.registerCommand("cockpit", {
		description: "Inspect October Bus connection, peers, tasks and observed messages (read-only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/cockpit needs the interactive TUI.", "warning");
				return;
			}
			if (open) return;
			open = true;
			try {
				await show(ctx);
			} finally {
				open = false;
			}
		},
	});
}
