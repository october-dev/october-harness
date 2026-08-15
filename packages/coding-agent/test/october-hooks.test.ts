import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
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
}): Promise<{ port: number; hooks: HookRecord[]; hits: { count: number } }> {
	const hooks: HookRecord[] = [];
	const hits = { count: 0 };
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
			if (url.startsWith("/hook/pre-prompt")) {
				const status = options?.prePromptStatus ?? 200;
				response.writeHead(status, { "Content-Type": "text/plain" });
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
