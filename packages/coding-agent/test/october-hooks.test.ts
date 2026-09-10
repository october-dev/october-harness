import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { registerOctoberHooks } from "../src/extensions/october/bus/hooks.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const servers: Server[] = [];
const harnesses: Harness[] = [];

const BUS_ENV_KEYS = [
	"OCTOBER_BUS_PORT",
	"OCTOBER_BUS_CANVAS",
	"OCTOBER_BUS_NODE",
	"OCTOBER_BUS_LAUNCH",
	"OCTOBER_BUS_MCP_CAPABILITY",
	"OCTOBER_BUS_TOKEN",
] as const;

interface HookRecord {
	method: string;
	url: string;
	token: string | undefined;
	body: Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function startHookServer(options?: {
	prePrompt?: string;
	prePromptStatus?: number;
	prePromptDelayMs?: number;
	receipt?: string;
	sessionDelayMs?: number;
	wake?: { text: string; receipt: string };
}): Promise<{ port: number; hooks: HookRecord[]; hits: { count: number } }> {
	const hooks: HookRecord[] = [];
	const hits = { count: 0 };
	let wakeAvailable = true;
	const server = createServer((request, response) => {
		hits.count += 1;
		void (async () => {
			const url = request.url ?? "";
			const method = request.method ?? "GET";
			if (!url.startsWith("/hook/")) {
				response.writeHead(404).end();
				return;
			}
			if (options?.prePromptDelayMs && url.startsWith("/hook/pre-prompt")) {
				await new Promise((resolve) => setTimeout(resolve, options.prePromptDelayMs));
			}
			if (options?.sessionDelayMs && url === "/hook/session") {
				await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
			}
			let body: Record<string, unknown> = {};
			if (method === "POST") {
				try {
					body = JSON.parse(await readBody(request)) as Record<string, unknown>;
				} catch {
					body = {};
				}
			}
			hooks.push({
				method,
				url,
				token: headerValue(request.headers["x-october-bus-token"]),
				body,
			});
			if (url === "/hook/wake") {
				const result = wakeAvailable && options?.wake ? options.wake : { status: "empty" };
				wakeAvailable = false;
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
				return;
			}
			if (url.startsWith("/hook/pre-prompt")) {
				const status = options?.prePromptStatus ?? 200;
				response.writeHead(status, {
					"Content-Type": "text/plain",
					...(options?.receipt ? { "x-october-inbox-receipt": options.receipt } : {}),
				});
				response.end(options?.prePrompt ?? "");
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
		})();
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return { port, hooks, hits };
}

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function setBusEnv(port: number): void {
	process.env.OCTOBER_BUS_PORT = String(port);
	process.env.OCTOBER_BUS_CANVAS = "canvas-1";
	process.env.OCTOBER_BUS_NODE = "node-1";
	process.env.OCTOBER_BUS_LAUNCH = "launch-1";
	process.env.OCTOBER_BUS_TOKEN = "token-1";
}

function clearBusEnv(): void {
	for (const key of BUS_ENV_KEYS) {
		delete process.env[key];
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for hook traffic");
}

afterEach(async () => {
	clearBusEnv();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
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

describe("october lifecycle hooks", () => {
	it("starts a native bus turn through the actual agent loop, keeps the draft, and acknowledges its handoff", async () => {
		const stub = await startHookServer({ wake: { text: "NATIVE-PEER-REQUEST", receipt: "native-receipt" } });
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					registerOctoberHooks(pi, {
						transport: "desktop",
						port: stub.port,
						canvas: "canvas-1",
						node: "node-1",
						launch: "launch-1",
						token: "hook-token",
						capability: "mcp-capability",
					}),
			],
		});
		harnesses.push(harness);
		const setEditorText = vi.fn();
		// The bus adapter must never call editor mutation or UI APIs. The real agent/session message
		// path runs below; a partial UI supplies only the stationary draft and makes other use fail.
		const uiContext = {
			getEditorText: () => "stationary unsent draft",
			setEditorText,
		} as unknown as ExtensionUIContext;
		let sawContext = false;
		harness.setResponses([
			(context) => {
				sawContext = JSON.stringify(context.messages).includes("NATIVE-PEER-REQUEST");
				return fauxAssistantMessage("Native response");
			},
		]);
		try {
			await harness.session.bindExtensions({ mode: "tui", uiContext });
			await waitFor(() => stub.hooks.some((hook) => hook.url === "/hook/inbox-ack"), 4000);
			expect(sawContext).toBe(true);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(
				harness
					.eventsOfType("message_start")
					.some((event) => event.message.role === "custom" && event.message.customType === "october-bus-wake"),
			).toBe(true);
			expect(stub.hooks.some((hook) => hook.url.startsWith("/hook/pre-prompt"))).toBe(false);
			const start = stub.hooks.find((hook) => hook.url === "/hook/notify");
			expect(start?.body).toMatchObject({
				turnBoundary: true,
				notificationType: "working",
				providerTurnId: expect.any(String),
			});
			expect(stub.hooks.find((hook) => hook.url === "/hook/stop")?.body).toMatchObject({
				providerTurnId: start?.body.providerTurnId,
				outcome: "completed",
				excerpt: { assistantText: "Native response" },
			});
			expect(stub.hooks.find((hook) => hook.url === "/hook/inbox-ack")?.body.receipt).toBe("native-receipt");
			expect(setEditorText).not.toHaveBeenCalled();
			expect(uiContext.getEditorText()).toBe("stationary unsent draft");
		} finally {
			await harness.session.bindExtensions({ mode: "print" });
		}
	});

	it("orders delayed presence, acknowledges the full native handoff, and correlates distinct turns", async () => {
		const stub = await startHookServer({ prePrompt: "PEER-CONTEXT", receipt: "receipt-1", sessionDelayMs: 80 });
		setBusEnv(stub.port);
		const harness = await createHarness({ extensionFactories: [octoberExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			() => {
				expect(stub.hooks.some((hook) => hook.url === "/hook/inbox-ack" && hook.body.receipt === "receipt-1")).toBe(
					true,
				);
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		await harness.session.prompt("same prompt");
		await harness.session.prompt("same prompt");
		expect(stub.hooks[0].body.status).toBe("live");
		const starts = stub.hooks.filter((hook) => hook.url.startsWith("/hook/pre-prompt"));
		const stops = stub.hooks.filter((hook) => hook.url === "/hook/stop");
		expect(stops).toHaveLength(2);
		const ids = starts.map((hook) => new URL(hook.url, "http://fixture").searchParams.get("providerTurnId"));
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(2);
		expect(stops.map((hook) => hook.body.providerTurnId)).toEqual(ids);
	});

	it("keeps a prepared inbox receipt unacknowledged until the actual agent accepts its message", async () => {
		const stub = await startHookServer({ prePrompt: "PREPARED-CONTEXT", receipt: "prepared-receipt" });
		setBusEnv(stub.port);
		let preparing = false;
		let release!: () => void;
		const preparation = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				octoberExtension,
				(pi) => {
					pi.on("before_agent_start", async () => {
						preparing = true;
						await preparation;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("PREPARED-CONTEXT");
				expect(stub.hooks.filter((hook) => hook.url === "/hook/inbox-ack")).toHaveLength(1);
				return fauxAssistantMessage("accepted");
			},
		]);
		const prompt = harness.session.prompt("continue after preparation");
		try {
			await waitFor(() => preparing);
			expect(stub.hooks.filter((hook) => hook.url === "/hook/inbox-ack")).toHaveLength(0);
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		} finally {
			release();
			await prompt;
		}
		expect(stub.hooks.filter((hook) => hook.url === "/hook/inbox-ack").map((hook) => hook.body.receipt)).toEqual([
			"prepared-receipt",
		]);
		expect(harness.eventsOfType("message_start")).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					customType: "october-bus",
					details: { receipt: "prepared-receipt", providerTurnId: expect.any(String) },
				}),
			}),
		);
	});

	it("publishes only the settled final result after a retry, without intermediate assistant text", async () => {
		const stub = await startHookServer();
		setBusEnv(stub.port);
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [octoberExtension],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("intermediate text", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => {
				expect(stub.hooks.filter((hook) => hook.url === "/hook/stop")).toHaveLength(0);
				return fauxAssistantMessage("recovered");
			},
		]);
		await harness.session.prompt("retry this");
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
		const stops = stub.hooks.filter((hook) => hook.url === "/hook/stop");
		expect(stops).toHaveLength(1);
		expect(stops[0].body).toMatchObject({ outcome: "completed", excerpt: { assistantText: "recovered" } });
	});

	it.each([
		["stop", "completed"],
		["aborted", "cancelled"],
		["error", "failed"],
	] as const)("preserves a known empty result and its %s outcome", async (stopReason, outcome) => {
		const stub = await startHookServer();
		setBusEnv(stub.port);
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [octoberExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason })]);
		await harness.session.prompt("empty outcome");
		expect(stub.hooks.filter((hook) => hook.url === "/hook/stop").map((hook) => hook.body)).toEqual([
			expect.objectContaining({ outcome, excerpt: expect.objectContaining({ assistantText: "" }) }),
		]);
	});

	it("does not acknowledge or inject a batch that would be truncated", async () => {
		const stub = await startHookServer({ prePrompt: "x".repeat(100_001), receipt: "too-long" });
		setBusEnv(stub.port);
		const harness = await createHarness({ extensionFactories: [octoberExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("go");
		expect(stub.hooks.some((hook) => hook.url === "/hook/inbox-ack")).toBe(false);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "october-bus"),
		).toBe(false);
	});

	it("fires session live/offline with canvas, node, launch, and the bus token", async () => {
		const stub = await startHookServer();
		setBusEnv(stub.port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await waitFor(() => stub.hooks.some((hook) => hook.url === "/hook/session" && hook.body.status === "live"));
		await harness.session.reload();
		await waitFor(() => stub.hooks.some((hook) => hook.url === "/hook/session" && hook.body.status === "offline"));

		const start = stub.hooks.find((hook) => hook.body.status === "live");
		const end = stub.hooks.find((hook) => hook.body.status === "offline");
		expect(start?.token).toBe("token-1");
		expect(end?.token).toBe("token-1");
		expect(start?.body).toMatchObject({
			canvas: "canvas-1",
			node: "node-1",
			launch: "launch-1",
			agent: "october",
			cwd: harness.tempDir,
		});
		expect(typeof start?.body.session).toBe("string");
		expect(String(start?.body.session).length).toBeGreaterThan(0);
		expect(end?.body).toMatchObject({
			canvas: "canvas-1",
			node: "node-1",
			launch: "launch-1",
			agent: "october",
			status: "offline",
		});
	});

	it("pulls pre-prompt as GET (turn-start) and posts stop with excerpt (turn-end)", async () => {
		const stub = await startHookServer({ prePrompt: "ORIENTATION-BLOCK" });
		setBusEnv(stub.port);
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		let providerSawInject = false;
		harness.setResponses([
			(context) => {
				providerSawInject = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "ORIENTATION-BLOCK"),
				);
				return fauxAssistantMessage("assistant-summary-text");
			},
		]);
		await harness.session.prompt("hello");

		const injected = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "october-bus",
		);
		expect(injected?.role).toBe("custom");
		if (injected?.role === "custom") {
			expect(injected.display).toBe(false);
		}
		expect(providerSawInject).toBe(true);

		const pre = stub.hooks.find((hook) => hook.url.startsWith("/hook/pre-prompt"));
		expect(pre?.method).toBe("GET");
		expect(pre?.url).toContain("canvas=canvas-1");
		expect(pre?.url).toContain("node=node-1");
		expect(pre?.url).toContain("launch=launch-1");
		expect(pre?.url).toContain("agent=october");
		expect(pre?.token).toBe("token-1");

		await waitFor(() => stub.hooks.some((hook) => hook.url === "/hook/stop"));
		const stop = stub.hooks.find((hook) => hook.url === "/hook/stop");
		expect(stop?.body).toMatchObject({
			canvas: "canvas-1",
			node: "node-1",
			launch: "launch-1",
			agent: "october",
		});
		expect(stop?.body.excerpt).toMatchObject({
			cwd: harness.tempDir,
			userPrompt: "hello",
			assistantText: "assistant-summary-text",
		});
	});

	it("continues the turn when pre-prompt returns 500, times out, or empty text", { timeout: 20_000 }, async () => {
		for (const options of [{ prePromptStatus: 500 }, { prePrompt: "" }, { prePromptDelayMs: 6000 }]) {
			const stub = await startHookServer(options);
			setBusEnv(stub.port);
			const harness = await createHarness({
				extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "october-bus",
				),
			).toBe(false);
			expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true);
			harness.cleanup();
			harnesses.pop();
			clearBusEnv();
		}
	});

	it("emits zero hook traffic when bus env is unset", async () => {
		const stub = await startHookServer();
		clearBusEnv();
		const harness = await createHarness({
			extensionFactories: [{ name: "october", factory: octoberExtension, hidden: true }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		expect(stub.hits.count).toBe(0);
	});
});
