import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import {
	createOctoberProviderConfig,
	OCTOBER_PROVIDER_ID,
	OCTOBER_SEED_MODELS,
	refreshOctoberModels,
} from "../src/extensions/october/provider.ts";

const servers: Server[] = [];

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		credential: overrides.credential,
		stored: overrides.stored,
		publish:
			overrides.publish ??
			(async (publication) => {
				publication.update?.();
				return true;
			}),
		allowNetwork: overrides.allowNetwork ?? true,
		signal: overrides.signal ?? new AbortController().signal,
	};
}

afterEach(async () => {
	delete process.env.OCTOBER_INFERENCE_TOKEN;
	delete process.env.OCTOBER_INFERENCE_BASE_URL;
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

describe("october inference provider", () => {
	it("registers provider october from the built-in extension factory", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(octoberExtension, process.cwd(), createEventBus(), runtime, "<inline:october>");
		expect(runtime.pendingProviderRegistrations.map((entry) => entry.name)).toEqual([OCTOBER_PROVIDER_ID]);
	});

	it("seeds a baseline with Kimi first", () => {
		expect(OCTOBER_SEED_MODELS[0]?.id).toBe("hetzner/kimi-k2");
		expect(createOctoberProviderConfig().models?.[0]?.id).toBe("hetzner/kimi-k2");
		expect(OCTOBER_SEED_MODELS.map((model) => model.id)).toEqual([
			"hetzner/kimi-k2",
			"hetzner/glm-4.7",
			"hetzner/qwen3-coder",
		]);
	});

	it("makes no network call during refresh when OCTOBER_INFERENCE_TOKEN is unset", async () => {
		let hits = 0;
		const { url } = await listen((_request, response) => {
			hits += 1;
			json(response, { data: [] });
		});
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		delete process.env.OCTOBER_INFERENCE_TOKEN;

		const models = await refreshOctoberModels(refreshContext());
		expect(hits).toBe(0);
		expect(models.map((model) => model.id)).toEqual(OCTOBER_SEED_MODELS.map((model) => model.id));
	});

	it("upserts live /models ids verbatim including the hetzner/ prefix", async () => {
		const seenAuth: string[] = [];
		const { url } = await listen((request, response) => {
			seenAuth.push(String(request.headers.authorization ?? ""));
			if (request.url === "/v1/models" || request.url?.startsWith("/v1/models?")) {
				json(response, {
					data: [
						{ id: "hetzner/kimi-k2", context_window: 262144 },
						{ id: "hetzner/Some_Custom-Model", context_length: 64000 },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		process.env.OCTOBER_INFERENCE_TOKEN = "test-token";

		const models = await refreshOctoberModels(refreshContext());
		expect(seenAuth).toEqual(["Bearer test-token"]);
		expect(models.map((model) => model.id)).toEqual(["hetzner/kimi-k2", "hetzner/Some_Custom-Model"]);
		expect(models[0]?.name).toContain("recommended");
		expect(models[0]?.contextWindow).toBe(262144);
		expect(models[1]?.id).toBe("hetzner/Some_Custom-Model");
		expect(models[1]?.name).toBe("hetzner/Some_Custom-Model");
	});

	it("does not normalize model ids when resolving --provider/--model", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider(OCTOBER_PROVIDER_ID, createOctoberProviderConfig());
		await runtime.refresh({ allowNetwork: false });

		const withProvider = resolveCliModel({
			cliProvider: "october",
			cliModel: "hetzner/kimi-k2",
			modelRuntime: runtime,
		});
		expect(withProvider.error).toBeUndefined();
		expect(withProvider.model?.provider).toBe("october");
		expect(withProvider.model?.id).toBe("hetzner/kimi-k2");

		const canonical = resolveCliModel({
			cliModel: "october/hetzner/kimi-k2",
			modelRuntime: runtime,
		});
		expect(canonical.error).toBeUndefined();
		expect(canonical.model?.provider).toBe("october");
		expect(canonical.model?.id).toBe("hetzner/kimi-k2");
	});

	it("streams a stubbed chat-completions SSE response through streamSimple", async () => {
		const { url } = await listen((request, response) => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-october",
					object: "chat.completion.chunk",
					created: 0,
					model: "hetzner/kimi-k2",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-october",
					object: "chat.completion.chunk",
					created: 0,
					model: "hetzner/kimi-k2",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			response.write("data: [DONE]\n\n");
			response.end();
		});

		const seed = OCTOBER_SEED_MODELS[0]!;
		const message = await streamSimple(
			{
				id: seed.id,
				name: seed.name,
				api: "openai-completions",
				provider: OCTOBER_PROVIDER_ID,
				baseUrl: `${url}/v1`,
				reasoning: seed.reasoning,
				input: seed.input,
				cost: seed.cost,
				contextWindow: seed.contextWindow,
				maxTokens: seed.maxTokens,
			},
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-token" },
		).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});
});
