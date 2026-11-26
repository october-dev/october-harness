import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	createReceiptReader,
	type OctoberCockpitOptions,
	registerOctoberCockpit,
} from "../src/extensions/october/bus/cockpit.ts";
import { buildMessageHistory, parsePeerList, parseTaskList } from "../src/extensions/october/bus/cockpit-data.ts";
import type { OctoberPublicBusEnv } from "../src/extensions/october/bus/env.ts";
import type { McpResult, McpToolCallResult, OctoberMcpClient } from "../src/extensions/october/bus/mcp-client.ts";
import { registerOctoberPublicBus } from "../src/extensions/october/bus/public.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ESC = "\x1b";
const ENTER = "\r";
const TOKEN = "fixture-secret-token";
const PUBLIC_ENV: OctoberPublicBusEnv = {
	transport: "public",
	address: "http://127.0.0.1:4765",
	mcpUrl: "http://127.0.0.1:4765/mcp",
	agentId: "planner",
	executionId: "exec-1",
	agentToken: TOKEN,
};
const BUS_ENV_KEYS = [
	"OCTOBER_BUS_PORT",
	"OCTOBER_BUS_CANVAS",
	"OCTOBER_BUS_NODE",
	"OCTOBER_BUS_MCP_CAPABILITY",
	"OCTOBER_BUS_TOKEN",
	"OCTOBER_BUS_ADDRESS",
	"OCTOBER_BUS_MCP_URL",
	"OCTOBER_BUS_AGENT_ID",
	"OCTOBER_BUS_EXECUTION_ID",
	"OCTOBER_BUS_AGENT_TOKEN",
] as const;

// Launcher-pinned Bus v0.1.0-rc.4 task: description only, no title/ready/recentProgress.
const PINNED_TASK = {
	id: "task-1",
	scopeId: "scope-1",
	description: "Implement auth\n\nAcceptance criteria:\nTests pass",
	createdBy: "planner",
	claimedBy: "builder",
	status: "claimed",
	dependencies: [],
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-01T10:05:00Z",
};
// Reviewed newer public contract task.
const NEWER_TASK = {
	id: "task-2",
	scopeId: "scope-1",
	title: "Review auth",
	description: "",
	createdBy: null,
	status: "open",
	dependencies: ["task-1"],
	ready: false,
	recentProgress: [
		{
			taskId: "task-2",
			sequence: 1,
			agentId: "builder",
			executionId: "exec-2",
			kind: "progress",
			text: "Started",
			createdAt: "2026-10-01T10:06:00Z",
		},
	],
	note: "Waits on task-1",
	createdAt: "2026-10-01T10:01:00Z",
	updatedAt: "2026-10-01T10:06:00Z",
};
const PEER = {
	id: "builder",
	displayName: "Builder",
	capabilities: [{ name: "code" }],
	lifecycle: "idle",
	ready: true,
	reachable: true,
	executionId: "exec-2",
	registeredAt: "2026-10-01T09:00:00Z",
	updatedAt: "2026-10-01T10:00:00Z",
};
const NODE_STATUS = {
	identity: { scopeId: "scope-1", agentId: "planner", executionId: "exec-1", leaseExpiresAt: "2026-10-01T11:00:00Z" },
	agent: { ...PEER, id: "planner", displayName: "Planner", executionId: "exec-1" },
};

const harnesses: Harness[] = [];
const servers: Server[] = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	vi.restoreAllMocks();
	for (const key of BUS_ENV_KEYS) delete process.env[key];
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

function ok(value: unknown): McpResult<McpToolCallResult> {
	return {
		ok: true,
		value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false, structuredContent: value },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

interface FakeCall {
	name: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
	result: ReturnType<typeof deferred<McpResult<McpToolCallResult>>>;
}

/** Fake Bus client. Each call stays pending until the test settles it. */
function fakeClient() {
	const calls: FakeCall[] = [];
	return {
		calls,
		callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
			const result = deferred<McpResult<McpToolCallResult>>();
			calls.push({ name, args, signal, result });
			return result.promise;
		},
		settle(name: string, value: McpResult<McpToolCallResult>) {
			const call = calls.find((candidate) => candidate.name === name);
			if (!call) throw new Error(`no ${name} call`);
			call.result.resolve(value);
		},
	};
}

/** Fake TUI host that runs the custom component factory like interactive mode. */
function fakeUi(options: { rows?: number } = {}) {
	const state: { view?: Component & { dispose?(): void }; renders: number } = { renders: 0 };
	const notify = vi.fn();
	const custom = vi.fn(
		(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<unknown>((resolve) => {
				let closed = false;
				const host = {
					terminal: { rows: options.rows ?? 40 },
					requestRender: () => {
						state.renders++;
					},
				};
				const done = (result: unknown) => {
					if (closed) return;
					closed = true;
					resolve(result);
					state.view?.dispose?.();
				};
				void Promise.resolve(
					factory(host as unknown as Parameters<typeof factory>[0], theme, new KeybindingsManager(), done),
				).then((view) => {
					state.view = view;
				});
			}),
	);
	const ui = {
		notify,
		custom,
		setStatus: () => {},
		setWidget: () => {},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		notify,
		custom,
		state,
		text: (width = 120) => stripAnsi(state.view?.render(width).join("\n") ?? ""),
		press: (input: string) => state.view?.handleInput?.(input),
	};
}

async function cockpitHarness(
	options: OctoberCockpitOptions,
	mode: "tui" | "print" | "rpc" = "tui",
	sessionManager?: SessionManager,
) {
	const prompts: string[] = [];
	const harness = await createHarness({
		sessionManager,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				registerOctoberCockpit(pi, options);
				pi.on("ui_prompt_start", (event) => {
					prompts.push(`start:${event.kind}`);
				});
				pi.on("ui_prompt_end", (event) => {
					prompts.push(`end:${event.kind}`);
				});
			},
		],
	});
	harnesses.push(harness);
	const ui = fakeUi();
	await harness.session.bindExtensions({ mode, uiContext: ui.ui });
	return { harness, ui, prompts };
}

let entrySeq = 0;
const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
function customEntry(customType: string, data: unknown, minute: number): SessionEntry {
	return { type: "custom", customType, data, id: `e${++entrySeq}`, parentId: null, timestamp: at(minute) };
}
function messageEntry(message: AgentMessage, minute: number): SessionEntry {
	return { type: "message", message, id: `e${++entrySeq}`, parentId: null, timestamp: at(minute) };
}
function toolResult(toolCallId: string, toolName: string, value: unknown, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(value) }],
		isError,
		timestamp: 0,
	};
}
function busMessage(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		from: "builder",
		to: "planner",
		mode: "notify",
		body: `body ${id}`,
		context: [],
		createdAt: "2026-10-01T09:59:00Z",
		...overrides,
	};
}
function delivery(state: string, messages: unknown[], minute: number, error?: string): SessionEntry {
	return customEntry(
		"october-bus-delivery",
		{ version: 1, batchId: "batch", state, messages, permissionCeiling: "inherit", ...(error ? { error } : {}) },
		minute,
	);
}

describe("October cockpit data", () => {
	// #12
	it("decodes pinned rc.4 and newer tasks and counts malformed items without dropping valid ones", () => {
		const parsed = parseTaskList({
			tasks: [PINNED_TASK, NEWER_TASK, { ...PINNED_TASK, id: "bad", updatedAt: undefined }, "junk"],
		});
		expect(parsed.malformed).toBe(2);
		expect(parsed.items).toEqual([
			expect.objectContaining({
				id: "task-1",
				heading: "Implement auth",
				status: "claimed",
				ready: undefined,
				progress: undefined,
				createdBy: "planner",
				claimedBy: "builder",
				createdAt: "2026-10-01T10:00:00Z",
				updatedAt: "2026-10-01T10:05:00Z",
			}),
			expect.objectContaining({
				id: "task-2",
				heading: "Review auth",
				ready: false,
				createdBy: null,
				note: "Waits on task-1",
				dependencies: ["task-1"],
				progress: [{ kind: "progress", text: "Started", agentId: "builder", createdAt: "2026-10-01T10:06:00Z" }],
			}),
		]);
		expect(() => parseTaskList({ tasks: { id: "task-1" } })).toThrow("malformed tasks collection");
		expect(() => parseTaskList({})).toThrow("malformed tasks collection");
	});

	// #12
	it("keeps exact peer identity and counts malformed peers", () => {
		const parsed = parsePeerList({ peers: [PEER, { id: "half", displayName: "Half" }] });
		expect(parsed.malformed).toBe(1);
		expect(parsed.items).toEqual([
			{
				id: "builder",
				displayName: "Builder",
				lifecycle: "idle",
				ready: true,
				reachable: true,
				executionId: "exec-2",
				capabilities: ["code"],
				updatedAt: "2026-10-01T10:00:00Z",
			},
		]);
		expect(parsePeerList({ peers: [] })).toEqual({ items: [], malformed: 0 });
		expect(() => parsePeerList({ peers: null })).toThrow("malformed peers collection");
	});

	// #12
	it("rebuilds observed messages from the branch and correlates them by exact ID", () => {
		const delegated = {
			version: 1,
			messageId: "req-1",
			taskId: "task-1",
			from: "planner-old",
			to: "builder",
			mode: "request",
			body: "Delegated task task-1: Implement auth",
			receipt: { messageId: "req-1", state: "queued", acceptedAt: "2026-10-01T10:00:30Z" },
		};
		const call = fauxToolCall(
			"mcp__october-bus__message_peer",
			{ peer: "builder", mode: "response", message: "On it", responseTo: "peer-req" },
			{ id: "call-1" },
		);
		const failedCall = fauxToolCall(
			"mcp__october-bus__message_peer",
			{ peer: "builder", message: "x" },
			{ id: "call-2" },
		);
		const policy = {
			kind: "text",
			title: "October delegation policy",
			text: JSON.stringify({ version: 1, taskId: "task-9", permissionCeiling: "read-only" }),
		};
		const branch: SessionEntry[] = [
			customEntry("october-bus-request", delegated, 1),
			delivery("received", [busMessage("peer-req", { mode: "request", context: [policy] })], 2),
			delivery("processing", [busMessage("peer-req", { mode: "request", context: [policy] })], 3),
			messageEntry(fauxAssistantMessage([call, failedCall], { stopReason: "toolUse" }), 4),
			messageEntry(
				toolResult("call-1", "mcp__october-bus__message_peer", {
					messageId: "resp-1",
					state: "queued",
					acceptedAt: "2026-10-01T10:04:30Z",
				}),
				4,
			),
			messageEntry(toolResult("call-2", "mcp__october-bus__message_peer", "boom", true), 4),
			messageEntry(toolResult("orphan", "mcp__october-bus__message_peer", { messageId: "orphan-1" }), 4),
			delivery("acknowledged", [busMessage("peer-req", { mode: "request", context: [policy] })], 5),
			delivery("received", [busMessage("reply-1", { mode: "response", responseTo: "req-1" })], 6),
			delivery(
				"failed",
				[busMessage("reply-1", { mode: "response", responseTo: "req-1" })],
				7,
				"agent turn ended with an error",
			),
			messageEntry(
				toolResult("call-3", "mcp__october-bus__check_inbox", {
					messages: [
						busMessage("reply-1", { mode: "response", responseTo: "req-1" }),
						busMessage("stray", { mode: "response", responseTo: "unknown-req" }),
					],
				}),
				8,
			),
		];
		const messages = buildMessageHistory(branch);
		const byId = new Map(messages.map((message) => [message.id, message]));
		expect(messages.map((message) => message.id)).toEqual(["stray", "reply-1", "resp-1", "peer-req", "req-1"]);

		expect(byId.get("req-1")).toMatchObject({
			direction: "outgoing",
			source: "delegation",
			from: "planner-old",
			to: "builder",
			taskId: "task-1",
			serverTime: { label: "accepted", value: "2026-10-01T10:00:30Z" },
			observedAt: at(1),
			replies: ["reply-1"],
		});
		expect(byId.get("peer-req")).toMatchObject({
			direction: "incoming",
			localState: "acknowledged",
			localStateAt: at(5),
			observedAt: at(2),
			taskId: "task-9",
			serverTime: { label: "created", value: "2026-10-01T09:59:00Z" },
			replies: ["resp-1"],
		});
		const response = byId.get("resp-1");
		expect(response).toMatchObject({
			direction: "outgoing",
			source: "message_peer",
			to: "builder",
			mode: "response",
			responseTo: "peer-req",
			parentRecorded: true,
			serverTime: { label: "accepted", value: "2026-10-01T10:04:30Z" },
		});
		// The historical sender of a model send is not recorded and never inferred.
		expect(response?.from).toBeUndefined();
		expect(byId.get("reply-1")).toMatchObject({
			source: "delivery",
			localState: "delivered to model",
			localStateAt: at(8),
			observedAt: at(6),
			parentRecorded: true,
		});
		expect(byId.get("stray")).toMatchObject({
			source: "check_inbox",
			parentRecorded: false,
			responseTo: "unknown-req",
		});
		expect(byId.has("orphan-1")).toBe(false);
	});

	// #12
	it("keeps a failed delivery state and its error", () => {
		const [message] = buildMessageHistory([delivery("failed", [busMessage("m1")], 1, "turn aborted")]);
		expect(message).toMatchObject({ localState: "failed", error: "turn aborted" });
	});
});

describe("October cockpit command", () => {
	// #12
	it("opens immediately, settles sections independently, and makes only read-only calls", async () => {
		const client = fakeClient();
		const { harness, ui, prompts } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		expect(ui.text()).toContain("Peers loading…");
		expect(ui.text()).toContain("Tasks loading…");
		expect(ui.text()).toContain("Connecting… · loading: node status, peers, tasks");
		expect(client.calls.map((call) => [call.name, call.args])).toEqual([
			["get_node_status", {}],
			["list_peers", {}],
			["list_tasks", {}],
		]);

		client.settle("list_peers", ok({ peers: [PEER] }));
		await vi.waitFor(() => expect(ui.text()).toContain("builder · Builder · idle · ready · reachable"));
		expect(ui.text()).toContain("Tasks loading…");

		client.settle("list_tasks", { ok: false, error: `MCP HTTP 500 ${TOKEN}` });
		await vi.waitFor(() => expect(ui.text()).toContain("Tasks unavailable"));
		const failed = ui.text();
		expect(failed).toContain("MCP HTTP 500 [redacted]");
		expect(failed).toContain("Check that the October Bus at http://127.0.0.1:4765 is running and reachable.");
		// #12 audit F3: the header reports the failed section, not success.
		expect(failed).toContain("Connecting… · failed: tasks · loading: node status");

		client.settle("get_node_status", ok(NODE_STATUS));
		await vi.waitFor(() => expect(ui.text()).toContain("Connected · failed: tasks"));
		const connected = ui.text(200);
		expect(connected).toContain("Agent planner (Planner) · execution exec-1 · scope scope-1");
		expect(connected).toContain("Transport: public Bus http://127.0.0.1:4765");
		expect(connected).toContain("snapshot");
		expect(connected).not.toContain(TOKEN);

		ui.press(ESC);
		await run;
		expect(client.calls).toHaveLength(3);
		expect(client.calls.every((call) => call.signal?.aborted)).toBe(true);
		// Closing submits no model prompt.
		expect(harness.session.messages).toEqual([]);
		await vi.waitFor(() => expect(prompts).toEqual(["start:custom", "end:custom"]));
	});

	// #12
	it("shows relaunch guidance for a rejected credential", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		client.settle("get_node_status", { ok: false, error: "MCP HTTP 401" });
		await vi.waitFor(() =>
			expect(ui.text()).toContain("Connection error · failed: node status · loading: peers, tasks"),
		);
		// Full diagnostics live in the scrollable body, wrapped instead of truncated.
		expect(ui.text()).toContain("get_node_status failed: MCP HTTP 401");
		expect(ui.text()).toContain("Relaunch with `october --team`.");
		expect(ui.state.view?.render(40).join(" ")).toContain("--team");
		ui.press(ESC);
		await run;
	});

	// #12 audit F3: header status reflects section failures in either completion order.
	it.each([
		["node first", ["get_node_status", "list_peers", "list_tasks"]],
		["node last", ["list_peers", "list_tasks", "get_node_status"]],
	] as const)("summarizes partial failure in the header (%s)", async (_label, order) => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		const results: Record<string, McpResult<McpToolCallResult>> = {
			get_node_status: ok(NODE_STATUS),
			list_peers: { ok: false, error: "MCP HTTP 503" },
			list_tasks: ok({ tasks: [PINNED_TASK] }),
		};
		for (const name of order) {
			client.settle(name, results[name]);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await vi.waitFor(() => expect(ui.text()).toContain("Connected · failed: peers"));
		expect(ui.text()).not.toContain("loading:");
		ui.press(ESC);
		await run;
	});

	// #12
	it("reports a fully connected snapshot only when every read succeeded", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		client.settle("get_node_status", ok(NODE_STATUS));
		client.settle("list_peers", ok({ peers: [PEER] }));
		await vi.waitFor(() => expect(ui.text()).toContain("Connected · loading: tasks"));
		client.settle("list_tasks", ok({ tasks: [] }));
		await vi.waitFor(() => expect(ui.text()).toMatch(/Connected · snapshot/));
		ui.press(ESC);
		await run;
	});

	// #12
	it("aborts reads on close and ignores late results; reopening reads again", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const first = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		client.settle("list_peers", { ok: false, error: "MCP HTTP 500" });
		await vi.waitFor(() => expect(ui.text()).toContain("Peers unavailable"));
		const closedView = ui.state.view;
		ui.press(ESC);
		await first;
		const renders = ui.state.renders;
		client.settle("list_tasks", ok({ tasks: [PINNED_TASK] }));
		client.settle("get_node_status", ok(NODE_STATUS));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ui.state.renders).toBe(renders);
		expect(stripAnsi(closedView?.render(120).join("\n") ?? "")).toContain("Tasks loading…");

		const second = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(6));
		client.calls[4].result.resolve(ok({ peers: [PEER] }));
		await vi.waitFor(() => expect(ui.text()).toContain("builder · Builder"));
		ui.press(ESC);
		await second;
	});

	// #12
	it("closes and aborts on session shutdown", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await run;
		expect(client.calls.every((call) => call.signal?.aborted)).toBe(true);
		expect(ui.custom).toHaveBeenCalledTimes(1);
	});

	// #12
	it("rejects a duplicate opening", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client });
		const runner = harness.session.extensionRunner;
		const command = runner.getCommand("cockpit");
		const first = command?.handler("", runner.createCommandContext());
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		await command?.handler("", runner.createCommandContext());
		expect(ui.custom).toHaveBeenCalledTimes(1);
		ui.press(ESC);
		await first;
	});

	// #12
	it("reads the selected message receipt and redacts credential errors", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("october-bus-request", {
			version: 1,
			messageId: "req-1",
			taskId: "task-1",
			from: "planner",
			to: "builder",
			mode: "request",
			body: "Delegated task task-1: Implement auth",
			receipt: { messageId: "req-1", state: "queued", acceptedAt: "2026-10-01T10:00:30Z" },
		});
		const client = fakeClient();
		const readReceipt = vi.fn(async (_messageId: string, _signal: AbortSignal) => {
			throw new Error(`Receipt HTTP 401: token ${TOKEN} rejected`);
		});
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client, readReceipt }, "tui", sessionManager);
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(client.calls).toHaveLength(3));
		client.settle("list_peers", ok({ peers: [] }));
		client.settle("list_tasks", ok({ tasks: [] }));
		await vi.waitFor(() => expect(ui.text()).toContain("→ req-1 request to builder"));
		ui.press(ENTER);
		await vi.waitFor(() => expect(ui.text(400)).toContain("unavailable: Receipt HTTP 401"));
		expect(readReceipt).toHaveBeenCalledTimes(1);
		expect(readReceipt.mock.calls[0][0]).toBe("req-1");
		const detail = ui.text(400);
		expect(detail).toContain("token [redacted] rejected");
		expect(detail).toContain("Relaunch with `october --team`");
		expect(detail).not.toContain(TOKEN);
		expect(detail).toContain("Task: task-1");
		ui.press(ESC);
		expect(ui.text()).toContain("October cockpit");
		ui.press(ESC);
		await run;
		expect(readReceipt.mock.calls[0][1].aborted).toBe(true);
		// The cockpit's only MCP reads remain the three snapshot calls.
		expect(client.calls.map((call) => call.name)).toEqual(["get_node_status", "list_peers", "list_tasks"]);
	});

	// #12
	it("explains a missing Bus without network requests", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { harness, ui } = await cockpitHarness({ bus: undefined, env: { OCTOBER_BUS_BINARY: "/opt/bus" } });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(ui.text()).toContain("No October Bus is configured"));
		expect(ui.text()).toContain("october --team");
		ui.press(ESC);
		await run;
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// #12
	it("reports incomplete or invalid attachment variables", async () => {
		const { harness, ui } = await cockpitHarness({ bus: undefined, env: { OCTOBER_BUS_AGENT_ID: "planner" } });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(ui.text()).toContain("Bus attachment is incomplete or invalid"));
		ui.press(ESC);
		await run;
	});

	// #12
	it("registers /cockpit with no Bus and stays network-inert", async () => {
		for (const key of BUS_ENV_KEYS) delete process.env[key];
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const harness = await createHarness({ extensionFactories: [octoberExtension] });
		harnesses.push(harness);
		const ui = fakeUi();
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(ui.text()).toContain("No October Bus is configured"));
		ui.press(ESC);
		await run;
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// #12
	it("shows the Desktop canvas and node without Bus reads", async () => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({
			bus: { transport: "desktop", port: 4377, canvas: "canvas-1", node: "node-1" },
			client,
		});
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(ui.text()).toContain("Canvas canvas-1 · node node-1"));
		expect(ui.text()).toContain("public October Bus launch contract");
		ui.press(ESC);
		await run;
		expect(client.calls).toEqual([]);
	});

	// #12
	it.each(["print", "rpc"] as const)("builds no component in %s mode", async (mode) => {
		const client = fakeClient();
		const { harness, ui } = await cockpitHarness({ bus: PUBLIC_ENV, client }, mode);
		await harness.session.prompt("/cockpit");
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith("/cockpit needs the interactive TUI.", "warning");
		expect(client.calls).toEqual([]);
	});
});

describe("October cockpit receipt reader", () => {
	async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
		const server = createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		return { ...PUBLIC_ENV, address, mcpUrl: `${address}/mcp` };
	}

	// #12
	it("GETs one encoded message receipt with the execution credential", async () => {
		const seen: { method?: string; url?: string; authorization?: string }[] = [];
		const env = await listen((request, response) => {
			seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					ok: true,
					result: {
						messageId: "m:1.x",
						state: "acknowledged",
						acceptedAt: "2026-10-01T10:00:00Z",
						responseMessageId: "m2",
					},
				}),
			);
		});
		const receipt = await createReceiptReader(env)("m:1.x", AbortSignal.timeout(2000));
		expect(seen).toEqual([{ method: "GET", url: "/v1/messages/m%3A1.x", authorization: `Bearer ${TOKEN}` }]);
		expect(receipt).toEqual({
			messageId: "m:1.x",
			state: "acknowledged",
			acceptedAt: "2026-10-01T10:00:00Z",
			deliveredAt: undefined,
			acknowledgedAt: undefined,
			repliedAt: undefined,
			responseMessageId: "m2",
		});
	});

	// #12
	it("rejects redirects, error envelopes, malformed and oversized responses", async () => {
		let reply: (response: ServerResponse) => void = () => {};
		let requests = 0;
		const env = await listen((_request, response) => {
			requests++;
			reply(response);
		});
		const read = () => createReceiptReader(env)("m1", AbortSignal.timeout(2000));

		await expect(createReceiptReader(env)("..", AbortSignal.timeout(2000))).rejects.toThrow("invalid message ID");
		expect(requests).toBe(0);
		reply = (response) => response.writeHead(302, { Location: "http://example.com/" }).end();
		await expect(read()).rejects.toThrow();
		reply = (response) =>
			response
				.writeHead(401, { "Content-Type": "application/json" })
				.end(JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED", message: "execution replaced" } }));
		await expect(read()).rejects.toThrow("Receipt HTTP 401: execution replaced");
		reply = (response) => response.writeHead(200).end("not json");
		await expect(read()).rejects.toThrow("Receipt HTTP 200: malformed response");
		reply = (response) => response.writeHead(200).end(JSON.stringify({ ok: true, result: { state: "queued" } }));
		await expect(read()).rejects.toThrow("malformed delivery receipt");
		reply = (response) => response.writeHead(200).end(" ".repeat(64 * 1024 + 1));
		await expect(read()).rejects.toThrow("exceeds");
	});
});

describe("October delegation request record", () => {
	async function delegationHarness(messagePeer: unknown) {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
		const calls: string[] = [];
		const client = {
			callTool: async (name: string) => {
				calls.push(name);
				if (name === "list_peers") return ok({ peers: [PEER] });
				if (name === "list_tasks") return ok({ tasks: [] });
				if (name === "add_task") return ok({ ...PINNED_TASK, id: "task-7" });
				if (name === "message_peer") return ok(messagePeer);
				return { ok: false as const, error: `unexpected ${name}` };
			},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => registerOctoberPublicBus(pi, PUBLIC_ENV, client as unknown as OctoberMcpClient),
			],
		});
		harnesses.push(harness);
		const ui = fakeUi();
		await harness.session.bindExtensions({ mode: "print", uiContext: ui.ui });
		return { harness, ui, calls };
	}

	const requestEntries = (harness: Harness) =>
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "october-bus-request");

	// #12
	it("records one request with its message ID, sender and task after a successful send", async () => {
		const receipt = { messageId: "msg-7", state: "queued", acceptedAt: "2026-10-01T10:00:30Z" };
		const { harness, ui, calls } = await delegationHarness(receipt);
		await harness.session.prompt("/delegate builder Implement auth");
		expect(calls.filter((name) => name === "add_task")).toHaveLength(1);
		expect(calls.filter((name) => name === "message_peer")).toHaveLength(1);
		const entries = requestEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0].type === "custom" && entries[0].data).toEqual({
			version: 1,
			messageId: "msg-7",
			taskId: "task-7",
			from: "planner",
			to: "builder",
			mode: "request",
			body: expect.stringContaining("Delegated task task-7: Implement auth"),
			receipt,
		});
		expect(ui.notify).toHaveBeenCalledWith("Delegated task-7 to builder with accept-edits authority.", "info");
		const [message] = buildMessageHistory(harness.sessionManager.getBranch());
		expect(message).toMatchObject({
			id: "msg-7",
			direction: "outgoing",
			taskId: "task-7",
			serverTime: { label: "accepted", value: "2026-10-01T10:00:30Z" },
		});
		// Session metadata never enters model context.
		expect(harness.session.messages).toEqual([]);
	});

	// #12
	it("reports a recording failure after a successful send without resending", async () => {
		const { harness, ui, calls } = await delegationHarness({ state: "queued" });
		await harness.session.prompt("/delegate builder Implement auth");
		expect(calls.filter((name) => name === "message_peer")).toHaveLength(1);
		expect(calls.filter((name) => name === "add_task")).toHaveLength(1);
		expect(requestEntries(harness)).toEqual([]);
		expect(ui.notify).toHaveBeenCalledWith(
			"Delegated task-7 to builder, but recording the request in this session failed: October Bus did not return a message ID",
			"warning",
		);
	});
});

describe("October cockpit with the public runtime", () => {
	// #12
	it("adds only read-only Bus traffic and keeps UI-prompt lifecycle reporting", async () => {
		const traffic: { route: string; tool?: string; body?: Record<string, unknown> }[] = [];
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(chunk as Buffer);
				const raw = Buffer.concat(chunks).toString("utf8");
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
				const route = `${request.method} ${request.url}`;
				if (route !== "POST /mcp") {
					traffic.push({ route, body });
					if (route === "GET /v1/messages/req-1") {
						response.writeHead(200, { "Content-Type": "application/json" });
						response.end(
							JSON.stringify({
								ok: true,
								result: { messageId: "req-1", state: "delivered", acceptedAt: "2026-10-01T10:00:30Z" },
							}),
						);
						return;
					}
					response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"result":{}}');
					return;
				}
				const params = body?.params as { name?: string } | undefined;
				traffic.push({ route, tool: body?.method === "tools/call" ? params?.name : String(body?.method) });
				const reply = (result: unknown, headers: Record<string, string> = {}) => {
					response.writeHead(200, { "Content-Type": "application/json", ...headers });
					response.end(JSON.stringify({ jsonrpc: "2.0", id: body?.id, result }));
				};
				if (body?.method === "initialize")
					return reply({ protocolVersion: "2025-03-26" }, { "mcp-session-id": "s1" });
				if (body?.method === "notifications/initialized") return void response.writeHead(202).end();
				if (body?.method === "tools/list")
					return reply({
						tools: ["get_node_status", "list_peers", "list_tasks", "check_inbox"].map((name) => ({ name })),
					});
				// Keep the runtime's inbox long-poll open; the cockpit must never call it.
				if (params?.name === "check_inbox") return;
				const results: Record<string, unknown> = {
					get_node_status: NODE_STATUS,
					list_peers: { peers: [] },
					list_tasks: { tasks: [] },
				};
				const value = results[params?.name ?? ""] ?? {};
				reply({
					content: [{ type: "text", text: JSON.stringify(value) }],
					structuredContent: value,
					isError: false,
				});
			})();
		});
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		process.env.OCTOBER_BUS_ADDRESS = address;
		process.env.OCTOBER_BUS_MCP_URL = `${address}/mcp`;
		process.env.OCTOBER_BUS_AGENT_ID = "planner";
		process.env.OCTOBER_BUS_EXECUTION_ID = "exec-1";
		process.env.OCTOBER_BUS_AGENT_TOKEN = TOKEN;

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("october-bus-request", {
			version: 1,
			messageId: "req-1",
			taskId: "task-1",
			from: "planner",
			to: "builder",
			mode: "request",
			body: "Delegated task task-1: Implement auth",
			receipt: { messageId: "req-1", state: "queued", acceptedAt: "2026-10-01T10:00:30Z" },
		});
		const harness = await createHarness({ sessionManager, extensionFactories: [octoberExtension] });
		harnesses.push(harness);
		const ui = fakeUi();
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
		await vi.waitFor(() => expect(traffic.some((item) => item.tool === "check_inbox")).toBe(true));
		await vi.waitFor(() => expect(traffic.some((item) => item.route === "PATCH /v1/me/heartbeat")).toBe(true));

		const before = traffic.length;
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() => expect(ui.text()).toContain("Connected"));
		await vi.waitFor(() => expect(ui.text()).toContain("Tasks (0)"));
		ui.press(ENTER);
		await vi.waitFor(() => expect(ui.text()).toContain("Bus state: delivered"));
		ui.press(ESC);
		ui.press(ESC);
		await run;
		await vi.waitFor(() =>
			expect(
				traffic
					.slice(before)
					.some((item) => item.route === "PATCH /v1/me/heartbeat" && item.body?.lifecycle === "idle"),
			).toBe(true),
		);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

		const during = traffic.slice(before);
		const tools = new Set(during.flatMap((item) => (item.tool ? [item.tool] : [])));
		for (const tool of ["get_node_status", "list_peers", "list_tasks"]) expect(tools.has(tool)).toBe(true);
		// check_inbox may belong to the runtime's own delivery loop; nothing mutating may appear.
		expect(
			[...tools].filter((tool) => !["get_node_status", "list_peers", "list_tasks", "check_inbox"].includes(tool)),
		).toEqual([]);
		const routes = new Set(during.filter((item) => item.route !== "POST /mcp").map((item) => item.route));
		expect([...routes].sort()).toEqual(["GET /v1/messages/req-1", "PATCH /v1/me/heartbeat"]);
		// Existing UI-prompt lifecycle reporting is unchanged: needs_input while open, then back.
		const heartbeats = during.filter((item) => item.route === "PATCH /v1/me/heartbeat").map((item) => item.body);
		expect(heartbeats).toContainEqual({ lifecycle: "needs_input", ready: false });
		expect(heartbeats).toContainEqual({ lifecycle: "idle", ready: true });
		expect(JSON.stringify(ui.text())).not.toContain(TOKEN);
	});
});
