import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLoopbackOnlyLookup,
	endpointFromUrl,
	isLoopbackHostname,
	type LocalEndpoint,
	parseModelList,
	planModelsConfig,
	probeEndpoint,
	runLocalModelsCommand,
} from "../src/cli/local-models.ts";
import { ModelConfig } from "../src/core/model-config.ts";

const servers: Server[] = [];
let requestCount = 0;

async function fakeServer(handler: RequestListener, host = "127.0.0.1"): Promise<string> {
	const server = createServer((request, response) => {
		requestCount++;
		handler(request, response);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	return `http://${host}:${(server.address() as AddressInfo).port}`;
}

function json(body: unknown): RequestListener {
	return (_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
}

/** A port with nothing listening: bind, read the port, close. */
async function closedPort(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}

function ollamaAt(origin: string): LocalEndpoint {
	return {
		providerId: "ollama",
		label: "Ollama",
		baseUrl: `${origin}/v1`,
		listUrl: `${origin}/api/tags`,
		format: "ollama",
	};
}

function openAiAt(origin: string, providerId = "lmstudio"): LocalEndpoint {
	return { providerId, label: providerId, baseUrl: `${origin}/v1`, listUrl: `${origin}/v1/models`, format: "openai" };
}

afterEach(async () => {
	requestCount = 0;
	await Promise.all(
		servers.splice(0).map((server) => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		}),
	);
});

describe("parseModelList", () => {
	it("reads Ollama tags and OpenAI-compatible model lists", () => {
		expect(parseModelList("ollama", { models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.2:3b" }] })).toEqual([
			{ id: "qwen2.5-coder:7b" },
			{ id: "llama3.2:3b" },
		]);
		expect(parseModelList("openai", { object: "list", data: [{ id: "a" }, { id: "b" }] })).toEqual([
			{ id: "a" },
			{ id: "b" },
		]);
	});

	it("keeps a positive integer max_model_len as the context window and ignores anything else", () => {
		const data = [
			{ id: "vllm", max_model_len: 8192 },
			{ id: "zero", max_model_len: 0 },
			{ id: "fraction", max_model_len: 8192.5 },
			{ id: "text", max_model_len: "8192" },
		];
		expect(parseModelList("openai", { data })).toEqual([
			{ id: "vllm", contextWindow: 8192 },
			{ id: "zero" },
			{ id: "fraction" },
			{ id: "text" },
		]);
	});

	it("drops duplicates and IDs that are empty, too long, non-strings, or contain control characters", () => {
		const data = [
			{ id: "a" },
			{ id: "a" },
			{ id: "" },
			{ id: 7 },
			{ id: "x".repeat(257) },
			{ id: "bad\nid" },
			{},
			null,
		];
		expect(parseModelList("openai", { data })).toEqual([{ id: "a" }]);
	});

	it("rejects responses without a model array", () => {
		expect(() => parseModelList("openai", { models: [] })).toThrow("no data array");
		expect(() => parseModelList("ollama", null)).toThrow("no models array");
	});
});

describe("loopback restriction", () => {
	it("accepts only loopback hosts", () => {
		for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "[::1]", "::1"]) {
			expect(isLoopbackHostname(host), host).toBe(true);
		}
		for (const host of [
			"192.168.1.20",
			"10.0.0.1",
			"0.0.0.0",
			"example.com",
			"127.0.0.1.nip.io",
			"[::]",
			"localhost.lan",
		]) {
			expect(isLoopbackHostname(host), host).toBe(false);
		}
	});

	it("builds an endpoint from a loopback URL and appends /v1 to a bare origin", () => {
		expect(endpointFromUrl("http://localhost:8080")).toMatchObject({
			providerId: "local-8080",
			baseUrl: "http://localhost:8080/v1",
			listUrl: "http://localhost:8080/v1/models",
			format: "openai",
		});
		expect(endpointFromUrl("http://127.0.0.1:9000/openai/v1/", "my-server")).toMatchObject({
			providerId: "my-server",
			baseUrl: "http://127.0.0.1:9000/openai/v1",
		});
	});

	it("rejects LAN and remote URLs, embedded credentials, other schemes, and bad provider IDs", () => {
		expect(() => endpointFromUrl("http://192.168.1.20:11434")).toThrow("must point at this machine");
		expect(() => endpointFromUrl("https://api.example.com/v1")).toThrow("must point at this machine");
		expect(() => endpointFromUrl("http://user:pw@localhost:8000")).toThrow("credentials");
		expect(() => endpointFromUrl("ftp://localhost/models")).toThrow("http or https");
		expect(() => endpointFromUrl("not a url")).toThrow("Not a valid URL");
		expect(() => endpointFromUrl("http://localhost:8000", "../evil")).toThrow("--provider");
		for (const reserved of ["openai", "llama.cpp", "october", "radius", "anthropic"]) {
			expect(() => endpointFromUrl("http://localhost:8000", reserved), reserved).toThrow("already ships");
		}
	});
});

describe("createLoopbackOnlyLookup", () => {
	type Address = { address: string; family: number };
	function lookupWith(addresses: Address[], all: boolean) {
		const lookup = createLoopbackOnlyLookup((_hostname, _options, callback) => callback(null, addresses));
		return new Promise<{ error: Error | null; address: unknown; family: unknown }>((done) =>
			lookup("localhost", { all }, (error, address, family) => done({ error: error ?? null, address, family })),
		);
	}

	it("passes loopback results through in both callback shapes", async () => {
		const both = [
			{ address: "::1", family: 6 },
			{ address: "127.0.0.1", family: 4 },
		];
		await expect(lookupWith(both, true)).resolves.toMatchObject({ error: null, address: both });
		await expect(lookupWith(both, false)).resolves.toMatchObject({ error: null, address: "::1", family: 6 });
	});

	it("refuses a name that resolves anywhere off this machine, or nowhere", async () => {
		const remapped = [
			{ address: "127.0.0.1", family: 4 },
			{ address: "192.168.1.20", family: 4 },
		];
		for (const addresses of [remapped, [{ address: "203.0.113.7", family: 4 }], []]) {
			for (const all of [true, false]) {
				const result = await lookupWith(addresses, all);
				expect(result.error?.message).toContain("does not resolve to a loopback address");
			}
		}
	});
});

describe("probeEndpoint", () => {
	it("reaches a server through the localhost name", async () => {
		const origin = await fakeServer(json({ data: [{ id: "via-name" }] }), "localhost");
		await expect(probeEndpoint(endpointFromUrl(origin, "named"))).resolves.toMatchObject({
			models: [{ id: "via-name" }],
		});
	});

	it("returns the models a server reports", async () => {
		const origin = await fakeServer(json({ models: [{ name: "qwen2.5-coder:7b" }] }));
		await expect(probeEndpoint(ollamaAt(origin))).resolves.toMatchObject({ models: [{ id: "qwen2.5-coder:7b" }] });
	});

	it("reports a server that is not running", async () => {
		await expect(probeEndpoint(ollamaAt(await closedPort()))).resolves.toMatchObject({ error: "not running" });
	});

	it("gives up after the timeout", async () => {
		const origin = await fakeServer(() => {});
		await expect(probeEndpoint(ollamaAt(origin), 100)).resolves.toMatchObject({ error: "no answer within 100 ms" });
	});

	it("does not follow redirects", async () => {
		let followed = false;
		const target = await fakeServer((request, response) => {
			followed = true;
			json({ data: [{ id: "x" }] })(request, response);
		});
		const origin = await fakeServer((_request, response) => {
			response.writeHead(302, { location: `${target}/v1/models` });
			response.end();
		});
		await expect(probeEndpoint(openAiAt(origin))).resolves.toMatchObject({ error: "HTTP 302" });
		expect(followed).toBe(false);
	});

	it("rejects non-JSON and oversized responses", async () => {
		const html = await fakeServer((_request, response) => {
			response.writeHead(200);
			response.end("<html></html>");
		});
		await expect(probeEndpoint(openAiAt(html))).resolves.toMatchObject({ error: "response is not JSON" });
		const huge = await fakeServer((_request, response) => {
			response.writeHead(200);
			response.end("x".repeat(1024 * 1024 + 1));
		});
		await expect(probeEndpoint(openAiAt(huge))).resolves.toMatchObject({ error: "response is larger than 1 MiB" });
	});
});

describe("planModelsConfig", () => {
	const endpoint = openAiAt("http://127.0.0.1:1234");

	it("adds a keyless provider without asking for a secret", () => {
		const plan = planModelsConfig({ providers: {} }, [{ endpoint, models: [{ id: "m1" }] }]);
		expect(plan.config.providers.lmstudio).toEqual({
			name: "lmstudio",
			baseUrl: "http://127.0.0.1:1234/v1",
			api: "openai-completions",
			apiKey: "lmstudio",
			models: [{ id: "m1" }],
		});
		expect(plan.changes).toEqual([{ providerId: "lmstudio", newProvider: true, addedModels: [{ id: "m1" }] }]);
	});

	it("adds only missing models and keeps existing settings, other providers, and the input untouched", () => {
		const existing = {
			$schema: "kept",
			providers: {
				lmstudio: {
					baseUrl: "http://127.0.0.1:1234/v1",
					apiKey: "$MY_KEY",
					models: [{ id: "m1", contextWindow: 32000 }],
				},
				other: { baseUrl: "https://example.test/v1" },
			},
		};
		const snapshot = structuredClone(existing);
		const plan = planModelsConfig(existing, [
			{ endpoint, models: [{ id: "m1", contextWindow: 4096 }, { id: "m2" }] },
		]);
		expect(plan.config.providers.lmstudio).toEqual({
			baseUrl: "http://127.0.0.1:1234/v1",
			apiKey: "$MY_KEY",
			models: [{ id: "m1", contextWindow: 32000 }, { id: "m2" }],
		});
		expect(plan.config.providers.other).toEqual(existing.providers.other);
		expect(plan.config.$schema).toBe("kept");
		expect(plan.changes).toEqual([{ providerId: "lmstudio", newProvider: false, addedModels: [{ id: "m2" }] }]);
		expect(existing).toEqual(snapshot);
	});

	it("treats localhost and a trailing slash as the same endpoint", () => {
		const existing = { providers: { lmstudio: { baseUrl: "http://localhost:1234/v1/", models: [{ id: "m1" }] } } };
		const plan = planModelsConfig(existing, [{ endpoint, models: [{ id: "m1" }, { id: "m2" }] }]);
		expect(plan.conflicts).toEqual([]);
		expect(plan.config.providers.lmstudio).toEqual({
			baseUrl: "http://localhost:1234/v1/",
			models: [{ id: "m1" }, { id: "m2" }],
		});
	});

	it("leaves a same-named provider that points elsewhere alone", () => {
		const existing = { providers: { lmstudio: { baseUrl: "http://10.0.0.5:1234/v1", models: [] } } };
		const plan = planModelsConfig(existing, [{ endpoint, models: [{ id: "m1" }] }]);
		expect(plan.config.providers.lmstudio).toBe(existing.providers.lmstudio);
		expect(plan.changes).toEqual([]);
		expect(plan.conflicts[0]).toContain("http://10.0.0.5:1234/v1");
	});
});

describe("october local-models", () => {
	let agentDir: string;
	let modelsPath: string;
	let output: string[];
	let errors: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "october-local-models-"));
		modelsPath = join(agentDir, "models.json");
		output = [];
		errors = [];
	});

	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	async function run(
		args: string[],
		endpoints: LocalEndpoint[],
		extra: { confirm?: boolean; interactive?: boolean; whileAsking?: () => void } = {},
	) {
		const questions: string[] = [];
		const code = await runLocalModelsCommand(args, {
			agentDir,
			endpoints,
			interactive: extra.interactive ?? true,
			log: (line) => output.push(line),
			error: (line) => errors.push(line),
			confirm: async (question) => {
				questions.push(question);
				extra.whileAsking?.();
				return extra.confirm ?? true;
			},
		});
		return { code, questions };
	}

	it("previews, asks once, writes a models.json the harness loads, and is idempotent", async () => {
		const ollama = await fakeServer(json({ models: [{ name: "qwen2.5-coder:7b" }] }));
		const lmstudio = await fakeServer(json({ data: [{ id: "openai/gpt-oss-20b" }] }));
		const endpoints = [ollamaAt(ollama), openAiAt(lmstudio), openAiAt(await closedPort(), "vllm")];

		const first = await run([], endpoints);
		expect(first.code).toBe(0);
		expect(first.questions).toHaveLength(1);
		expect(output.join("\n")).toContain('"qwen2.5-coder:7b"');
		expect(output.join("\n")).toMatch(/vllm .* not running/);

		const config = await ModelConfig.load(modelsPath);
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toEqual(["ollama", "lmstudio"]);
		expect(config.getProvider("ollama")?.models).toEqual([{ id: "qwen2.5-coder:7b" }]);
		if (process.platform !== "win32") expect(statSync(modelsPath).mode & 0o777).toBe(0o600);

		const second = await run([], endpoints);
		expect(second.code).toBe(0);
		expect(second.questions).toHaveLength(0);
		expect(output.at(-1)).toContain("Nothing to add");
	});

	it("writes nothing when the user declines", async () => {
		const origin = await fakeServer(json({ models: [{ name: "m" }] }));
		const { code } = await run([], [ollamaAt(origin)], { confirm: false });
		expect(code).toBe(0);
		expect(() => statSync(modelsPath)).toThrow();
	});

	it("requires --yes when it cannot ask", async () => {
		const origin = await fakeServer(json({ models: [{ name: "m" }] }));
		const refused = await run([], [ollamaAt(origin)], { interactive: false });
		expect(refused.code).toBe(1);
		expect(errors.at(-1)).toContain("--yes");
		expect(() => statSync(modelsPath)).toThrow();

		const accepted = await run(["--yes"], [ollamaAt(origin)], { interactive: false });
		expect(accepted.code).toBe(0);
		expect(accepted.questions).toHaveLength(0);
		expect(JSON.parse(readFileSync(modelsPath, "utf8")).providers.ollama.models).toEqual([{ id: "m" }]);
	});

	it("does not rewrite a models.json with comments, or one that is invalid", async () => {
		const origin = await fakeServer(json({ models: [{ name: "m" }] }));
		const commented = '{\n  // my notes\n  "providers": {}\n}\n';
		writeFileSync(modelsPath, commented);
		expect((await run([], [ollamaAt(origin)])).code).toBe(1);
		expect(readFileSync(modelsPath, "utf8")).toBe(commented);
		expect(errors.at(-1)).toContain("by hand");

		writeFileSync(modelsPath, "{ nope");
		expect((await run([], [ollamaAt(origin)])).code).toBe(1);
		expect(readFileSync(modelsPath, "utf8")).toBe("{ nope");
	});

	it("probes a user-entered loopback URL and refuses anything else before probing", async () => {
		const origin = await fakeServer(json({ data: [{ id: "served" }] }));
		const { code } = await run(["--url", origin, "--provider", "llamacpp", "--yes"], []);
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(modelsPath, "utf8")).providers.llamacpp.baseUrl).toBe(`${origin}/v1`);

		expect((await run(["--url", "http://192.168.1.20:11434"], [])).code).toBe(1);
		expect(errors.at(-1)).toContain("must point at this machine");
		expect(output.some((line) => line.includes("192.168"))).toBe(false);
	});

	it("does not overwrite an edit made while the prompt is open", async () => {
		const origin = await fakeServer(json({ models: [{ name: "m" }] }));
		const edited = `${JSON.stringify({ providers: { mine: { baseUrl: "http://127.0.0.1:9/v1" } } })}\n`;
		const { code } = await run([], [ollamaAt(origin)], { whileAsking: () => writeFileSync(modelsPath, edited) });
		expect(code).toBe(1);
		expect(errors.at(-1)).toContain("changed while waiting");
		expect(readFileSync(modelsPath, "utf8")).toBe(edited);
	});

	it.skipIf(process.platform === "win32")("rewrites the target of a symlinked models.json", async () => {
		const origin = await fakeServer(json({ models: [{ name: "m" }] }));
		const real = join(agentDir, "dotfiles-models.json");
		writeFileSync(real, '{ "providers": {} }\n');
		symlinkSync(real, modelsPath);
		expect((await run(["--yes"], [ollamaAt(origin)])).code).toBe(0);
		expect(lstatSync(modelsPath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(real, "utf8")).providers.ollama.models).toEqual([{ id: "m" }]);
	});

	it("prints help even with other bad options, and bounds --timeout", async () => {
		expect((await run(["--url", "http://10.0.0.1", "--help"], [])).code).toBe(0);
		expect(output.join("\n")).toContain("local-models [--url <url>]");
		expect((await run(["--timeout", "9999999999"], [])).code).toBe(1);
		expect(errors.at(-1)).toContain("from 1 to 60000");
	});

	it("writes the context window vLLM reports and keeps maxTokens within it", async () => {
		const origin = await fakeServer(
			json({
				data: [
					{ id: "small", max_model_len: 8192 },
					{ id: "large", max_model_len: 131072 },
				],
			}),
		);
		expect((await run(["--yes"], [openAiAt(origin, "vllm")])).code).toBe(0);
		const config = await ModelConfig.load(modelsPath);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("vllm")?.models).toEqual([
			{ id: "small", contextWindow: 8192, maxTokens: 8192 },
			{ id: "large", contextWindow: 131072, maxTokens: 16384 },
		]);
	});

	it("refuses provider names October already ships before probing", async () => {
		const origin = await fakeServer(json({ data: [{ id: "m" }] }));
		for (const reserved of ["openai", "llama.cpp"]) {
			const { code, questions } = await run(["--url", origin, "--provider", reserved, "--yes"], []);
			expect(code, reserved).toBe(1);
			expect(questions).toHaveLength(0);
			expect(errors.at(-1)).toContain("already ships");
		}
		expect(requestCount).toBe(0);
		expect(() => statSync(modelsPath)).toThrow();
	});

	it("refuses an existing models.json that October's loader would reject, without probing or prompting", async () => {
		const origin = await fakeServer(json({ data: [{ id: "m" }] }));
		const invalid = [
			{ providers: { lmstudio: { baseUrl: `${origin}/v1`, models: { id: "m", contextWindow: 8192 } } } },
			{ providers: { lmstudio: { baseUrl: `${origin}/v1`, models: [null] } } },
			{ providers: { lmstudio: null } },
		];
		for (const config of invalid) {
			const text = `${JSON.stringify(config, null, 2)}\n`;
			writeFileSync(modelsPath, text);
			const { code, questions } = await run(["--yes"], [openAiAt(origin)]);
			expect(code).toBe(1);
			expect(questions).toHaveLength(0);
			expect(errors.at(-1)).toContain("is not a valid models.json at /providers/lmstudio");
			expect(readFileSync(modelsPath, "utf8")).toBe(text);
		}
		expect(requestCount).toBe(0);
	});

	it("does not restore a model the user deleted while the prompt was open", async () => {
		const origin = await fakeServer(json({ data: [{ id: "a" }, { id: "b" }] }));
		writeFileSync(
			modelsPath,
			`${JSON.stringify({ providers: { lmstudio: { baseUrl: `${origin}/v1`, models: [{ id: "a" }] } } })}\n`,
		);
		const deleted = `${JSON.stringify({ providers: { lmstudio: { baseUrl: `${origin}/v1`, models: [] } } })}\n`;
		const { code } = await run([], [openAiAt(origin)], { whileAsking: () => writeFileSync(modelsPath, deleted) });
		expect(code).toBe(1);
		expect(errors.at(-1)).toContain("changed while waiting");
		expect(readFileSync(modelsPath, "utf8")).toBe(deleted);
	});

	it("fails when every discovered provider conflicts with an existing one", async () => {
		const origin = await fakeServer(json({ data: [{ id: "m" }] }));
		writeFileSync(
			modelsPath,
			`${JSON.stringify({ providers: { lmstudio: { baseUrl: "http://10.0.0.5:1234/v1" } } })}\n`,
		);
		expect((await run([], [openAiAt(origin)])).code).toBe(1);
		expect(errors.some((line) => line.includes("Skipped"))).toBe(true);
		expect(output.some((line) => line.includes("Nothing to add"))).toBe(false);
	});

	it("previews only the added models for an existing provider, not its settings", async () => {
		const origin = await fakeServer(json({ data: [{ id: "a" }, { id: "b" }] }));
		writeFileSync(
			modelsPath,
			`${JSON.stringify({ providers: { lmstudio: { baseUrl: `${origin}/v1`, apiKey: "sk-literal", models: [{ id: "a" }] } } })}\n`,
		);
		expect((await run([], [openAiAt(origin)])).code).toBe(0);
		expect(output.join("\n")).not.toContain("sk-literal");
		expect(JSON.parse(readFileSync(modelsPath, "utf8")).providers.lmstudio).toEqual({
			baseUrl: `${origin}/v1`,
			apiKey: "sk-literal",
			models: [{ id: "a" }, { id: "b" }],
		});
	});

	it("fails clearly when no server answers", async () => {
		const { code } = await run([], [ollamaAt(await closedPort())]);
		expect(code).toBe(1);
		expect(errors.at(-1)).toContain("No local models found");
	});
});
