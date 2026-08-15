import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredCredential } from "../src/core/auth-storage.ts";
import {
	buildOctoberOAuth,
	OCTOBER_PROVIDER_ID,
	octoberSessionAvailable,
	seedOctoberCredential,
} from "../src/extensions/october/auth.ts";

const servers: Server[] = [];
const tmpDirs: string[] = [];

const SUPABASE_ENV_KEYS = [
	"OCTOBER_SUPABASE_URL",
	"OCTOBER_SUPABASE_ANON_KEY",
	"OCTOBER_SUPABASE_ACCESS_TOKEN",
	"OCTOBER_SUPABASE_REFRESH_TOKEN",
	"OCTOBER_SUPABASE_EXPIRES_AT",
	"OCTOBER_CODING_AGENT_DIR",
] as const;

function clearSupabaseEnv(): void {
	for (const key of SUPABASE_ENV_KEYS) {
		delete process.env[key];
	}
}

function setSupabaseEnv(overrides: Partial<Record<(typeof SUPABASE_ENV_KEYS)[number], string>> = {}): void {
	process.env.OCTOBER_SUPABASE_URL = overrides.OCTOBER_SUPABASE_URL ?? "https://project.supabase.co";
	process.env.OCTOBER_SUPABASE_ANON_KEY = overrides.OCTOBER_SUPABASE_ANON_KEY ?? "anon-key";
	process.env.OCTOBER_SUPABASE_ACCESS_TOKEN = overrides.OCTOBER_SUPABASE_ACCESS_TOKEN ?? "access-1";
	process.env.OCTOBER_SUPABASE_REFRESH_TOKEN = overrides.OCTOBER_SUPABASE_REFRESH_TOKEN ?? "refresh-1";
	if (overrides.OCTOBER_SUPABASE_EXPIRES_AT !== undefined) {
		process.env.OCTOBER_SUPABASE_EXPIRES_AT = overrides.OCTOBER_SUPABASE_EXPIRES_AT;
	}
	if (overrides.OCTOBER_CODING_AGENT_DIR !== undefined) {
		process.env.OCTOBER_CODING_AGENT_DIR = overrides.OCTOBER_CODING_AGENT_DIR;
	}
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; requests: { headers: IncomingMessage["headers"]; body: string }[] }> {
	const requests: { headers: IncomingMessage["headers"]; body: string }[] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const body = await readBody(request);
			requests.push({ headers: request.headers, body });
			await Promise.resolve(handler(request, response)).catch(() => response.writeHead(500).end());
		})();
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${address.port}`, requests };
}

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "october-auth-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	clearSupabaseEnv();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("october auth session gate", () => {
	it("is unavailable unless every Supabase variable is present", () => {
		clearSupabaseEnv();
		expect(octoberSessionAvailable()).toBe(false);
		process.env.OCTOBER_SUPABASE_URL = "https://project.supabase.co";
		process.env.OCTOBER_SUPABASE_ANON_KEY = "anon-key";
		process.env.OCTOBER_SUPABASE_ACCESS_TOKEN = "access-1";
		expect(octoberSessionAvailable()).toBe(false);
		process.env.OCTOBER_SUPABASE_REFRESH_TOKEN = "refresh-1";
		expect(octoberSessionAvailable()).toBe(true);
	});
});

describe("october oauth", () => {
	it("login imports the app session and getApiKey returns the access token", async () => {
		setSupabaseEnv({ OCTOBER_SUPABASE_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 3600) });
		const oauth = buildOctoberOAuth();
		const credential = await oauth.login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(credential.access).toBe("access-1");
		expect(credential.refresh).toBe("refresh-1");
		expect(credential.supabaseUrl).toBe("https://project.supabase.co");
		expect(credential.expires).toBeGreaterThan(Date.now());
		expect(oauth.getApiKey(credential)).toBe("access-1");
	});

	it("login throws a clear message when no October session is present", async () => {
		clearSupabaseEnv();
		const oauth = buildOctoberOAuth();
		await expect(
			oauth.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow(/October app/);
	});

	it("refreshToken exchanges the refresh token against Supabase and maps the new session", async () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 3600;
		const stub = await listen((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_at: expiresAt }));
		});
		const oauth = buildOctoberOAuth();
		const refreshed = await oauth.refreshToken(
			{ access: "access-1", refresh: "refresh-1", expires: 0, supabaseUrl: stub.url, supabaseAnonKey: "anon-key" },
			AbortSignal.timeout(5000),
		);
		expect(refreshed.access).toBe("access-2");
		expect(refreshed.refresh).toBe("refresh-2");
		expect(refreshed.expires).toBeLessThanOrEqual(expiresAt * 1000);
		expect(stub.requests[0]?.headers.apikey).toBe("anon-key");
		expect(JSON.parse(stub.requests[0]?.body ?? "{}")).toEqual({ refresh_token: "refresh-1" });
	});

	it("refreshToken throws on an error response", async () => {
		const stub = await listen((_request, response) => {
			response.writeHead(401).end();
		});
		const oauth = buildOctoberOAuth();
		await expect(
			oauth.refreshToken(
				{ access: "a", refresh: "r", expires: 0, supabaseUrl: stub.url, supabaseAnonKey: "anon-key" },
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow(/HTTP 401/);
	});
});

describe("october credential seeding", () => {
	it("writes the app session into the credential store, is idempotent, and lets a fresher session win", async () => {
		const dir = makeTmpDir();
		const authPath = join(dir, "auth.json");
		const nowSeconds = Math.floor(Date.now() / 1000);

		setSupabaseEnv({ OCTOBER_CODING_AGENT_DIR: dir, OCTOBER_SUPABASE_EXPIRES_AT: String(nowSeconds + 1800) });
		await seedOctoberCredential();
		const first = readStoredCredential(OCTOBER_PROVIDER_ID, authPath);
		expect(first?.type).toBe("oauth");
		if (first?.type !== "oauth") return;
		expect(first.access).toBe("access-1");
		const firstExpires = first.expires;

		// Same-or-staler env must not overwrite a stored session.
		await seedOctoberCredential();
		const second = readStoredCredential(OCTOBER_PROVIDER_ID, authPath);
		expect(second?.type === "oauth" ? second.expires : undefined).toBe(firstExpires);

		// A fresher app session replaces the stored one.
		setSupabaseEnv({
			OCTOBER_CODING_AGENT_DIR: dir,
			OCTOBER_SUPABASE_ACCESS_TOKEN: "access-fresh",
			OCTOBER_SUPABASE_EXPIRES_AT: String(nowSeconds + 7200),
		});
		await seedOctoberCredential();
		const third = readStoredCredential(OCTOBER_PROVIDER_ID, authPath);
		expect(third?.type === "oauth" ? third.access : undefined).toBe("access-fresh");
	});

	it("is a no-op when no October session is present", async () => {
		const dir = makeTmpDir();
		clearSupabaseEnv();
		process.env.OCTOBER_CODING_AGENT_DIR = dir;
		await seedOctoberCredential();
		expect(readStoredCredential(OCTOBER_PROVIDER_ID, join(dir, "auth.json"))).toBeUndefined();
	});
});
