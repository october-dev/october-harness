import { afterEach, describe, expect, it, vi } from "vitest";
import { OctoberMcpClient } from "../src/extensions/october/bus/mcp-client.ts";
import { readBusResponse } from "../src/extensions/october/bus/response.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Desktop bus human-question lifetime", () => {
	it.each(["answer", "cancel"])("keeps a three-hour question pending until an actual %s", async (action) => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const deadline = new AbortController();
			setTimeout(() => deadline.abort(new Error("deadline expired")), ms);
			return deadline.signal;
		});
		let arrived = () => {};
		const started = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
		let questionId: number | undefined;
		const encoder = new TextEncoder();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const rpc = JSON.parse(String(init?.body)) as { method: string; id: number };
			if (rpc.method === "initialize")
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } });
			if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
			questionId = rpc.id;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					reply = controller;
					init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
				},
			});
			arrived();
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		});
		const owner = new AbortController();
		const client = new OctoberMcpClient({
			transport: "desktop",
			port: 1234,
			canvas: "c",
			node: "n",
			capability: "fixture",
		});
		let settled = false;
		const pending = client.callTool("ask_user", { question: "Continue?" }, owner.signal).then((result) => {
			settled = true;
			return result;
		});
		await started;
		await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
		expect(settled).toBe(false);
		if (action === "cancel") {
			owner.abort(new Error("owner stopped the question"));
			expect(await pending).toEqual({ ok: false, error: "owner stopped the question" });
		} else {
			reply?.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: questionId, result: { content: [{ type: "text", text: "Actual answer" }] } })}\n\n`,
				),
			);
			expect(await pending).toMatchObject({ ok: true, value: { content: [{ text: "Actual answer" }] } });
		}
	});

	it("discards complete heartbeat comments while bounding actual streamed response data", async () => {
		const encoder = new TextEncoder();
		let count = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (count++ < 2000) controller.enqueue(encoder.encode(": keepalive\r\n\r\n"));
					else {
						controller.enqueue(encoder.encode('data: {"answer":"real"}\n\n'));
						controller.close();
					}
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		expect(await readBusResponse(response, 64)).toContain('data: {"answer":"real"}');
		await expect(
			readBusResponse(
				new Response(`data: ${"x".repeat(65)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
				64,
			),
		).rejects.toThrow("exceeds");
	});
});
