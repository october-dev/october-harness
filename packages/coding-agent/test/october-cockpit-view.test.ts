import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	CockpitMessage,
	CockpitPeer,
	CockpitReceipt,
	CockpitTask,
} from "../src/extensions/october/bus/cockpit-data.ts";
import {
	type CockpitReceiptLoader,
	type CockpitViewData,
	OctoberCockpitView,
} from "../src/extensions/october/bus/cockpit-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

const peer = (id: string, overrides: Partial<CockpitPeer> = {}): CockpitPeer => ({
	id,
	displayName: id.toUpperCase(),
	lifecycle: "idle",
	ready: true,
	reachable: true,
	capabilities: [],
	...overrides,
});

const pinnedTask: CockpitTask = {
	id: "task-1",
	heading: "Implement auth",
	description: "Implement auth\n\nAcceptance criteria:\nTests pass",
	status: "claimed",
	createdBy: "planner",
	claimedBy: "builder",
	dependencies: ["task-0"],
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-01T10:05:00Z",
};

const request: CockpitMessage = {
	id: "msg-1",
	direction: "outgoing",
	source: "delegation",
	from: "planner",
	to: "builder",
	mode: "request",
	body: "Delegated task task-1: Implement auth",
	taskId: "task-1",
	serverTime: { label: "accepted", value: "2026-10-01T10:00:01Z" },
	observedAt: "2026-10-01T10:00:02Z",
	localState: "sent",
	localStateAt: "2026-10-01T10:00:02Z",
	replies: ["msg-2"],
	parentRecorded: false,
};

const reply: CockpitMessage = {
	id: "msg-2",
	direction: "incoming",
	source: "delivery",
	from: "builder",
	to: "planner",
	mode: "response",
	body: "Done",
	responseTo: "msg-1",
	serverTime: { label: "created", value: "2026-10-01T10:10:00Z" },
	observedAt: "2026-10-01T10:10:01Z",
	localState: "acknowledged",
	localStateAt: "2026-10-01T10:10:30Z",
	replies: [],
	parentRecorded: true,
};

function data(overrides: Partial<CockpitViewData> = {}): CockpitViewData {
	return {
		transport: "Transport: public Bus http://127.0.0.1:4765",
		identity: ["Agent planner · execution exec-1"],
		connection: { text: "Connected", tone: "success" },
		snapshotAt: "2026-10-01T10:11:00Z",
		peers: { state: "ready", items: [peer("builder")], malformed: 0 },
		tasks: { state: "ready", items: [pinnedTask], malformed: 0 },
		messages: [reply, request],
		...overrides,
	};
}

function setup(
	viewData: CockpitViewData,
	options: { rows?: number; keybindings?: KeybindingsManager; loadReceipt?: CockpitReceiptLoader } = {},
) {
	const host = { terminal: { rows: options.rows ?? 40 }, requestRender: vi.fn() };
	const onClose = vi.fn();
	const view = new OctoberCockpitView(
		host,
		theme,
		options.keybindings ?? new KeybindingsManager(),
		viewData,
		onClose,
		options.loadReceipt,
	);
	const text = (width = 120) => stripAnsi(view.render(width).join("\n"));
	return { host, onClose, view, text };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeAll(() => initTheme("dark"));

describe("October cockpit view", () => {
	// #12
	it("renders connection, peers, tasks and correlated messages in one list", () => {
		const { text } = setup(data());
		const output = text();
		expect(output).toContain("October cockpit · read-only");
		expect(output).toContain("Transport: public Bus http://127.0.0.1:4765");
		expect(output).toContain("Connected · snapshot 2026-10-01 10:11:00Z");
		expect(output).toContain("builder · BUILDER · idle · ready · reachable");
		expect(output).toContain("task-1 [claimed] Implement auth · by planner · claimed by builder");
		expect(text(200)).toContain("created 2026-10-01 10:00:00Z · updated 2026-10-01 10:05:00Z");
		expect(output).toContain("← msg-2 response from builder · acknowledged");
		expect(output).toContain("re msg-1");
		expect(output).toContain("→ msg-1 request to builder · sent · 2026-10-01 10:00:01Z · task task-1 · 1 reply");
		expect(output).toContain("not yet delivered are not previewed");
		expect(output).toContain("enter inspect · escape close");
	});

	// #12
	it("distinguishes loading, failed, empty and partially malformed sections", () => {
		const { text } = setup(
			data({
				peers: { state: "error", error: "list_peers returned a malformed peers collection" },
				tasks: { state: "ready", items: [], malformed: 2 },
				messages: [],
			}),
		);
		const output = text();
		expect(output).toContain("Peers unavailable");
		expect(output).toContain("list_peers returned a malformed peers collection");
		expect(output).not.toContain("No linked peers.");
		expect(output).toContain("Tasks (0) · 2 malformed omitted");
		expect(output).toContain("No messages recorded in this session.");
		expect(setup(data({ peers: { state: "loading" } })).text()).toContain("Peers loading…");
	});

	// #12
	it("opens a read-only detail with labeled unavailable fields and returns with cancel", () => {
		const { text, view, onClose } = setup(data());
		view.handleInput(DOWN);
		view.handleInput(ENTER);
		const detail = text();
		expect(detail).toContain("Task task-1 · read-only");
		expect(detail).toContain("Readiness: not reported by this Bus");
		expect(detail).toContain("Progress: not reported by this Bus");
		expect(detail).toContain("Note: unavailable");
		expect(detail).toContain("Dependencies: task-0");
		expect(detail).toContain("Acceptance criteria:");
		view.handleInput(ESC);
		expect(onClose).not.toHaveBeenCalled();
		expect(text()).toContain("October cockpit");
		view.handleInput(ESC);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// #12
	it("shows newer task fields when supplied", () => {
		const newer: CockpitTask = {
			...pinnedTask,
			ready: true,
			createdBy: null,
			note: "Blocked on review",
			progress: [{ kind: "progress", text: "Half done", agentId: "builder", createdAt: "2026-10-01T10:03:00Z" }],
		};
		const { text, view } = setup(
			data({
				peers: { state: "ready", items: [], malformed: 0 },
				tasks: { state: "ready", items: [newer], malformed: 0 },
			}),
		);
		expect(text()).toContain("task-1 [claimed, ready] Implement auth · by none");
		view.handleInput(ENTER);
		const detail = text();
		expect(detail).toContain("Readiness: ready");
		expect(detail).toContain("Created by: none reported");
		expect(detail).toContain("Note: Blocked on review");
		expect(detail).toContain("2026-10-01 10:03:00Z progress builder: Half done");
	});

	// #12
	it("respects a remapped cancel binding", () => {
		const keybindings = new KeybindingsManager({ "tui.select.cancel": "q" });
		const { view, onClose, text } = setup(data(), { keybindings });
		expect(text()).toContain("q close");
		view.handleInput(ESC);
		expect(onClose).not.toHaveBeenCalled();
		view.handleInput("q");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// #12
	it("closes from an empty list", () => {
		const { view, onClose, text } = setup(
			data({
				peers: { state: "ready", items: [], malformed: 0 },
				tasks: { state: "ready", items: [], malformed: 0 },
				messages: [],
			}),
		);
		view.handleInput(ENTER);
		expect(text()).toContain("October cockpit");
		view.handleInput(ESC);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// #12
	it("strips peer-supplied terminal escapes and controls and fits every line to the width", () => {
		const hostile = "\x1b[31mRed\x1b[0m\x1b]0;pwned\x07\x9b2J\r\nX\tY\x7fZ\x85‮evil\x00";
		const viewData = data({
			peers: { state: "ready", items: [peer("p1", { displayName: hostile, lifecycle: hostile })], malformed: 0 },
			messages: [{ ...reply, body: hostile, from: hostile }],
			connection: { text: hostile, tone: "error" },
		});
		for (const width of [40, 120]) {
			const { view } = setup(viewData);
			const screens = [view.render(width)];
			view.handleInput(ENTER);
			screens.push(view.render(width));
			view.handleInput(ESC);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(ENTER);
			screens.push(view.render(width));
			for (const line of screens.flat()) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				// Only the theme's own SGR styling may remain.
				const unstyled = line.replace(/\x1b\[[0-9;]*m/g, "");
				expect(unstyled).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
				expect(unstyled).not.toContain("pwned");
			}
			expect(stripAnsi(screens[0].join("\n"))).toContain("Red X    YZevil");
			expect(stripAnsi(screens[2].join("\n"))).toContain("Body:");
		}
	});

	// #12
	it("scrolls long lists and details within the terminal height and survives resize", () => {
		const peers = Array.from({ length: 60 }, (_, index) => peer(`peer-${index}`));
		const { view, text } = setup(data({ peers: { state: "ready", items: peers, malformed: 0 } }), { rows: 20 });
		expect(view.render(120).length).toBeLessThanOrEqual(20);
		for (let index = 0; index < 30; index++) view.handleInput(DOWN);
		const scrolled = text();
		expect(scrolled).toContain("› peer-30 ·");
		expect(scrolled).not.toContain("peer-0 ·");
		expect(view.render(40).length).toBeLessThanOrEqual(20);
		expect(text(40)).toContain("› peer-30");

		const long: CockpitTask = {
			...pinnedTask,
			description: Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n"),
		};
		const detail = setup(
			data({
				peers: { state: "ready", items: [], malformed: 0 },
				tasks: { state: "ready", items: [long], malformed: 0 },
			}),
			{ rows: 20 },
		);
		detail.view.handleInput(ENTER);
		expect(detail.view.render(120).length).toBeLessThanOrEqual(20);
		const first = detail.text();
		detail.view.handleInput(PAGE_DOWN);
		detail.view.handleInput(PAGE_DOWN);
		const later = detail.text();
		expect(later).not.toEqual(first);
		expect(later).toMatch(/line \d+/);
		for (let index = 0; index < 50; index++) detail.view.handleInput(PAGE_DOWN);
		expect(detail.text()).toContain("line 79");
		expect(detail.view.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	// #12
	it("loads one receipt per message detail and ignores superseded or closed results", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<CockpitReceipt>>>();
		const signals = new Map<string, AbortSignal>();
		const loadReceipt = vi.fn((messageId: string, signal: AbortSignal) => {
			const next = deferred<CockpitReceipt>();
			pending.set(messageId, next);
			signals.set(messageId, signal);
			return next.promise;
		});
		const { view, text, host } = setup(
			data({
				peers: { state: "ready", items: [], malformed: 0 },
				tasks: { state: "ready", items: [], malformed: 0 },
			}),
			{ loadReceipt },
		);
		// First message row is msg-2 (newest first), second is msg-1.
		view.handleInput(ENTER);
		expect(text()).toContain("Bus receipt: loading…");
		view.handleInput(ESC);
		expect(signals.get("msg-2")?.aborted).toBe(true);
		view.handleInput(DOWN);
		view.handleInput(ENTER);
		expect(loadReceipt.mock.calls.map(([id]) => id)).toEqual(["msg-2", "msg-1"]);

		const renders = host.requestRender.mock.calls.length;
		pending.get("msg-2")?.resolve({ messageId: "msg-2", state: "acknowledged", acceptedAt: "2026-10-01T10:10:00Z" });
		await Promise.resolve();
		expect(host.requestRender.mock.calls.length).toBe(renders);
		expect(text()).toContain("Bus receipt: loading…");

		pending.get("msg-1")?.resolve({
			messageId: "msg-1",
			state: "acknowledged",
			acceptedAt: "2026-10-01T10:00:01Z",
			deliveredAt: "2026-10-01T10:00:05Z",
			repliedAt: "2026-10-01T10:10:00Z",
			responseMessageId: "msg-2",
		});
		await vi.waitFor(() => expect(text()).toContain("Bus state: acknowledged"));
		const detail = text();
		expect(detail).toContain("Response message: msg-2");
		expect(detail).not.toContain("msg-2 (not in this session)");
		expect(detail).toContain("Replies: msg-2");
		expect(detail).toContain("Task: task-1");
		expect(detail).toContain("Accepted (Bus): 2026-10-01 10:00:01Z");
		expect(detail).toContain("Observed (session): 2026-10-01 10:00:02Z");

		view.handleInput(ESC);
		view.handleInput(UP);
		view.handleInput(ENTER);
		pending.get("msg-2")?.reject(new Error("Receipt HTTP 404: not found"));
		await vi.waitFor(() => expect(text()).toContain("Bus receipt: unavailable: Receipt HTTP 404: not found"));
		expect(text()).toContain("Responds to: msg-1");

		view.dispose();
		const disposedRenders = host.requestRender.mock.calls.length;
		view.setData(data());
		expect(host.requestRender.mock.calls.length).toBe(disposedRenders);
	});

	// #12 audit F1: all text, not only items, is reachable by navigation.
	it("lets navigation reach error text after and before selectable items", () => {
		const longError = `MCP HTTP 500\n${"server detail\n".repeat(20)}CHECK BUS ADDRESS`;
		const after = setup(data({ tasks: { state: "error", error: longError }, messages: [] }), { rows: 20 });
		expect(after.text(40)).not.toContain("CHECK BUS ADDRESS");
		for (let index = 0; index < 100; index++) after.view.handleInput(PAGE_DOWN);
		expect(after.text(40)).toContain("CHECK BUS ADDRESS");
		for (let index = 0; index < 100; index++) after.view.handleInput(PAGE_UP);
		expect(after.text(40)).toContain("› Peers (1)");
		// Enter on a text line inspects nothing.
		after.view.handleInput(ENTER);
		expect(after.text(40)).toContain("October cockpit");

		const before = setup(
			data({
				peers: { state: "error", error: longError },
				tasks: { state: "ready", items: [pinnedTask], malformed: 0 },
				messages: [],
			}),
			{ rows: 20 },
		);
		// The view opens at the top, so the error above the first item is visible first.
		expect(before.text(40)).toContain("› Peers unavailable");
		before.view.handleInput(DOWN);
		expect(before.text(40)).toContain("› task-1");
		expect(before.text(40)).not.toContain("Peers unavailable");
		for (let index = 0; index < 40; index++) before.view.handleInput(UP);
		expect(before.text(40)).toContain("› Peers unavailable");
		before.view.handleInput(DOWN);
		expect(before.text(40)).toContain("› task-1");
		before.view.handleInput(ENTER);
		expect(before.text(40)).toContain("Task task-1 · read-only");
	});

	// #12 audit F1: empty-state and malformed rows stay reachable next to items.
	it("reaches empty-state and malformed rows in a short terminal", () => {
		const { view, text } = setup(
			data({
				peers: { state: "ready", items: [peer("builder")], malformed: 3 },
				tasks: { state: "ready", items: [], malformed: 0 },
				messages: [],
			}),
			{ rows: 10 },
		);
		for (let index = 0; index < 20; index++) view.handleInput(DOWN);
		expect(text(40)).toContain("No messages recorded");
		for (let index = 0; index < 20; index++) view.handleInput(UP);
		expect(text(40)).toContain("3 malformed omitted");
	});

	// #12 audit F2: long connection diagnostics never exceed the terminal height.
	it("bounds the header and scrolls long connection diagnostics", () => {
		const viewData = data({
			connection: { text: "Connection error · failed: node status", tone: "error" },
			connectionDetail: `get_node_status failed: ${"server detail\n".repeat(30)}Relaunch with \`october --team\`.`,
		});
		for (const rows of [3, 5, 8, 12, 20, 40]) {
			for (const width of [40, 120]) {
				const { view } = setup(viewData, { rows });
				expect(view.render(width).length).toBeLessThanOrEqual(rows);
				view.handleInput(DOWN);
				view.handleInput(ENTER);
				expect(view.render(width).length).toBeLessThanOrEqual(rows);
			}
		}
		const { view, text } = setup(viewData, { rows: 20 });
		expect(text(120)).toContain("Connection error · failed: node status");
		const first = text(40);
		expect(first.split("\n")[0]).toContain("October cockpit");
		expect(first).toContain("› Connection");
		expect(first).toContain("get_node_status failed");
		expect(first).not.toContain("Relaunch with");
		let presses = 0;
		while (!text(40).includes("Relaunch with") && presses < 10) {
			view.handleInput(PAGE_DOWN);
			presses++;
		}
		expect(presses).toBeGreaterThan(0);
		const later = text(40);
		expect(later.split("\n")[0]).toContain("October cockpit");
		expect(later).toContain("Relaunch with");
	});
});
