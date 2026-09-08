import type { Component, TUI } from "@earendil-works/pi-tui";
import { APP_NAME, getAgentDir, getAuthPath } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { getLoginProviderOptions, LOGIN_MENU_OPTIONS, LOGIN_MENU_TITLE } from "../extensions/october/login-menu.ts";
import { createOctoberProviderConfig } from "../extensions/october/provider.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../modes/interactive/components/login-dialog.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../modes/interactive/components/oauth-selector.ts";
import { stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

/** A login-only terminal: no agent session, project extensions, or inference requests. */
export async function runOctoberLoginUi(signal: AbortSignal, providerRef?: string): Promise<string | undefined> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`Login needs an interactive terminal. For October over SSH, use ${APP_NAME} login --no-browser.`);
	}
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.create(getAuthPath()),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerProvider("october", createOctoberProviderConfig());
	await runtime.refresh({ allowNetwork: false, signal });
	const ui = await createStartupTui(settings);
	try {
		startStartupTui(ui, settings);
		return await runProviderLoginUi(runtime, ui, signal, providerRef);
	} finally {
		ui.clear();
		ui.renderNow();
		ui.stop();
		stopThemeWatcher();
	}
}

export async function runProviderLoginUi(
	runtime: ModelRuntime,
	ui: TUI,
	signal: AbortSignal,
	providerRef?: string,
): Promise<string | undefined> {
	const show = (component: Component) => {
		ui.clear();
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender();
	};
	const select = <T>(
		create: (finish: (value: T | undefined) => void) => Component,
		selectionSignal = signal,
	): Promise<T | undefined> =>
		new Promise((resolve) => {
			if (selectionSignal.aborted) return resolve(undefined);
			const finish = (value: T | undefined) => {
				selectionSignal.removeEventListener("abort", abort);
				resolve(value);
			};
			const abort = () => finish(undefined);
			selectionSignal.addEventListener("abort", abort, { once: true });
			show(create(finish));
		});
	const providers = getLoginProviderOptions(runtime);
	let selected: AuthSelectorProvider | undefined;
	if (providerRef) {
		const ref = providerRef.trim().toLowerCase();
		const matches = providers.filter(
			(provider) => provider.id.toLowerCase() === ref || provider.name.toLowerCase() === ref,
		);
		if (matches.length === 0)
			throw new Error(`Unknown login provider: ${providerRef}. Run ${APP_NAME} login to choose one.`);
		selected =
			matches.length === 1
				? matches[0]
				: await select<AuthSelectorProvider>(
						(finish) =>
							new OAuthSelectorComponent(
								"login",
								matches,
								(id, type) => finish(matches.find((p) => p.id === id && p.authType === type)),
								() => finish(undefined),
							),
					);
		if (!selected) return undefined;
	}
	while (!selected) {
		const choice = await select<string>(
			(finish) =>
				new ExtensionSelectorComponent(LOGIN_MENU_TITLE, LOGIN_MENU_OPTIONS, finish, () => finish(undefined)),
		);
		if (choice === undefined) return undefined;
		if (choice === LOGIN_MENU_OPTIONS[0]) {
			selected = providers.find((provider) => provider.id === "october" && provider.authType === "oauth");
			if (!selected) throw new Error("October account login is unavailable.");
		} else {
			const type = choice === LOGIN_MENU_OPTIONS[1] ? "oauth" : "api_key";
			const options = providers.filter(
				(provider) => provider.authType === type && (type !== "oauth" || provider.id !== "october"),
			);
			selected = await select<AuthSelectorProvider>(
				(finish) =>
					new OAuthSelectorComponent(
						"login",
						options,
						(id, authType) =>
							finish(options.find((provider) => provider.id === id && provider.authType === authType)),
						() => finish(undefined),
					),
			);
		}
	}
	const dialog = new LoginDialogComponent(ui, selected.id, () => {}, selected.name);
	show(dialog);
	const loginSignal = AbortSignal.any([signal, dialog.signal]);
	if (!selected.method?.login) {
		dialog.showInfo(`${selected.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`, [], true);
		await select<void>(() => dialog, loginSignal);
		return undefined;
	}
	await runtime.login(selected.id, selected.authType, {
		signal: loginSignal,
		prompt: async (prompt) => {
			const promptSignal = prompt.signal ? AbortSignal.any([loginSignal, prompt.signal]) : loginSignal;
			if (promptSignal.aborted) throw new Error("Login cancelled");
			if (prompt.type === "select") {
				const result = await select<string>(
					(finish) =>
						new ExtensionSelectorComponent(
							prompt.message,
							prompt.options.map((option) => option.label),
							(label) => finish(prompt.options.find((option) => option.label === label)?.id),
							() => finish(undefined),
						),
					promptSignal,
				);
				show(dialog);
				if (result === undefined) throw new Error("Login cancelled");
				return result;
			}
			let onAbort: () => void = () => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error("Login cancelled"));
				promptSignal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return await Promise.race([
					prompt.type === "manual_code"
						? dialog.showManualInput(prompt.message)
						: dialog.showPrompt(prompt.message, prompt.placeholder),
					aborted,
				]);
			} finally {
				promptSignal.removeEventListener("abort", onAbort);
			}
		},
		notify: (event) => {
			if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
			else if (event.type === "device_code") {
				dialog.showDeviceCode(event);
				dialog.showWaiting("Waiting for authentication...");
			} else if (event.type === "info") dialog.showInfo(event.message, event.links);
			else dialog.showProgress(event.message);
		},
	});
	return selected.name;
}
