import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	getDesktopOctoberCredential,
	isOctoberManagedSessionMode,
	managedOctoberSessionNotice,
	OCTOBER_SESSION_REFRESHED_CODE,
	registerOctoberDesktopAuth,
	resetDesktopOctoberState,
	seedOctoberCredential,
} from "../src/extensions/october/auth.ts";
import { createOctoberProviderConfig, OCTOBER_DEFAULT_MODEL_ID } from "../src/extensions/october/provider.ts";

const servers: Server[] = [];
const tmpDirs: string[] = [];
const messages = [{ role: "user" as const, content: "hi", timestamp: 0 }];
const envToken = "env-access-token-lantern";
const savedToken = "oct_inf_standalone_account";

function seconds(offsetMs: number): string {
	return String(Math.floor((Date.now() + offsetMs) / 1000));
}

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "october-managed-"));
	tmpDirs.push(dir);
	return dir;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Loopback October gateway. Bearers in `rejected` get a 401. */
async function gateway(rejected: Set<string> = new Set()): Promise<Array<{ path: string; bearer: string }>> {
	const requests: Array<{ path: string; bearer: string }> = [];
	const url = await listen((request, response) => {
		const bearer = request.headers.authorization ?? "";
		requests.push({ path: request.url ?? "", bearer });
		if (rejected.has(bearer.replace(/^Bearer /, ""))) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { code: "invalid_api_key", message: "invalid October credential" } }));
			return;
		}
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: OCTOBER_DEFAULT_MODEL_ID }] }));
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

/** A token command that prints `rotated-<n>` and counts its invocations. */
function tokenCommand(options: { fail?: boolean } = {}): { calls: () => number } {
	const dir = makeTmpDir();
	const counter = join(dir, "calls");
	const script = join(dir, "token.mjs");
	writeFileSync(counter, "0");
	writeFileSync(
		script,
		[
			'import { readFileSync, writeFileSync } from "node:fs";',
			`const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;`,
			`writeFileSync(${JSON.stringify(counter)}, String(n));`,
			options.fail
				? "process.exit(1);"
				: 'console.log(JSON.stringify({ accessToken: "rotated-" + n, expiresAt: Math.floor(Date.now() / 1000) + 3600 }));',
		].join("\n"),
	);
	vi.stubEnv("OCTOBER_TOKEN_COMMAND", `"${process.execPath}" "${script}"`);
	return { calls: () => Number(readFileSync(counter, "utf8")) };
}

async function createRuntime(storage: AuthStorage): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("october", createOctoberProviderConfig());
	await runtime.refresh({ allowNetwork: false, providers: ["october"] });
	return runtime;
}

/** Captures the handlers registerOctoberDesktopAuth installs. */
function fakeExtensionApi(): {
	pi: ExtensionAPI;
	emit: (event: string, payload: unknown) => Promise<unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
	};
	const ctx = { hasUI: false, model: { provider: "october" } };
	return {
		pi: pi as unknown as ExtensionAPI,
		emit: async (event, payload) => handlers.get(event)?.(payload, ctx),
	};
}

function assistantError(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "october",
		model: OCTOBER_DEFAULT_MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

/** Nothing under the agent dir may contain the env token. */
function expectNothingPersisted(agentDir: string, ...tokens: string[]): void {
	const authPath = join(agentDir, "auth.json");
	expect(existsSync(authPath) ? readFileSync(authPath, "utf8") : "").not.toMatch(/env-access|rotated-/);
	for (const name of readdirSync(agentDir, { recursive: true }) as string[]) {
		const path = join(agentDir, name);
		let content = "";
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const token of tokens) expect(content).not.toContain(token);
	}
}

let agentDir: string;

beforeEach(() => {
	resetDesktopOctoberState();
	agentDir = makeTmpDir();
	vi.stubEnv("OCTOBER_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OCTOBER_BUS_PORT", "");
	vi.stubEnv("OCTOBER_BUS_TOKEN", "");
	vi.stubEnv("OCTOBER_INFERENCE_TOKEN", "");
	vi.stubEnv("OCTOBER_TOKEN_COMMAND", "");
	vi.stubEnv("OCTOBER_SUPABASE_REFRESH_TOKEN", "");
	vi.stubEnv("OCTOBER_SUPABASE_URL", "http://127.0.0.1:1");
	vi.stubEnv("OCTOBER_SUPABASE_ANON_KEY", "fixture-anon");
	vi.stubEnv("OCTOBER_SUPABASE_ACCESS_TOKEN", envToken);
	vi.stubEnv("OCTOBER_SUPABASE_EXPIRES_AT", seconds(3600_000));
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
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("October session from a launching app without a refresh token", () => {
	it("signs in with the access token alone for the catalogue and inference, and persists nothing", async () => {
		const requests = await gateway();
		expect(isOctoberManagedSessionMode()).toBe(true);
		await seedOctoberCredential();
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const write = vi.spyOn(storage, "modify");
		const runtime = await createRuntime(storage);
		expect((await runtime.refresh({ allowNetwork: true, providers: ["october"] })).errors.size).toBe(0);
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("stop");
		expect(requests.map((request) => request.path)).toEqual(["/v1/models", "/v1/chat/completions"]);
		expect(requests.every((request) => request.bearer === `Bearer ${envToken}`)).toBe(true);
		expect(write).not.toHaveBeenCalled();
		expectNothingPersisted(agentDir, envToken);
	});

	it("falls back to /login when the token expired and no token command is set", async () => {
		const requests = await gateway();
		vi.stubEnv("OCTOBER_SUPABASE_EXPIRES_AT", seconds(-60_000));
		await seedOctoberCredential();
		const runtime = await createRuntime(AuthStorage.create(join(agentDir, "auth.json")));
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		const failed = await runtime.completeSimple(model, { messages });
		expect(failed.stopReason).toBe("error");
		expect(requests).toHaveLength(0);
		expect(managedOctoberSessionNotice()).toMatch(/OCTOBER_TOKEN_COMMAND is not set.*Run \/login/);
		expectNothingPersisted(agentDir, envToken);

		const { pi, emit } = fakeExtensionApi();
		registerOctoberDesktopAuth(pi);
		const rewritten = (await emit("message_end", { message: assistantError("No API key found for october") })) as {
			message: AssistantMessage;
		};
		expect(rewritten.message.errorMessage).toMatch(/^The October session from the launching app.*Run \/login/);
	});

	it("uses a stored /login credential once the launching app's token has expired", async () => {
		const requests = await gateway();
		vi.stubEnv("OCTOBER_SUPABASE_EXPIRES_AT", seconds(-60_000));
		const storage = AuthStorage.inMemory({ october: { type: "api_key", key: savedToken } });
		const runtime = await createRuntime(storage);
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("stop");
		expect(requests.at(-1)?.bearer).toBe(`Bearer ${savedToken}`);
	});

	it("refreshes through the token command shortly before expiry", async () => {
		const requests = await gateway();
		const command = tokenCommand();
		vi.stubEnv("OCTOBER_SUPABASE_EXPIRES_AT", seconds(120_000));
		await seedOctoberCredential();
		const runtime = await createRuntime(AuthStorage.create(join(agentDir, "auth.json")));
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("stop");
		expect(command.calls()).toBe(1);
		expect(requests.at(-1)?.bearer).toBe("Bearer rotated-1");
		// The rotated token is fresh, so the next request does not run the command again.
		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("stop");
		expect(command.calls()).toBe(1);
		expectNothingPersisted(agentDir, envToken, "rotated-1");
	});

	it("refreshes through the token command after a 401 and marks the turn for retry", async () => {
		const requests = await gateway(new Set([envToken]));
		const command = tokenCommand();
		await seedOctoberCredential();
		const { pi, emit } = fakeExtensionApi();
		registerOctoberDesktopAuth(pi);
		const runtime = await createRuntime(AuthStorage.create(join(agentDir, "auth.json")));
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;

		const failed = await runtime.completeSimple(model, { messages });
		expect(failed.stopReason).toBe("error");
		expect(command.calls()).toBe(0);
		await emit("after_provider_response", { status: 401, headers: {} });
		expect(command.calls()).toBe(1);
		expect(getDesktopOctoberCredential()?.access).toBe("rotated-1");
		const rewritten = (await emit("message_end", { message: failed })) as { message: AssistantMessage };
		expect(rewritten.message.errorMessage).toContain(OCTOBER_SESSION_REFRESHED_CODE);

		expect((await runtime.completeSimple(model, { messages })).stopReason).toBe("stop");
		expect(requests.at(-1)?.bearer).toBe("Bearer rotated-1");
		expectNothingPersisted(agentDir, envToken, "rotated-1");
	});

	it("falls back to /login when the token command fails after a 401", async () => {
		await gateway(new Set([envToken]));
		const command = tokenCommand({ fail: true });
		await seedOctoberCredential();
		const { pi, emit } = fakeExtensionApi();
		registerOctoberDesktopAuth(pi);
		const runtime = await createRuntime(AuthStorage.create(join(agentDir, "auth.json")));
		const model = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
		const failed = await runtime.completeSimple(model, { messages });
		await emit("after_provider_response", { status: 401, headers: {} });
		expect(command.calls()).toBe(1);
		expect(managedOctoberSessionNotice()).toMatch(/OCTOBER_TOKEN_COMMAND exited with code 1.*Run \/login/);
		const rewritten = (await emit("message_end", { message: failed })) as { message: AssistantMessage };
		expect(rewritten.message.errorMessage).not.toContain(OCTOBER_SESSION_REFRESHED_CODE);
		expect(rewritten.message.errorMessage).toMatch(/Run \/login/);
		await expect(runtime.getAuth("october")).rejects.toThrow(/API key/);
	});

	it("keeps storing a session that carries its own refresh token", async () => {
		vi.stubEnv("OCTOBER_SUPABASE_REFRESH_TOKEN", "standalone-refresh");
		expect(isOctoberManagedSessionMode()).toBe(false);
		await seedOctoberCredential();
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain("standalone-refresh");
	});
});
