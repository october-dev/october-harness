import { afterEach, expect, it, vi } from "vitest";
import { createNativeInbox } from "../src/extensions/october/bus/native-inbox.ts";

let client: ReturnType<typeof createNativeInbox> | undefined;
afterEach(() => {
	client?.stop();
	client = undefined;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function setup(options: { deliver?: () => void; read?: () => Promise<unknown>; ack?: () => Promise<unknown> } = {}) {
	vi.useFakeTimers();
	let session = "session",
		idle = true,
		reads = 0;
	const calls: Array<{ route: string; receipt?: string }> = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const route = new URL(url).pathname;
		const body = JSON.parse(String(init.body)) as { receipt?: string };
		calls.push({ route, receipt: body.receipt });
		if (route === "/hook/wake")
			return Response.json(
				options.read
					? await options.read()
					: reads++ === 0
						? { text: "request", receipt: "receipt" }
						: { status: "empty" },
			);
		if (route === "/hook/inbox-ack" && options.ack) await options.ack();
		return Response.json({ ok: true });
	});
	const deliver = vi.fn(options.deliver ?? (() => {}));
	const inbox = createNativeInbox(
		{
			transport: "desktop",
			port: 12345,
			canvas: "canvas",
			node: "node",
			launch: "launch",
			token: "token",
			capability: "cap",
		},
		() => session,
		() => idle,
		deliver,
	);
	client = inbox;
	return {
		inbox,
		calls,
		deliver,
		setSession: (value: string) => {
			session = value;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

it("acknowledges only the exact native handoff and retries only a lost ACK", async () => {
	let acknowledgements = 0;
	const f = setup({
		ack: async () => {
			if (++acknowledgements === 1) throw new Error("lost ACK");
		},
	});
	f.inbox.accepted(undefined, "session");
	f.inbox.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(f.deliver).toHaveBeenCalledExactlyOnceWith("request", "receipt");
	f.inbox.accepted("receipt", "wrong-session");
	await vi.advanceTimersByTimeAsync(6000);
	expect(f.calls.map((call) => call.route)).toEqual(["/hook/wake"]);
	f.inbox.accepted("receipt", "session");
	await vi.advanceTimersByTimeAsync(4000);
	expect(f.calls.map((call) => call.route)).toEqual([
		"/hook/wake",
		"/hook/inbox-ack",
		"/hook/inbox-ack",
		"/hook/wake",
	]);
	expect(f.deliver).toHaveBeenCalledTimes(1);
});

it.each(["working", "session", "stop"])(
	"declines before native invocation when %s changes during the read",
	async (change) => {
		let resolve!: (batch: unknown) => void;
		const f = setup({
			read: () =>
				new Promise((r) => {
					resolve = r;
				}),
		});
		f.inbox.start();
		await vi.advanceTimersByTimeAsync(0);
		if (change === "working") f.setIdle(false);
		if (change === "session") f.setSession("replacement");
		if (change === "stop") f.inbox.stop();
		resolve({ text: "request", receipt: "receipt" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.deliver).not.toHaveBeenCalled();
		expect(f.calls.map((call) => call.route)).toEqual(["/hook/wake", "/hook/inbox-decline"]);
	},
);

it("never polls a busy session or repeats an uncertain native message", async () => {
	const f = setup({
		deliver: () => {
			throw new Error("ambiguous native failure");
		},
	});
	f.setIdle(false);
	f.inbox.start();
	await vi.advanceTimersByTimeAsync(6000);
	expect(f.calls).toEqual([]);
	f.setIdle(true);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(f.deliver).toHaveBeenCalledTimes(1);
	expect(f.calls.map((call) => call.route)).toEqual(["/hook/wake"]);
});
