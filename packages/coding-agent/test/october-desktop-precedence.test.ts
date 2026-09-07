import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { getDesktopOctoberCredential, resetDesktopOctoberState } from "../src/extensions/october/auth.ts";
import { createOctoberProviderConfig, OCTOBER_DEFAULT_MODEL_ID } from "../src/extensions/october/provider.ts";

const servers: Server[] = [];
const savedToken = "oct_inf_standalone_account_A";
const messages = [{ role: "user" as const, content: "hi", timestamp: 0 }];

function jwt(account: string, version = 1): string {
	return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: account, version, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function gateway(): Promise<Array<{ path: string; bearer: string }>> {
	const requests: Array<{ path: string; bearer: string }> = [];
	const url = await listen((request, response) => {
		requests.push({ path: request.url ?? "", bearer: request.headers.authorization ?? "" });
		if (request.url === "/v1/models") {
			json(response, { data: [{ id: OCTOBER_DEFAULT_MODEL_ID }] });
			return;
		}
		if (request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`data: ${JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: OCTOBER_DEFAULT_MODEL_ID,
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
		);
	});
	vi.stubEnv("OCTOBER_INFERENCE_BASE_URL", `${url}/v1`);
	return requests;
}

async function createRuntime(storage: AuthStorage): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("october", createOctoberProviderConfig());
	await runtime.refresh({ allowNetwork: false, providers: ["october"] });
	return runtime;
}

beforeEach(() => {
	resetDesktopOctoberState();
	vi.stubEnv("OCTOBER_BUS_PORT", "1");
	vi.stubEnv("OCTOBER_BUS_TOKEN", "fixture-bus-token");
	vi.stubEnv("OCTOBER_SUPABASE_URL", "http://127.0.0.1:1");
	vi.stubEnv("OCTOBER_SUPABASE_ANON_KEY", "fixture-anon");
	vi.stubEnv("OCTOBER_SUPABASE_ACCESS_TOKEN", jwt("desktop-B"));
	vi.stubEnv("OCTOBER_SUPABASE_REFRESH_TOKEN", "fixture-spawn-refresh");
	vi.stubEnv("OCTOBER_SUPABASE_EXPIRES_AT", String(Math.floor(Date.now() / 1000) + 3600));
	vi.stubEnv("OCTOBER_INFERENCE_TOKEN", "ambient-account-C");
});

afterEach(async () => {
	resetDesktopOctoberState();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
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

describe("Desktop credential ownership through the composed model runtime", () => {
	it.each(["api_key", "oauth"] as const)(
		"Desktop JWT overrides stored standalone %s for discovery and inference",
		async (type) => {
			const requests = await gateway();
			const stored =
				type === "api_key"
					? { type, key: savedToken }
					: { type, access: savedToken, refresh: "old-account-refresh", expires: 0 };
			const storage = AuthStorage.inMemory({ october: stored });
			const write = vi.spyOn(storage, "modify");
			const runtime = await createRuntime(storage);
			const refreshed = await runtime.refresh({ allowNetwork: true, providers: ["october"] });
			expect(refreshed.errors.size).toBe(0);
			const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
			const result = await runtime.completeSimple(model, { messages });
			expect(result.stopReason).toBe("stop");
			expect(requests.some((request) => request.path === "/v1/models")).toBe(true);
			expect(requests.some((request) => request.path === "/v1/chat/completions")).toBe(true);
			expect(
				requests.every((request) => request.bearer === `Bearer ${process.env.OCTOBER_SUPABASE_ACCESS_TOKEN}`),
			).toBe(true);
			expect(write).not.toHaveBeenCalled();
			expect(await storage.read("october")).toEqual(stored);
		},
	);

	it("uses the rotated Desktop JWT on the next request and fails closed when bus refresh fails", async () => {
		const requests = await gateway();
		let failBus = false;
		let busRequests = 0;
		const rotated = jwt("desktop-B", 2);
		const busUrl = await listen((_request, response) => {
			busRequests++;
			if (failBus) response.writeHead(503).end();
			else json(response, { access_token: rotated, expires_at: Math.floor(Date.now() / 1000) + 3600 });
		});
		vi.stubEnv("OCTOBER_BUS_PORT", new URL(busUrl).port);
		const storage = AuthStorage.inMemory({ october: { type: "api_key", key: savedToken } });
		const write = vi.spyOn(storage, "modify");
		const runtime = await createRuntime(storage);
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		await runtime.completeSimple(model, { messages });
		getDesktopOctoberCredential()!.expires = 0;
		await runtime.completeSimple(model, { messages });
		expect(requests.at(-1)?.bearer).toBe(`Bearer ${rotated}`);
		expect(busRequests).toBe(1);
		failBus = true;
		getDesktopOctoberCredential()!.expires = 0;
		const before = requests.length;
		const failed = await runtime.completeSimple(model, { messages });
		expect(failed.stopReason).toBe("error");
		expect(requests).toHaveLength(before);
		expect(write).not.toHaveBeenCalled();
		expect(await storage.read("october")).toEqual({ type: "api_key", key: savedToken });
	});

	it("does not use the saved account when Desktop is signed out or its environment disappears", async () => {
		const requests = await gateway();
		const storage = AuthStorage.inMemory({ october: { type: "api_key", key: savedToken } });
		vi.stubEnv("OCTOBER_SUPABASE_ACCESS_TOKEN", "");
		const runtime = await createRuntime(storage);
		expect(await runtime.getAuth("october")).toBeUndefined();
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("error");
		vi.stubEnv("OCTOBER_BUS_PORT", "");
		expect(await runtime.getAuth("october")).toBeUndefined();
		expect(requests).toEqual([]);
	});

	it("leaves standalone credentials and other providers unchanged", async () => {
		vi.stubEnv("OCTOBER_BUS_PORT", "");
		const storage = AuthStorage.inMemory({
			october: { type: "api_key", key: savedToken },
			anthropic: { type: "api_key", key: "other-provider" },
		});
		const runtime = await createRuntime(storage);
		expect((await runtime.getAuth("october"))?.auth.apiKey).toBe(savedToken);
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("other-provider");
	});
});
