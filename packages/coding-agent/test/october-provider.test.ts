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

	it("seeds a baseline with Kimi first and the handover metadata", () => {
		expect(OCTOBER_SEED_MODELS[0]?.id).toBe("october/Kimi-K2.7-Code");
		expect(createOctoberProviderConfig().models?.[0]?.id).toBe("october/Kimi-K2.7-Code");
		expect(OCTOBER_SEED_MODELS.map((model) => model.id)).toEqual([
			"october/Kimi-K2.7-Code",
			"october/Qwen/Qwen3.6-35B-A3B-FP8",
		]);
		const kimi = OCTOBER_SEED_MODELS[0];
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.contextWindow).toBe(128000);
		expect(kimi?.maxTokens).toBe(32000);
		const qwen = OCTOBER_SEED_MODELS[1];
		expect(qwen?.reasoning).toBe(true);
		expect(qwen?.input).toEqual(["text"]);
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

	it("falls back to the seed catalogue when live /models returns an empty data list", async () => {
		let hits = 0;
		const { url } = await listen((request, response) => {
			hits += 1;
			if (request.url === "/v1/models" || request.url?.startsWith("/v1/models?")) {
				json(response, { data: [] });
				return;
			}
			response.writeHead(404).end();
		});
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		process.env.OCTOBER_INFERENCE_TOKEN = "test-token";

		const models = await refreshOctoberModels(refreshContext());
		expect(hits).toBe(1);
		expect(models.map((model) => model.id)).toEqual(OCTOBER_SEED_MODELS.map((model) => model.id));
	});

	it("upserts live /models ids verbatim including the october/ prefix", async () => {
		const seenAuth: string[] = [];
		const { url } = await listen((request, response) => {
			seenAuth.push(String(request.headers.authorization ?? ""));
			if (request.url === "/v1/models" || request.url?.startsWith("/v1/models?")) {
				json(response, {
					data: [
						{ id: "october/Kimi-K2.7-Code", context_window: 262144 },
						{ id: "october/Some_Custom-Model", context_length: 64000 },
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
		expect(models.map((model) => model.id)).toEqual(["october/Kimi-K2.7-Code", "october/Some_Custom-Model"]);
		expect(models[0]?.name).toContain("recommended");
		expect(models[0]?.contextWindow).toBe(262144);
		// An id not in the metadata table is still exposed with conservative defaults.
		expect(models[1]?.id).toBe("october/Some_Custom-Model");
		expect(models[1]?.name).toBe("october/Some_Custom-Model");
		expect(models[1]?.input).toEqual(["text"]);
		expect(models[1]?.reasoning).toBe(false);
		expect(models[1]?.maxTokens).toBe(32000);
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
			cliModel: "october/Kimi-K2.7-Code",
			modelRuntime: runtime,
		});
		expect(withProvider.error).toBeUndefined();
		expect(withProvider.model?.provider).toBe("october");
		expect(withProvider.model?.id).toBe("october/Kimi-K2.7-Code");

		const canonical = resolveCliModel({
			cliModel: "october/october/Kimi-K2.7-Code",
			modelRuntime: runtime,
		});
		expect(canonical.error).toBeUndefined();
		expect(canonical.model?.provider).toBe("october");
		expect(canonical.model?.id).toBe("october/Kimi-K2.7-Code");

		// Multi-slash upstream ids must survive: only the first segment is the provider namespace.
		const multiSlash = resolveCliModel({
			cliModel: "october/october/Qwen/Qwen3.6-35B-A3B-FP8",
			modelRuntime: runtime,
		});
		expect(multiSlash.error).toBeUndefined();
		expect(multiSlash.model?.provider).toBe("october");
		expect(multiSlash.model?.id).toBe("october/Qwen/Qwen3.6-35B-A3B-FP8");

		// Without --provider the leading `october/` is first treated as a provider prefix, then
		// rematched against the raw catalog id — so a current seed still resolves. Desktop still
		// pins `--provider october` so a stale/custom fallback cannot emit bare `Kimi-K2.7-Code`.
		const inferred = resolveCliModel({
			cliModel: "october/Kimi-K2.7-Code",
			modelRuntime: runtime,
		});
		expect(inferred.model?.provider).toBe("october");
		expect(inferred.model?.id).toBe("october/Kimi-K2.7-Code");
		expect(inferred.model?.id).not.toBe("Kimi-K2.7-Code");
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
					model: "october/Kimi-K2.7-Code",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-october",
					object: "chat.completion.chunk",
					created: 0,
					model: "october/Kimi-K2.7-Code",
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
