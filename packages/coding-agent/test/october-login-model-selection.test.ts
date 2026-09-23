import type { Api, Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createOctoberProviderConfig,
	OCTOBER_DEFAULT_MODEL_ID,
	OCTOBER_SEED_MODELS,
} from "../src/extensions/october/provider.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const unknownModel: Model<Api> = {
	id: "unknown",
	name: "Unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

const completeAuthentication = (
	InteractiveMode.prototype as unknown as {
		completeProviderAuthentication(
			this: object,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<Api>,
		): Promise<void>;
	}
).completeProviderAuthentication;

let runtime: ModelRuntime;
let recommended: Model<Api>;
let alternative: Model<Api>;

beforeEach(async () => {
	// Authentication has just succeeded, but a fresh session has no selected model or saved default.
	runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ october: { type: "api_key", key: "fixture-token" } }),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	// Only the recommended model is seeded; a second catalog entry stands in for any alternative.
	runtime.registerProvider("october", {
		...createOctoberProviderConfig(),
		refreshModels: async () => [
			...OCTOBER_SEED_MODELS,
			{ ...OCTOBER_SEED_MODELS[0]!, id: "october/Alternative-Model", name: "Alternative Model" },
		],
	});
	const refreshed = await runtime.refresh({ providers: ["october"], allowNetwork: false });
	recommended = runtime.getModel("october", OCTOBER_DEFAULT_MODEL_ID)!;
	alternative = runtime.getModels("october").find((model) => model.id !== OCTOBER_DEFAULT_MODEL_ID)!;
	expect(recommended).toBeDefined();
	expect(alternative).toBeDefined();
	// Avoid real catalog requests and prove selection does not depend on catalog ordering.
	vi.spyOn(runtime, "refresh").mockResolvedValue(refreshed);
	vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([alternative, recommended]);
});

afterEach(() => vi.restoreAllMocks());

function createView() {
	return {
		session: { model: unknownModel, modelRuntime: runtime, setModel: vi.fn(async () => {}) },
		updateAvailableProviderCount: vi.fn(async () => {}),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		checkDaxnutsEasterEgg: vi.fn(),
	};
}

function pendingCatalogRefresh() {
	let resolveRefresh!: (result: ModelsRefreshResult) => void;
	const promise = new Promise<ModelsRefreshResult>((resolve) => {
		resolveRefresh = resolve;
	});
	return { promise, resolve: resolveRefresh };
}

describe("October post-login model selection", () => {
	it.each(["oauth", "api_key"] as const)(
		"selects and persists the recommended model after first %s login",
		async (type) => {
			const view = createView();
			await completeAuthentication.call(view, "october", "October", type, unknownModel);
			expect(view.showError).not.toHaveBeenCalled();
			expect(view.session.setModel).toHaveBeenCalledExactlyOnceWith(recommended, { persist: true });
			expect(view.showStatus).toHaveBeenCalledWith(expect.stringContaining(`Selected ${OCTOBER_DEFAULT_MODEL_ID}`));
		},
	);

	it("preserves an already selected October model on repeated login", async () => {
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", alternative);
		expect(view.session.setModel).not.toHaveBeenCalled();
		expect(view.showError).not.toHaveBeenCalled();
	});

	it("preserves an already selected model from another provider", async () => {
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", {
			...alternative,
			provider: "another-provider",
		});
		expect(view.session.setModel).not.toHaveBeenCalled();
		expect(view.showError).not.toHaveBeenCalled();
	});

	it("reports an unavailable recommended model without silently selecting an alternative", async () => {
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([alternative]);
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", unknownModel);
		expect(view.session.setModel).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(view.showError).toHaveBeenCalledWith(
				expect.stringContaining(`default model "${OCTOBER_DEFAULT_MODEL_ID}" is not available`),
			);
		});
	});

	it("reports missing available models separately from successful authentication", async () => {
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([]);
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", unknownModel);
		expect(view.session.setModel).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(view.showError).toHaveBeenCalledWith(
				expect.stringContaining("no models are available for that provider"),
			);
		});
	});

	it("waits for catalog discovery before selecting October's recommended model", async () => {
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([]);
		const refreshed = await runtime.refresh({ providers: ["october"], allowNetwork: false });
		const pendingRefresh = pendingCatalogRefresh();
		vi.mocked(runtime.refresh).mockReturnValue(pendingRefresh.promise);
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", unknownModel);
		expect(view.showError).not.toHaveBeenCalled();
		expect(view.session.setModel).not.toHaveBeenCalled();
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([alternative, recommended]);
		pendingRefresh.resolve(refreshed);
		await vi.waitFor(() => {
			expect(view.session.setModel).toHaveBeenCalledExactlyOnceWith(recommended, { persist: true });
		});
	});

	it("does not replace a model selected while October's catalog refresh is pending", async () => {
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([]);
		const refreshed = await runtime.refresh({ providers: ["october"], allowNetwork: false });
		const pendingRefresh = pendingCatalogRefresh();
		vi.mocked(runtime.refresh).mockReturnValue(pendingRefresh.promise);
		const view = createView();
		await completeAuthentication.call(view, "october", "October", "oauth", unknownModel);
		view.session.model = alternative;
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([alternative, recommended]);
		pendingRefresh.resolve(refreshed);
		await vi.waitFor(() => expect(view.ui.requestRender).toHaveBeenCalled());
		expect(view.session.setModel).not.toHaveBeenCalled();
		expect(view.showError).not.toHaveBeenCalled();
	});

	it("reports model-selection persistence errors honestly", async () => {
		const view = createView();
		view.session.setModel.mockRejectedValue(new Error("fixture settings write failed"));
		await completeAuthentication.call(view, "october", "October", "oauth", unknownModel);
		expect(view.showError).toHaveBeenCalledWith(expect.stringContaining("fixture settings write failed"));
		expect(view.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Selected"));
	});

	it("uses the same default on standalone startup after shell login", async () => {
		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		expect(result.model).toEqual(recommended);
	});

	it("preserves a saved standalone model choice", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtime,
			defaultProvider: "october",
			defaultModelId: alternative.id,
		});
		expect(result.model).toEqual(alternative);
	});
});
