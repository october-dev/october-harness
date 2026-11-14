import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { registerOctoberCockpit } from "../src/extensions/october/bus/cockpit.ts";
import type { OctoberPublicBusEnv } from "../src/extensions/october/bus/env.ts";
import type { McpResult, McpToolCallResult, OctoberMcpClient } from "../src/extensions/october/bus/mcp-client.ts";
import {
	DELIVERY_ENTRY,
	INBOX_PAUSE_ENTRY,
	readInboxDispatchSnapshot,
	readInboxPause,
	registerOctoberPublicBus,
} from "../src/extensions/october/bus/public.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getAssistantTexts, type Harness } from "./suite/harness.ts";

const ESC = "\x1b";
const PUBLIC_ENV: OctoberPublicBusEnv = {
	transport: "public",
	address: "http://127.0.0.1:4765",
	mcpUrl: "http://127.0.0.1:4765/mcp",
	agentId: "planner",
	executionId: "exec-1",
	agentToken: "fixture-secret-token",
};

function ok(value: unknown): McpResult<McpToolCallResult> {
	return {
		ok: true,
		value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false, structuredContent: value },
	};
}

function busMessage(id: string) {
	return {
		id,
		from: "builder",
		to: "planner",
		mode: "request",
		body: `please handle ${id}`,
		context: [],
	};
}

function deliveryEntry(batchId: string, state: string, messageId: string) {
	return {
		version: 1,
		batchId,
		state,
		messages: [busMessage(messageId)],
		permissionCeiling: "inherit",
	};
}

interface InboxControl {
	calls: string[];
	acks: string[][];
	inboxCalls: number;
	releaseInbox: (messages: unknown[]) => void;
}

function fakeBus(): InboxControl & { client: OctoberMcpClient } {
	let ackAttempts = 0;
	const control: InboxControl & { client: OctoberMcpClient } = {
		calls: [],
		acks: [],
		inboxCalls: 0,
		releaseInbox: () => {
			throw new Error("no inbox call is waiting");
		},
		client: undefined as unknown as OctoberMcpClient,
	};
	control.client = {
		callTool: async (name: string, args: Record<string, unknown>) => {
			control.calls.push(name);
			if (name === "list_peers") return ok({ peers: [] });
			if (name === "list_tasks") return ok({ tasks: [] });
			if (name === "check_inbox") {
				control.inboxCalls++;
				return new Promise<McpResult<McpToolCallResult>>((resolve) => {
					control.releaseInbox = (messages) => {
						control.releaseInbox = () => {
							throw new Error("inbox call already released");
						};
						resolve(ok({ messages }));
					};
				});
			}
			if (name === "acknowledge_messages") {
				ackAttempts++;
				const ids = Array.isArray(args.messageIds)
					? args.messageIds.filter((id): id is string => typeof id === "string")
					: [];
				control.acks.push(ids);
				if (ackAttempts === 1 && ids.includes("m-handled")) return { ok: false as const, error: "temporary" };
				return ok({});
			}
			return { ok: false as const, error: `unexpected ${name}` };
		},
	} as unknown as OctoberMcpClient;
	return control;
}

function latestState(harness: Harness, messageId: string): string | undefined {
	let state: string | undefined;
	for (const entry of harness.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DELIVERY_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const record = data as { state?: unknown; batchId?: unknown; messages?: { id?: unknown }[] };
		const ids = (record.messages ?? []).map((message) => message.id);
		if (record.batchId === messageId || ids.includes(messageId)) {
			state = typeof record.state === "string" ? record.state : undefined;
		}
	}
	return state;
}

function pauseValues(harness: Harness): boolean[] {
	return harness.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== INBOX_PAUSE_ENTRY) return [];
		const paused =
			entry.data && typeof entry.data === "object" ? (entry.data as { paused?: unknown }).paused : undefined;
		return typeof paused === "boolean" ? [paused] : [];
	});
}

function inboxTexts(harness: Harness): string[] {
	return harness.session.messages
		.flatMap((message) => (message.role === "custom" && message.customType === "october-bus-inbox" ? [message] : []))
		.map((message) => {
			const content = message.content;
			return typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		});
}

const harnesses: Harness[] = [];

beforeAll(() => initTheme("dark"));

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function startBus(
	options: {
		sessionManager?: SessionManager;
		mode?: "tui" | "rpc";
		/** Resolves before the peer turn's model request. Faux providers do not emit before_provider_request. */
		holdTurn?: () => Promise<void>;
		client?: OctoberMcpClient;
	} = {},
) {
	const bus = options.client ? undefined : fakeBus();
	const client = options.client ?? bus!.client;
	const notify = vi.fn();
	const statuses: string[] = [];
	const widgets: string[] = [];
	const ui = createTestUiContext({
		notify,
		setStatus: (_id, text) => {
			if (typeof text === "string") statuses.push(text);
		},
		setWidget: (_id, text) => {
			if (Array.isArray(text)) widgets.push(text.join("\n"));
		},
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
	const harness = await createHarness({
		sessionManager: options.sessionManager,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				if (options.holdTurn) {
					pi.on("agent_start", async () => {
						const hold = options.holdTurn?.();
						if (hold) await hold;
					});
				}
				registerOctoberPublicBus(pi, PUBLIC_ENV, client);
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: options.mode ?? "tui", uiContext: ui });
	return { harness, bus: bus!, notify, statuses, widgets, ui };
}

describe("inbox pause records", () => {
	it("keeps the latest valid pause choice and ignores malformed records", () => {
		const entries = [
			{ type: "custom", customType: INBOX_PAUSE_ENTRY, data: { version: 1, paused: true } },
			{ type: "custom", customType: INBOX_PAUSE_ENTRY, data: { version: 1, paused: "no" } },
			{ type: "message", customType: INBOX_PAUSE_ENTRY, data: { version: 1, paused: false } },
		];
		expect(readInboxPause(entries)).toBe(true);
		expect(
			readInboxDispatchSnapshot([
				...entries,
				{ type: "custom", customType: DELIVERY_ENTRY, data: deliveryEntry("b1", "received", "m1") },
				{ type: "custom", customType: DELIVERY_ENTRY, data: deliveryEntry("b1", "acknowledged", "m1") },
				{ type: "custom", customType: DELIVERY_ENTRY, data: deliveryEntry("b2", "failed", "m2") },
			]),
		).toEqual({ paused: true, pending: 1 });
	});
});

describe("automatic inbox dispatch pause", () => {
	it("is unavailable until the public Bus session starts", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi: ExtensionAPI) => registerOctoberPublicBus(pi, PUBLIC_ENV, fakeBus().client)],
		});
		harnesses.push(harness);
		expect(harness.session.getTeamInboxDispatch()).toEqual({
			available: false,
			paused: false,
			pending: 0,
			active: false,
		});
		expect(() => harness.session.setTeamInboxDispatch(true)).toThrow(/not active/);
	});

	it("queues an in-flight poll without acknowledging it, lets the user continue, and starts that batch on resume", async () => {
		const { harness, bus, notify, statuses, widgets } = await startBus();
		await vi.waitFor(() => expect(bus.inboxCalls).toBe(1));
		const paused = harness.session.setTeamInboxDispatch(true);
		expect(paused).toMatchObject({ available: true, paused: true, active: false });
		expect(statuses.at(-1)).toContain("paused");
		expect(widgets.at(-1)).toContain("paused");
		expect(pauseValues(harness)).toEqual([true]);

		bus.releaseInbox([busMessage("m-race")]);
		await vi.waitFor(() => expect(latestState(harness, "m-race")).toBe("received"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(latestState(harness, "m-race")).toBe("received");
		expect(bus.acks).toEqual([]);
		expect(inboxTexts(harness)).toEqual([]);
		expect(pauseValues(harness)).toEqual([true]);
		expect(bus.inboxCalls).toBe(1);

		harness.setResponses([fauxAssistantMessage("own work")]);
		await harness.session.prompt("continue my notes");
		expect(getAssistantTexts(harness)).toContain("own work");
		expect(latestState(harness, "m-race")).toBe("received");
		expect(bus.acks).toEqual([]);

		harness.session.setTeamInboxDispatch(true);
		expect(pauseValues(harness)).toEqual([true]);
		await harness.session.prompt("/inbox status");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Inbox dispatch is paused"), "info");

		harness.setResponses([fauxAssistantMessage("peer handled")]);
		const resumed = harness.session.setTeamInboxDispatch(false);
		expect(resumed.paused).toBe(false);
		await vi.waitFor(() => expect(latestState(harness, "m-race")).toBe("acknowledged"));
		expect(bus.acks).toEqual([["m-race"]]);
		expect(inboxTexts(harness).join("\n")).toContain("please handle m-race");
		expect(pauseValues(harness)).toEqual([true, false]);
	});

	it("lets an in-flight peer turn settle, then refuses the next batch until resume", async () => {
		let release = (): void => {};
		let hold: Promise<void> | undefined;
		const { harness, bus } = await startBus({
			holdTurn: () => hold ?? Promise.resolve(),
		});
		harness.setResponses([fauxAssistantMessage("peer handled")]);
		await vi.waitFor(() => expect(bus.inboxCalls).toBe(1));
		hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		bus.releaseInbox([busMessage("m-active")]);
		await vi.waitFor(() => expect(harness.session.getTeamInboxDispatch().active).toBe(true));
		expect(latestState(harness, "m-active")).toBe("processing");

		harness.session.setTeamInboxDispatch(true);
		expect(harness.session.getTeamInboxDispatch()).toMatchObject({ paused: true, active: true });
		release();
		await vi.waitFor(() => expect(latestState(harness, "m-active")).toBe("acknowledged"));
		expect(bus.acks).toEqual([["m-active"]]);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(bus.inboxCalls).toBe(1);

		harness.session.setTeamInboxDispatch(false);
		await vi.waitFor(() => expect(bus.inboxCalls).toBe(2));
	});

	it("restores a paused session with a queued batch and does not start it until resume", async () => {
		const first = await startBus();
		await vi.waitFor(() => expect(first.bus.inboxCalls).toBe(1));
		await first.harness.session.prompt("/inbox pause");
		expect(first.notify).toHaveBeenCalledWith(expect.stringContaining("paused"), "info");
		first.bus.releaseInbox([busMessage("m-queued")]);
		await vi.waitFor(() => expect(latestState(first.harness, "m-queued")).toBe("received"));
		const restored = SessionManager.inMemory();
		for (const entry of first.harness.sessionManager.getBranch()) {
			if (entry.type === "custom") restored.appendCustomEntry(entry.customType, entry.data);
		}
		first.harness.cleanup();
		harnesses.pop();

		const second = await startBus({ sessionManager: restored });
		expect(second.harness.session.getTeamInboxDispatch()).toMatchObject({
			available: true,
			paused: true,
			pending: 1,
			active: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(second.bus.inboxCalls).toBe(0);
		expect(latestState(second.harness, "m-queued")).toBe("received");
		expect(second.bus.acks).toEqual([]);
		expect(second.statuses.at(-1)).toContain("paused");

		second.harness.setResponses([fauxAssistantMessage("resumed")]);
		await second.harness.session.prompt("/inbox resume");
		await vi.waitFor(() => expect(latestState(second.harness, "m-queued")).toBe("acknowledged"));
		expect(second.bus.acks).toEqual([["m-queued"]]);
	});

	// #46: tree navigation can leave the pause record outside the active branch.
	it("keeps the pause choice when its record is not on the active branch", async () => {
		const sessionManager = SessionManager.inMemory();
		const beforePause = sessionManager.appendCustomEntry("test-marker");
		sessionManager.appendCustomEntry(INBOX_PAUSE_ENTRY, { version: 1, paused: true });
		sessionManager.branch(beforePause);
		sessionManager.appendCustomEntry("test-marker");
		expect(readInboxPause(sessionManager.getBranch())).toBe(false);

		const { harness, bus, statuses } = await startBus({ sessionManager });
		expect(harness.session.getTeamInboxDispatch()).toMatchObject({ available: true, paused: true });
		expect(statuses.at(-1)).toContain("paused");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(bus.inboxCalls).toBe(0);
	});

	// #46: a failed write must leave the choice unchanged and allow a real retry.
	it.each([true, false])("retries a failed write of paused=%s", async (next) => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(INBOX_PAUSE_ENTRY, { version: 1, paused: !next });
		const { harness } = await startBus({ sessionManager });
		const persist = vi.spyOn(sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("write failed");
		});
		expect(() => harness.session.setTeamInboxDispatch(next)).toThrow("write failed");
		expect(harness.session.getTeamInboxDispatch().paused).toBe(!next);
		expect(pauseValues(harness)).toEqual([!next]);
		expect(harness.session.setTeamInboxDispatch(next).paused).toBe(next);
		expect(pauseValues(harness)).toEqual([!next, next]);
		expect(persist).toHaveBeenCalledTimes(2);
	});

	it("retries acknowledgement of settled work while paused and leaves an unread batch untouched", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(INBOX_PAUSE_ENTRY, { version: 1, paused: true });
		sessionManager.appendCustomEntry(DELIVERY_ENTRY, deliveryEntry("m-handled", "handled", "m-handled"));
		sessionManager.appendCustomEntry(DELIVERY_ENTRY, deliveryEntry("m-unread", "received", "m-unread"));
		const { harness, bus, statuses } = await startBus({ sessionManager });
		expect(statuses.at(-1)).toContain("paused");
		await vi.waitFor(() => expect(bus.acks).toEqual([["m-handled"], ["m-handled"]]), { timeout: 5_000 });
		expect(latestState(harness, "m-handled")).toBe("acknowledged");
		expect(latestState(harness, "m-unread")).toBe("received");
		expect(bus.acks.flat()).not.toContain("m-unread");
		expect(inboxTexts(harness)).toEqual([]);
		expect(bus.inboxCalls).toBe(0);
	});

	it("queues /inbox retry while paused instead of starting a peer batch", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(INBOX_PAUSE_ENTRY, { version: 1, paused: true });
		sessionManager.appendCustomEntry(DELIVERY_ENTRY, {
			...deliveryEntry("m-failed", "failed", "m-failed"),
			error: "agent turn ended with an error or was aborted",
		});
		const { harness, bus, notify } = await startBus({ sessionManager });
		await harness.session.prompt("/inbox retry");
		expect(latestState(harness, "m-failed")).toBe("received");
		expect(inboxTexts(harness)).toEqual([]);
		expect(bus.inboxCalls).toBe(0);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Inbox dispatch is paused"), "info");
		await harness.session.prompt("/inbox nope");
		expect(notify).toHaveBeenCalledWith("Usage: /inbox [status|pause|resume|retry]", "warning");
	});

	it("shows the persisted pause choice in the cockpit", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(INBOX_PAUSE_ENTRY, { version: 1, paused: true });
		sessionManager.appendCustomEntry(DELIVERY_ENTRY, deliveryEntry("m-wait", "received", "m-wait"));
		const state: { view?: Component & { dispose?(): void } } = {};
		const ui = {
			notify: vi.fn(),
			setStatus: () => {},
			setWidget: () => {},
			custom: vi.fn(
				(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
					new Promise<unknown>((resolve) => {
						const done = () => {
							state.view?.dispose?.();
							resolve(undefined);
						};
						void Promise.resolve(
							factory(
								{ terminal: { rows: 40 }, requestRender: () => {} } as Parameters<typeof factory>[0],
								theme,
								new KeybindingsManager(),
								done,
							),
						).then((view) => {
							state.view = view;
						});
					}),
			),
		} as unknown as ExtensionUIContext;
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				(pi: ExtensionAPI) =>
					registerOctoberCockpit(pi, {
						bus: PUBLIC_ENV,
						client: {
							callTool: async (name: string) => {
								if (name === "get_node_status") {
									return ok({
										identity: {
											agentId: "planner",
											executionId: "exec-1",
											scopeId: "scope-1",
											leaseExpiresAt: "2026-10-01T11:00:00Z",
										},
									});
								}
								if (name === "list_peers") return ok({ peers: [] });
								if (name === "list_tasks") return ok({ tasks: [] });
								return { ok: false as const, error: name };
							},
						},
					}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui });
		const run = harness.session.prompt("/cockpit");
		await vi.waitFor(() =>
			expect(stripAnsi(state.view?.render(100).join("\n") ?? "")).toContain("Inbox dispatch: paused · 1 pending"),
		);
		state.view?.handleInput?.(ESC);
		await run;
	});
});

describe("RpcClient team inbox commands", () => {
	it("sends get_team_inbox and set_team_inbox without a model call", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as {
			send: (command: { type: string; paused?: boolean }) => Promise<unknown>;
			getData: <T>(response: unknown) => T;
		};
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data: { available: true, paused: command.type === "set_team_inbox", pending: 0, active: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;
		await expect(client.getTeamInbox()).resolves.toMatchObject({ available: true, paused: false });
		await expect(client.setTeamInbox(true)).resolves.toMatchObject({ paused: true });
		expect(send).toHaveBeenNthCalledWith(1, { type: "get_team_inbox" });
		expect(send).toHaveBeenNthCalledWith(2, { type: "set_team_inbox", paused: true });
	});
});
