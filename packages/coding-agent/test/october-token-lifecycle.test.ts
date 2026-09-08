import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOctoberLoginCommand } from "../src/cli/october-login.ts";
import { AuthStorage, InMemoryAuthStorageBackend, readStoredCredential } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetDesktopOctoberState } from "../src/extensions/october/auth.ts";
import * as deviceCode from "../src/extensions/october/device-code.ts";
import { createOctoberProviderConfig } from "../src/extensions/october/provider.ts";
import {
	loginOctoberWithStore,
	logoutOctoberWithStore,
	OctoberTokenCleanupError,
	recoverOctoberTokenFile,
	retryOctoberTokenCleanup,
	saveOctoberCredential,
} from "../src/extensions/october/token-lifecycle.ts";

const A = `oct_inf_${"a".repeat(43)}`;
const B = `oct_inf_${"b".repeat(43)}`;
const C = `oct_inf_${"c".repeat(43)}`;
const key = (token: string): Credential => ({ type: "api_key", key: token });
const directories: string[] = [];
let store: AuthStorage;
let authPath: string;
let revoked: string[];
let revoke: (token: string) => Promise<boolean>;
let previousExitCode: typeof process.exitCode;

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function pending(): string[] {
	return (JSON.parse(readFileSync(`${authPath}.october-pending.json`, "utf8")) as { tokens: string[] }).tokens;
}

class FailingBackend extends InMemoryAuthStorageBackend {
	failure: "before" | "after" | undefined;
	override async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		let failAfter = false;
		const result = await super.withLockAsync(async (current) => {
			const change = await fn(current);
			if (change.next && this.failure) {
				const failure = this.failure;
				this.failure = undefined;
				if (failure === "before") throw new Error(`fixture persistence failure ${B}`);
				failAfter = true;
			}
			return change;
		}, options);
		if (failAfter) throw new Error(`fixture failure after commit ${B}`);
		return result;
	}
}

async function runtime(storage = store): Promise<ModelRuntime> {
	const result = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });
	result.registerProvider("october", createOctoberProviderConfig());
	await result.refresh({ allowNetwork: false, providers: ["october"] });
	return result;
}

beforeEach(async () => {
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	resetDesktopOctoberState();
	const directory = mkdtempSync(join(tmpdir(), "october-lifecycle-test-"));
	directories.push(directory);
	authPath = join(directory, "auth.json");
	store = AuthStorage.create(authPath);
	await store.modify("october", async () => key(A));
	await store.modify("anthropic", async () => ({ type: "api_key", key: "unrelated" }));
	vi.stubEnv("OCTOBER_CODING_AGENT_DIR", directory);
	vi.stubEnv("OCTOBER_BUS_PORT", "");
	vi.stubEnv("OCTOBER_SUPABASE_ACCESS_TOKEN", "");
	vi.stubEnv("OCTOBER_SUPABASE_REFRESH_TOKEN", "");
	vi.stubEnv("OCTOBER_INFERENCE_TOKEN", "");
	vi.stubEnv("OCTOBER_AUTH_BASE_URL", "");
	revoked = [];
	revoke = async () => true;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://www.october.dev/api/cli/device/revoke");
			expect(init?.method).toBe("DELETE");
			const token = new Headers(init?.headers).get("Authorization")!.slice("Bearer ".length);
			revoked.push(token);
			return new Response(null, { status: (await revoke(token)) ? 204 : 503 });
		}),
	);
});

afterEach(() => {
	resetDesktopOctoberState();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	process.exitCode = previousExitCode;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("October token lifecycle", () => {
	it("CLI relogin revokes superseded tokens, then logout revokes only the latest token", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(deviceCode, "runOctoberDeviceCodeLogin").mockResolvedValueOnce(B).mockResolvedValueOnce(C);
		await handleOctoberLoginCommand(["login", "--no-browser"]);
		await handleOctoberLoginCommand(["login", "--no-browser"]);
		expect(readStoredCredential("october", authPath)).toEqual(key(C));
		expect(revoked).toEqual([A, B]);
		await handleOctoberLoginCommand(["logout"]);
		expect(revoked).toEqual([A, B, C]);
		expect(readStoredCredential("october", authPath)).toBeUndefined();
		expect(readStoredCredential("anthropic", authPath)).toEqual({ type: "api_key", key: "unrelated" });
		expect(pending()).toEqual([]);
	});

	it("interactive OAuth login uses the same lifecycle without a second generic credential write", async () => {
		vi.spyOn(deviceCode, "runOctoberDeviceCodeLogin").mockResolvedValueOnce(B).mockResolvedValueOnce(C);
		const models = await runtime();
		const genericWrite = vi.spyOn(store, "modify");
		const interaction = { prompt: async () => "unused", notify: () => {} };
		await models.login("october", "oauth", interaction);
		await models.login("october", "oauth", interaction);
		expect((await models.getAuth("october"))?.auth.apiKey).toBe(C);
		expect(revoked).toEqual([A, B]);
		expect(genericWrite).not.toHaveBeenCalled();
		await models.logout("october");
		expect(revoked).toEqual([A, B, C]);
		expect(await store.read("october")).toBeUndefined();
	});

	it("holds the real file lock through logout so a later login cannot be deleted", async () => {
		const laterStore = AuthStorage.create(authPath);
		const entered = gate();
		const release = gate();
		revoke = async (token) => {
			if (token === A) {
				entered.resolve();
				await release.promise;
			}
			return true;
		};
		const logout = logoutOctoberWithStore(store);
		await entered.promise;
		expect(existsSync(`${authPath}.lock`)).toBe(true);
		const attempt = vi.spyOn(laterStore, "transactCredential");
		const login = saveOctoberCredential(laterStore, key(B));
		expect(attempt).toHaveBeenCalled();
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		release.resolve();
		await Promise.all([logout, login]);
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
		expect(revoked).toEqual([A]);
	});

	it("serializes concurrent file-backed logins and never revokes the last committed token", async () => {
		const laterStore = AuthStorage.create(authPath);
		const entered = gate();
		const release = gate();
		revoke = async (token) => {
			if (token === A) {
				entered.resolve();
				await release.promise;
			}
			return true;
		};
		const first = saveOctoberCredential(store, key(B));
		await entered.promise;
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
		const second = saveOctoberCredential(laterStore, key(C));
		release.resolve();
		await Promise.all([first, second]);
		expect(readStoredCredential("october", authPath)).toEqual(key(C));
		expect(revoked).toEqual([A, B]);
	});

	it("retains failed cleanup durably and a fresh store retries without revoking the active login", async () => {
		revoke = async () => false;
		await expect(saveOctoberCredential(store, key(B))).rejects.toMatchObject({ credentialSaved: true });
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
		expect(pending()).toEqual([A, B]);
		if (process.platform !== "win32") expect(statSync(`${authPath}.october-pending.json`).mode & 0o777).toBe(0o600);
		revoke = async () => true;
		await retryOctoberTokenCleanup(AuthStorage.create(authPath));
		expect(revoked).toEqual([A, A]);
		expect(pending()).toEqual([]);
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
	});

	it("does not mint another token when earlier cleanup is still failing", async () => {
		revoke = async () => false;
		await expect(saveOctoberCredential(store, key(B))).rejects.toThrow("cleanup is incomplete");
		const acquire = vi.fn(async () => key(C));
		await expect(loginOctoberWithStore(store, acquire)).rejects.toThrow("revocation failed");
		expect(acquire).not.toHaveBeenCalled();
	});

	it("failed CLI logout retains the token, returns failure, and never prints successful logout", async () => {
		revoke = async () => false;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await handleOctoberLoginCommand(["logout"]);
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(error.mock.calls.flat().join(" ")).toContain("retained");
		expect(error.mock.calls.flat().join(" ")).not.toContain(A);
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(pending()).toEqual([A]);
	});

	it("failed interactive logout retains both credential and retry state", async () => {
		const models = await runtime();
		revoke = async () => false;
		await expect(models.logout("october")).rejects.toThrow("retained");
		expect(await store.read("october")).toEqual(key(A));
		expect(pending()).toEqual([A]);
	});

	it("failed local logout removal is reported and the retained credential can be retried", async () => {
		const backend = new FailingBackend();
		const memory = AuthStorage.fromStorage(backend);
		await memory.modify("october", async () => key(A));
		backend.failure = "before";
		await expect(logoutOctoberWithStore(memory)).rejects.toThrow("removal was not confirmed");
		expect(await memory.read("october")).toEqual(key(A));
		await expect(logoutOctoberWithStore(memory)).resolves.toBe(true);
		expect(await memory.read("october")).toBeUndefined();
		expect(revoked).toEqual([A, A]);
	});

	it("failed local persistence preserves the old credential and compensates the uncommitted token", async () => {
		const backend = new FailingBackend();
		const memory = AuthStorage.fromStorage(backend);
		await memory.modify("october", async () => key(A));
		backend.failure = "before";
		await expect(saveOctoberCredential(memory, key(B))).rejects.toThrow("Uncommitted tokens were revoked");
		expect(await memory.read("october")).toEqual(key(A));
		expect(revoked).toEqual([B]);
	});

	it("retains recovery state when local persistence and compensating revocation both fail", async () => {
		const backend = new FailingBackend();
		const memory = AuthStorage.fromStorage(backend);
		await memory.modify("october", async () => key(A));
		backend.failure = "before";
		revoke = async () => false;
		await expect(saveOctoberCredential(memory, key(B))).rejects.toThrow("Pending tokens remain");
		expect(await memory.read("october")).toEqual(key(A));
		revoke = async () => true;
		await retryOctoberTokenCleanup(memory);
		expect(revoked).toEqual([B, B]);
		expect(await memory.read("october")).toEqual(key(A));
	});

	it("interactive API-key persistence failure never revokes the caller's pasted token", async () => {
		const backend = new FailingBackend();
		const memory = AuthStorage.fromStorage(backend);
		await memory.modify("october", async () => key(A));
		const models = await runtime(memory);
		backend.failure = "before";
		await expect(models.login("october", "api_key", { prompt: async () => B, notify: () => {} })).rejects.toThrow(
			"supplied credential was not revoked",
		);
		expect(await memory.read("october")).toEqual(key(A));
		expect(revoked).toEqual([]);
	});

	it("a fresh file-backed store recovers a token after both credential persistence and revocation fail", async () => {
		const transact = store.transactCredential.bind(store);
		vi.spyOn(store, "transactCredential").mockImplementationOnce((provider, fn, options) =>
			transact(
				provider,
				async (current) => {
					await fn(current);
					throw new Error("fixture auth write failure after journal commit");
				},
				options,
			),
		);
		revoke = async () => false;
		await expect(saveOctoberCredential(store, key(B))).rejects.toThrow("Pending tokens remain");
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(pending()).toEqual([A, B]);
		revoke = async () => true;
		await retryOctoberTokenCleanup(AuthStorage.create(authPath));
		expect(revoked).toEqual([B, B]);
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(pending()).toEqual([]);
	});

	it("re-reads ambiguous commits instead of revoking a token that actually became active", async () => {
		const backend = new FailingBackend();
		const memory = AuthStorage.fromStorage(backend);
		await memory.modify("october", async () => key(A));
		backend.failure = "after";
		await expect(saveOctoberCredential(memory, key(B))).rejects.toThrow("current stored credential was preserved");
		expect(await memory.read("october")).toEqual(key(B));
		expect(revoked).toEqual([A]);
	});

	it("cancellation after issuance revokes the new token without replacing the old login", async () => {
		const controller = new AbortController();
		await expect(
			loginOctoberWithStore(
				store,
				async () => {
					controller.abort();
					return key(B);
				},
				{ signal: controller.signal },
			),
		).rejects.toThrow("cancelled");
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(revoked).toEqual([B]);
	});

	it("uses a private recovery file if the store cannot be locked and remote compensation fails", async () => {
		vi.spyOn(store, "transactCredential").mockRejectedValueOnce(new Error(`fixture lock failure ${B}`));
		revoke = async () => false;
		let message = "";
		try {
			await saveOctoberCredential(store, key(B));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).not.toContain(B);
		const path = message.split("--recovery-file ")[1];
		expect(path).toBeTruthy();
		directories.push(join(path, ".."));
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		await expect(recoverOctoberTokenFile(path)).rejects.toThrow("Recovery file retained");
		expect(JSON.parse(readFileSync(path, "utf8")).tokens).toEqual([B]);
		revoke = async () => true;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await handleOctoberLoginCommand(["logout", "--recovery-file", path]);
		expect(log.mock.calls.flat().join(" ")).toContain("Current login unchanged");
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(revoked).toEqual([B, B, B]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, purpose: "uncommitted", tokens: [] });
	});

	it("keeps the same active token and never tries to revoke a Desktop JWT", async () => {
		await saveOctoberCredential(store, key(A));
		expect(revoked).toEqual([]);
		await store.modify("october", async () => ({
			type: "oauth",
			access: "fixture.jwt.value",
			refresh: "fixture-refresh",
			expires: Date.now() + 3600000,
		}));
		await saveOctoberCredential(store, key(B));
		expect(revoked).toEqual([]);
	});

	it("blocks on a corrupt cleanup journal without echoing its contents or starting login", async () => {
		writeFileSync(`${authPath}.october-pending.json`, `{broken:${A}`, { mode: 0o600 });
		const acquire = vi.fn(async () => key(B));
		const failure = loginOctoberWithStore(store, acquire);
		await expect(failure).rejects.toThrow("Leave it intact");
		await expect(failure).rejects.not.toThrow(A);
		expect(acquire).not.toHaveBeenCalled();
	});

	it("never revokes the current credential when a same-token save cannot write its journal", async () => {
		writeFileSync(`${authPath}.october-pending.json`, "invalid", { mode: 0o600 });
		await expect(saveOctoberCredential(store, key(A))).rejects.toThrow("supplied credential was not revoked");
		expect(readStoredCredential("october", authPath)).toEqual(key(A));
		expect(revoked).toEqual([]);
	});

	it("rejects normal journals in recovery-file mode instead of revoking their active token", async () => {
		revoke = async () => false;
		await expect(saveOctoberCredential(store, key(B))).rejects.toThrow("cleanup is incomplete");
		await expect(recoverOctoberTokenFile(`${authPath}.october-pending.json`)).rejects.toThrow("Leave it intact");
		expect(revoked).toEqual([A]);
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
	});

	it.each(["login", "logout"])("redacts corrupt auth file contents from CLI %s failures", async (command) => {
		writeFileSync(authPath, `{broken:${A}`);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await handleOctoberLoginCommand(command === "login" ? [command, "--no-browser"] : [command]);
		expect(process.exitCode).toBe(1);
		expect(error).toHaveBeenCalled();
		expect(error.mock.calls.flat().join(" ")).not.toContain(A);
		expect(revoked).toEqual([]);
	});

	it("CLI login reports saved-but-pending cleanup as failure without discarding either token", async () => {
		vi.spyOn(deviceCode, "runOctoberDeviceCodeLogin").mockResolvedValue(B);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		revoke = async () => false;
		await handleOctoberLoginCommand(["login", "--no-browser"]);
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(error.mock.calls.flat().join(" ")).toContain("login was saved");
		expect(readStoredCredential("october", authPath)).toEqual(key(B));
		expect(pending()).toEqual([A, B]);
	});

	it("interactive login reports committed-but-pending cleanup and synchronizes the new credential", async () => {
		vi.spyOn(deviceCode, "runOctoberDeviceCodeLogin").mockResolvedValue(B);
		const models = await runtime();
		revoke = async () => false;
		await expect(
			models.login("october", "oauth", { prompt: async () => "unused", notify: () => {} }),
		).rejects.toBeInstanceOf(OctoberTokenCleanupError);
		expect((await models.getAuth("october"))?.auth.apiKey).toBe(B);
		expect(pending()).toEqual([A, B]);
	});
});
