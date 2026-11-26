import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime, type RequestAuthNotification } from "../src/core/model-runtime.ts";

// Regression: october-dev/october-harness#9

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

async function fauxRuntime(): Promise<{ runtime: ModelRuntime; faux: FauxProviderRegistration }> {
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "stored-faux-key" } });
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux };
}

describe("passive credential literals", () => {
	it("returns loaded keys and tokens without executing commands or refreshing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-auth-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const marker = join(dir, "command-ran");
		vi.stubEnv("TRACE_TEST_KEY", "env-template-key");
		const storage = AuthStorage.inMemory({
			command: { type: "api_key", key: `!touch ${marker}` },
			template: { type: "api_key", key: "$TRACE_TEST_KEY" },
			literal: { type: "api_key", key: "literal-key" },
			oauth: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
			withEnv: {
				type: "api_key",
				key: "ordinary",
				env: { SERVICE_PASSWORD: "stored-env-secret-4821", REGION: "us-east-1" },
			},
		});
		const read = vi.spyOn(storage, "read");

		expect(storage.getSecretLiterals().sort()).toEqual(
			[
				"access-token",
				"env-template-key",
				"literal-key",
				"ordinary",
				"refresh-token",
				"stored-env-secret-4821",
			].sort(),
		);
		expect(existsSync(marker)).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});
});

describe("ModelRuntime.onRequestAuth", () => {
	it("observes resolved and transformed auth without extra credential reads", async () => {
		const { runtime, faux } = await fauxRuntime();
		const model = faux.getModel();
		const request = async () => {
			faux.setResponses([fauxAssistantMessage("ok")]);
			await runtime.completeSimple(
				model,
				{ messages: [] },
				{
					headers: { Authorization: "Bearer header-secret-1" },
					transformHeaders: async (headers) => {
						const { Authorization, ...rest } = headers;
						return { ...rest, "x-copy": String(Authorization) };
					},
				},
			);
		};
		const read = vi.spyOn(AuthStorage.prototype, "read");
		await request();
		const readsPerRequest = read.mock.calls.length;
		expect(readsPerRequest).toBeGreaterThan(0);

		const notifications: RequestAuthNotification[] = [];
		const unsubscribe = runtime.onRequestAuth((notification) => notifications.push(notification));
		const failing = runtime.onRequestAuth(() => {
			throw new Error("observer failure");
		});
		await request();
		expect(read.mock.calls.length).toBe(readsPerRequest * 2);

		expect(notifications.map((notification) => notification.phase)).toEqual(["resolved", "final"]);
		expect(notifications[0]).toMatchObject({
			provider: model.provider,
			apiKey: "stored-faux-key",
			headers: { Authorization: "Bearer header-secret-1" },
		});
		expect(notifications[1].headers).toMatchObject({ "x-copy": "Bearer header-secret-1" });
		expect(notifications[1].headers).not.toHaveProperty("Authorization");

		unsubscribe();
		failing();
		await request();
		expect(notifications).toHaveLength(2);
	});
});
