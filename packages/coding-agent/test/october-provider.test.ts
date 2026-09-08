import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { findInitialModel, resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import octoberExtension from "../src/extensions/october/index.ts";
import {
	createOctoberProviderConfig,
	describeOctoberBearer,
	OCTOBER_DEFAULT_MODEL_ID,
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
	vi.restoreAllMocks();
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

	it("defaults to production Qwen3.6 while preserving Kimi metadata for explicit selection", () => {
		expect(OCTOBER_DEFAULT_MODEL_ID).toBe("october/Qwen/Qwen3.6-35B-A3B-FP8");
		expect(createOctoberProviderConfig().models?.[0]?.id).toBe(OCTOBER_DEFAULT_MODEL_ID);
		expect(OCTOBER_SEED_MODELS.map((model) => model.id)).toEqual([
			"october/Qwen/Qwen3.6-35B-A3B-FP8",
			"october/Kimi-K2.7-Code",
		]);
		const kimi = OCTOBER_SEED_MODELS[1];
		expect(kimi?.name).not.toContain("recommended");
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.contextWindow).toBe(128000);
		expect(kimi?.maxTokens).toBe(32000);
		const qwen = OCTOBER_SEED_MODELS[0];
		expect(qwen?.name).toContain("recommended");
		expect(qwen?.reasoning).toBe(true);
		expect(qwen?.input).toEqual(["text"]);
	});

	it("selects Qwen for a fresh October runtime without overriding an explicit model", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider(OCTOBER_PROVIDER_ID, createOctoberProviderConfig());
		await runtime.refresh({ allowNetwork: false });
		// Isolate initial selection from other providers configured in the test runner's environment.
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(runtime.getModels("october"));
		const selected = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		expect(selected.model?.id).toBe("october/Qwen/Qwen3.6-35B-A3B-FP8");
		const explicit = await findInitialModel({
			cliProvider: "october",
			cliModel: "october/Kimi-K2.7-Code",
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtime,
		});
		expect(explicit.model?.id).toBe("october/Kimi-K2.7-Code");
	});

	it("prioritizes Qwen in a live catalog regardless of gateway order", async () => {
		const { url } = await listen((_request, response) =>
			json(response, {
				data: [
					{ id: "october/Kimi-K2.7-Code" },
					{ id: "october/Qwen3.8-27B" },
					{ id: "october/Qwen/Qwen3.6-35B-A3B-FP8" },
				],
			}),
		);
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		const models = await refreshOctoberModels(refreshContext({ credential: { type: "api_key", key: "test-token" } }));
		expect(models.map((model) => model.id)).toEqual([
			"october/Qwen/Qwen3.6-35B-A3B-FP8",
			"october/Kimi-K2.7-Code",
			"october/Qwen3.8-27B",
		]);
	});

	it("classifies bearers without exposing the secret", () => {
		expect(describeOctoberBearer(undefined)).toBe("no token");
		expect(describeOctoberBearer("")).toBe("no token");
		expect(describeOctoberBearer("oct_inf_abc")).toBe("oct_inf");
		expect(describeOctoberBearer("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig")).toBe("jwt");
		expect(describeOctoberBearer("sk-not-ours")).toBe("other");
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

	it("falls back to the seed catalogue when live /models returns HTTP 401", async () => {
		let hits = 0;
		const { url } = await listen((_request, response) => {
			hits += 1;
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({ error: { code: "invalid_api_key", message: "Missing or invalid October credential" } }),
			);
		});
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		process.env.OCTOBER_INFERENCE_TOKEN = "stale-jwt";

		const models = await refreshOctoberModels(
			refreshContext({
				credential: { type: "oauth", access: "stale-jwt", refresh: "r", expires: Date.now() + 60_000 },
			}),
		);
		expect(hits).toBe(1);
		expect(models.map((model) => model.id)).toEqual(OCTOBER_SEED_MODELS.map((model) => model.id));
	});

	it("falls back to the seed catalogue when live /models returns a bad shape", async () => {
		const { url } = await listen((_request, response) => {
			json(response, { models: [{ id: "not-the-contract" }] });
		});
		process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
		process.env.OCTOBER_INFERENCE_TOKEN = "test-token";

		const models = await refreshOctoberModels(refreshContext());
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
		expect(models[0]?.name).toBe("Kimi K2.7 Code");
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
					model: OCTOBER_DEFAULT_MODEL_ID,
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-october",
					object: "chat.completion.chunk",
					created: 0,
					model: OCTOBER_DEFAULT_MODEL_ID,
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

	it.each([
		{ id: "nvidia/mistralai/mistral-nemotron", preferStrict: false, discovered: true },
		{ id: "nvidia/mistralai/mistral-nemotron", preferStrict: true, discovered: true },
		{ id: "nvidia/mistralai/mistral-nemotron", preferStrict: false, discovered: false },
		{ id: OCTOBER_DEFAULT_MODEL_ID, preferStrict: false, discovered: true },
	])(
		"keeps tool requests compatible for $id (preferStrict=$preferStrict, discovered=$discovered)",
		async ({ id, preferStrict, discovered }) => {
			const requests: Record<string, unknown>[] = [];
			const authorizations: string[] = [];
			const nvidia = id.startsWith("nvidia/");
			const { url } = await listen((request, response) => {
				authorizations.push(String(request.headers.authorization ?? ""));
				if (request.url === "/v1/models") {
					json(response, { data: [{ id }] });
					return;
				}
				if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
					response.writeHead(404).end();
					return;
				}
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					const payload = JSON.parse(body) as Record<string, unknown>;
					requests.push(payload);
					const tools = payload.tools as { function: Record<string, unknown> }[];
					if (nvidia && tools.some((tool) => "strict" in tool.function)) {
						response.writeHead(400, { "Content-Type": "application/json" });
						response.end(
							JSON.stringify({ error: { message: "tools.0.function.strict: Extra inputs are not permitted" } }),
						);
						return;
					}
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					response.write(
						`data: ${JSON.stringify({
							id: "fixture-completion",
							object: "chat.completion.chunk",
							model: id,
							choices: [
								{
									index: 0,
									delta: {
										role: "assistant",
										tool_calls: [
											{
												index: 0,
												id: "fixture-call",
												type: "function",
												function: { name: "read", arguments: '{"value":"README.md"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						})}\n\n`,
					);
					response.end(
						`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
					);
				});
			});
			process.env.OCTOBER_INFERENCE_BASE_URL = `${url}/v1`;
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ october: { type: "api_key", key: "fixture-token" } }),
				modelsPath: null,
				refreshOnCreate: false,
			});
			runtime.registerProvider("october", createOctoberProviderConfig());
			await runtime.refresh({ providers: ["october"], allowNetwork: discovered });
			const model = resolveCliModel({ cliProvider: "october", cliModel: id, modelRuntime: runtime }).model!;
			expect(model?.id).toBe(id);
			const context: Context = {
				systemPrompt: "You are a test assistant.",
				messages: [{ role: "user", content: "Read README.md", timestamp: 0 }],
				tools: ["read", "bash", "edit", "write"].map((name) => ({
					name,
					description: name,
					parameters: Type.Object({ value: Type.String() }),
					...(preferStrict
						? { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } }
						: {}),
				})),
			};
			const options = {
				maxTokens: 128,
				reasoning: "low" as const,
				cacheRetention: "long" as const,
				sessionId: "fixture-session",
			};
			const message = await runtime.completeSimple(model, context, options);
			expect(message.errorMessage).toBeUndefined();
			expect(message.stopReason).toBe("toolUse");
			expect(message.content).toEqual([
				{ type: "toolCall", id: "fixture-call", name: "read", arguments: { value: "README.md" } },
			]);
			const payload = requests[0]!;
			expect(payload.model).toBe(id);
			const tools = payload.tools as { function: Record<string, unknown> }[];
			expect(tools.map((tool) => tool.function.name)).toEqual(["read", "bash", "edit", "write"]);
			for (const tool of tools) {
				expect(tool.function.parameters).toEqual({
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				});
				if (nvidia) expect(tool.function).not.toHaveProperty("strict");
				else expect(tool.function.strict).toBe(false);
			}
			if (nvidia) {
				// Keep October's route settings aligned with upstream Pi's direct NVIDIA handling.
				await streamSimple(
					{ ...model, provider: "nvidia", compat: undefined } as Model<"openai-completions">,
					context,
					{ ...options, apiKey: "fixture-token" },
				).result();
				expect(requests[1]).toEqual(payload);
				expect(payload.max_tokens).toBe(128);
				expect(payload).not.toHaveProperty("store");
				expect(payload).not.toHaveProperty("reasoning_effort");
				expect(payload).not.toHaveProperty("max_completion_tokens");
				expect(payload).not.toHaveProperty("prompt_cache_retention");
			}
			expect(authorizations.every((value) => value === "Bearer fixture-token")).toBe(true);
		},
	);
});
