import type { AuthInteraction } from "@earendil-works/pi-ai";
import { type Component, Container, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { handleOctoberLoginCommand } from "../src/cli/october-login.ts";
import * as loginUi from "../src/cli/october-login-ui.ts";
import {
	formatNoModelsAvailableMessage,
	getNoModelsGuidance,
	getProviderLoginHelp,
} from "../src/core/auth-guidance.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { LOGIN_MENU_OPTIONS } from "../src/extensions/october/login-menu.ts";
import { createOctoberProviderConfig } from "../src/extensions/october/provider.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let runtime: ModelRuntime;
let ui: TuiMainScreen;
let controller: AbortController;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	controller = new AbortController();
	ui = new TuiMainScreen(new VirtualTerminal());
	runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerProvider("october", createOctoberProviderConfig());
});

afterEach(() => {
	controller.abort();
	ui.stop();
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
});

async function input(value: string): Promise<void> {
	ui.getFocusedComponent()?.handleInput?.(value);
	await Promise.resolve();
}

describe("unified login menu", () => {
	it("starts October's existing OAuth method from the first shell choice", async () => {
		const login = vi.spyOn(runtime, "login").mockResolvedValue({ type: "api_key", key: "fixture" });
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal);
		const output = stripAnsi(ui.render(100).join("\n"));
		for (const label of LOGIN_MENU_OPTIONS) expect(output).toContain(label);
		await input("\r");
		await expect(result).resolves.toBe("October");
		expect(login).toHaveBeenCalledWith(
			"october",
			"oauth",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("keeps October out of the other-account picker and reuses provider authentication", async () => {
		const login = vi.spyOn(runtime, "login").mockResolvedValue({ type: "api_key", key: "fixture" });
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal);
		await input("\x1b[B");
		await input("\r");
		expect(ui.getFocusedComponent()).toBeInstanceOf(OAuthSelectorComponent);
		await input("october");
		expect(stripAnsi(ui.render(100).join("\n"))).toContain("No matching providers");
		await input("\x1b");
		expect(ui.getFocusedComponent()).toBeInstanceOf(ExtensionSelectorComponent);
		await input("\x1b[B");
		await input("\r");
		await input("github-copilot");
		await input("\r");
		await expect(result).resolves.toBe("GitHub Copilot");
		expect(login.mock.calls[0]?.slice(0, 2)).toEqual(["github-copilot", "oauth"]);
	});

	it("routes API key selection through the provider's prompt and storage path", async () => {
		const login = vi.spyOn(runtime, "login").mockImplementation(async (_id, _type, interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "API key" });
			expect(key).toBe("fixture-key");
			return { type: "api_key", key };
		});
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal);
		await input("\x1b[B");
		await input("\x1b[B");
		await input("\r");
		await input("anthropic");
		await input("\r");
		expect(ui.getFocusedComponent()).toBeInstanceOf(LoginDialogComponent);
		await input("fixture-key");
		await input("\r");
		await expect(result).resolves.toBe("Anthropic");
		expect(login.mock.calls[0]?.slice(0, 2)).toEqual(["anthropic", "api_key"]);
	});

	it("cancels the root menu without reading or changing credentials", async () => {
		const login = vi.spyOn(runtime, "login");
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal);
		await input("\x1b");
		await expect(result).resolves.toBeUndefined();
		expect(login).not.toHaveBeenCalled();
	});

	it("propagates external cancellation to an active provider prompt", async () => {
		let interaction: AuthInteraction | undefined;
		vi.spyOn(runtime, "login").mockImplementation(async (_id, _type, next) => {
			interaction = next;
			await next.prompt({ type: "manual_code", message: "Paste code" });
			throw new Error("unreachable");
		});
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal, "github-copilot");
		const rejected = expect(result).rejects.toThrow("Login cancelled");
		await input("\r");
		expect(ui.getFocusedComponent()).toBeInstanceOf(LoginDialogComponent);
		controller.abort();
		await rejected;
		expect(interaction?.signal?.aborted).toBe(true);
	});

	it("respects per-prompt cancellation without cancelling the whole login", async () => {
		const promptController = new AbortController();
		vi.spyOn(runtime, "login").mockImplementation(async (_id, _type, interaction) => {
			const pending = interaction.prompt({
				type: "manual_code",
				message: "Paste code",
				signal: promptController.signal,
			});
			const rejected = expect(pending).rejects.toThrow("Login cancelled");
			promptController.abort();
			await rejected;
			expect(interaction.signal?.aborted).toBe(false);
			return { type: "api_key", key: "fixture" };
		});
		const result = loginUi.runProviderLoginUi(runtime, ui, controller.signal, "github-copilot");
		await input("\r");
		await expect(result).resolves.toBe("GitHub Copilot");
	});

	it.each([0, 1, 2])("routes interactive menu choice %i to the existing login flow", (choice) => {
		let component: Component | undefined;
		const done = vi.fn();
		const startProviderLogin = vi.fn();
		const showLoginProviderSelector = vi.fn();
		const fakeThis = {
			ui,
			startProviderLogin,
			showLoginProviderSelector,
			showSelector: (create: (done: () => void) => { component: Component }) => {
				component = create(done).component;
			},
		};
		const showMenu = (InteractiveMode.prototype as unknown as { showLoginAuthTypeSelector(this: object): void })
			.showLoginAuthTypeSelector;
		showMenu.call(fakeThis);
		for (let i = 0; i < choice; i++) component?.handleInput?.("\x1b[B");
		component?.handleInput?.("\r");
		expect(done).toHaveBeenCalledOnce();
		if (choice === 0)
			expect(startProviderLogin).toHaveBeenCalledWith({ id: "october", name: "October", authType: "oauth" });
		else expect(showLoginProviderSelector).toHaveBeenCalledWith(choice === 1 ? "oauth" : "api_key");
	});

	it("the CLI routes bare and named provider login to the menu, not an inference prompt", async () => {
		const run = vi.spyOn(loginUi, "runOctoberLoginUi").mockResolvedValue("fixture provider");
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await handleOctoberLoginCommand(["login"])).toBe(true);
		expect(await handleOctoberLoginCommand(["login", "github-copilot"])).toBe(true);
		expect(run.mock.calls.map((call) => call[1])).toEqual([undefined, "github-copilot"]);
		expect(await handleOctoberLoginCommand(["a normal prompt"])).toBe(false);
	});

	it("reports cancellation honestly from the CLI", async () => {
		vi.spyOn(loginUi, "runOctoberLoginUi").mockResolvedValue(undefined);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await handleOctoberLoginCommand(["login"]);
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Login cancelled"));
	});
});

describe("connection guidance", () => {
	it("keeps neutral onboarding visible alongside later startup status messages", () => {
		const methods = InteractiveMode.prototype as unknown as {
			showModelFallbackMessage(this: object, message: string): void;
			showStatus(this: object, message: string): void;
		};
		vi.spyOn(runtime, "getProviderAuthStatus").mockReturnValue({ configured: false });
		const chatContainer = new Container();
		const showWarning = vi.fn();
		const state = { session: { modelRuntime: runtime }, chatContainer, ui, showWarning };
		methods.showModelFallbackMessage.call(state, formatNoModelsAvailableMessage());
		methods.showStatus.call(state, "Telemetry consent notice");
		const output = stripAnsi(chatContainer.render(120).join("\n"));
		expect(output).toContain("Connect a provider to get started. Type `/login`.");
		expect(output).toContain("Telemetry consent notice");
		expect(showWarning).not.toHaveBeenCalled();
		methods.showModelFallbackMessage.call(state, "Saved model is unavailable; using a fallback.");
		expect(showWarning).toHaveBeenCalledWith("Saved model is unavailable; using a fallback.");
	});

	it("uses one context-appropriate command for all credential types", () => {
		expect(getProviderLoginHelp("interactive")).toContain("`/login`");
		expect(getProviderLoginHelp("interactive")).not.toContain("october login");
		expect(getProviderLoginHelp("shell")).toContain("`october login`");
		expect(getProviderLoginHelp("shell")).not.toContain("/login");
	});

	it("makes fresh setup neutral", () => {
		const state = {
			getError: () => undefined,
			getProviders: () => [],
			getProviderAuthStatus: () => ({ configured: false as const }),
		};
		expect(getNoModelsGuidance(state, "interactive")).toEqual({
			level: "info",
			message: "Connect a provider to get started. Type `/login`.",
		});
		expect(getNoModelsGuidance(state, "shell").message).toContain("Run `october login`");
	});

	it("keeps actual model-loading failures visible", () => {
		vi.spyOn(runtime, "getError").mockReturnValue("fixture model catalog failure");
		expect(getNoModelsGuidance(runtime, "interactive")).toEqual({
			level: "warning",
			message: "Could not load models: fixture model catalog failure",
		});
	});

	it("does not tell an already configured user to log in again", () => {
		vi.spyOn(runtime, "getProviderAuthStatus").mockReturnValue({ configured: true, source: "stored" });
		const guidance = getNoModelsGuidance(runtime, "interactive");
		expect(guidance.level).toBe("warning");
		expect(guidance.message).toContain("Credentials are configured");
		expect(guidance.message).not.toContain("login");
	});
});
