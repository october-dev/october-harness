import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOctoberLoginCommand } from "../src/cli/october-login.ts";
import { readStoredCredential } from "../src/core/auth-storage.ts";
import { logoutOctober, storeOctoberInferenceToken } from "../src/extensions/october/auth.ts";
import {
	OCTOBER_DEVICE_CODE_PATH,
	OCTOBER_DEVICE_TOKEN_PATH,
	runOctoberDeviceCodeLogin,
} from "../src/extensions/october/device-code.ts";

const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
	delete process.env.OCTOBER_AUTH_BASE_URL;
	delete process.env.OCTOBER_CODING_AGENT_DIR;
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

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ url: string }> {
	const server = createServer((request, response) => {
		void (async () => {
			const body = await readBody(request);
			handler(request, response, body);
		})();
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${address.port}` };
}

describe("october device-code login", () => {
	it("polls until an oct_inf_ token is issued", async () => {
		let polls = 0;
		const stub = await listen((request, response, body) => {
			if (request.url === OCTOBER_DEVICE_CODE_PATH) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						device_code: "dev-1",
						user_code: "ABCD-1234",
						verification_uri: "http://127.0.0.1/verify",
						interval: 0,
						expires_in: 30,
					}),
				);
				return;
			}
			if (request.url === OCTOBER_DEVICE_TOKEN_PATH) {
				polls += 1;
				expect(JSON.parse(body)).toEqual({ device_code: "dev-1" });
				if (polls < 2) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ error: "authorization_pending" }));
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ access_token: "oct_inf_live" }));
			}
		});
		process.env.OCTOBER_AUTH_BASE_URL = stub.url;
		const seen: Array<{ userCode: string; verificationUri: string }> = [];
		const token = await runOctoberDeviceCodeLogin({
			onDeviceCode: (info) => {
				seen.push({ userCode: info.userCode, verificationUri: info.verificationUri });
			},
		});
		expect(token).toBe("oct_inf_live");
		expect(seen).toEqual([{ userCode: "ABCD-1234", verificationUri: "http://127.0.0.1/verify" }]);
	});

	it("fails clearly when the user denies the device", async () => {
		const stub = await listen((request, response) => {
			if (request.url === OCTOBER_DEVICE_CODE_PATH) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						device_code: "dev-denied",
						user_code: "DENY-1",
						verification_uri: "http://127.0.0.1/verify",
						interval: 0,
						expires_in: 30,
					}),
				);
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "access_denied" }));
		});
		process.env.OCTOBER_AUTH_BASE_URL = stub.url;
		await expect(
			runOctoberDeviceCodeLogin({
				onDeviceCode: () => {},
			}),
		).rejects.toThrow(/denied/);
	});

	it("fails clearly when the device code expires", async () => {
		const stub = await listen((request, response) => {
			if (request.url === OCTOBER_DEVICE_CODE_PATH) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						device_code: "dev-exp",
						user_code: "EXP-1",
						verification_uri: "http://127.0.0.1/verify",
						interval: 0,
						expires_in: 30,
					}),
				);
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "expired_token" }));
		});
		process.env.OCTOBER_AUTH_BASE_URL = stub.url;
		await expect(
			runOctoberDeviceCodeLogin({
				onDeviceCode: () => {},
			}),
		).rejects.toThrow(/timed out/);
	});

	it("degrades when the code endpoint is not implemented", async () => {
		const stub = await listen((_request, response) => {
			response.writeHead(404).end();
		});
		process.env.OCTOBER_AUTH_BASE_URL = stub.url;
		await expect(
			runOctoberDeviceCodeLogin({
				onDeviceCode: () => {},
			}),
		).rejects.toThrow(/October login is not available yet/);
	});

	it("stores the token as an api_key credential and logout removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "october-login-"));
		tmpDirs.push(dir);
		process.env.OCTOBER_CODING_AGENT_DIR = dir;
		const authPath = join(dir, "auth.json");
		await storeOctoberInferenceToken("oct_inf_stored", authPath);
		const stored = readStoredCredential("october", authPath);
		expect(stored).toEqual({ type: "api_key", key: "oct_inf_stored" });
		expect(await logoutOctober(authPath)).toBe(true);
		expect(readStoredCredential("october", authPath)).toBeUndefined();
	});
});

describe("october login/logout command routing", () => {
	it("does not steal bare --help from the main CLI", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await handleOctoberLoginCommand(["--help"])).toBe(false);
			expect(await handleOctoberLoginCommand(["-h"])).toBe(false);
			expect(await handleOctoberLoginCommand(["--mode", "json", "--help"])).toBe(false);
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it("prints login help only for login/logout --help", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await handleOctoberLoginCommand(["login", "--help"])).toBe(true);
			expect(await handleOctoberLoginCommand(["logout", "-h"])).toBe(true);
			expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain("october login");
		} finally {
			log.mockRestore();
		}
	});
});
