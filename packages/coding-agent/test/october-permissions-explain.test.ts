import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import {
	createOctoberPermissionController,
	decideToolPermission,
	explainOctoberPermissions,
	formatOctoberPermissionExplanation,
	type OctoberPermissionController,
	type OctoberPermissionMode,
	type OctoberPermissionPolicy,
	registerOctoberPermissions,
	resolveOctoberPermissionModeWithSource,
} from "../src/extensions/october/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(() => {
	delete process.env.OCTOBER_PERMISSION_MODE;
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: `${name}-ok` }], details: {} }),
	};
}

function globalSettings(mode: OctoberPermissionMode | undefined): string {
	const directory = mkdtempSync(join(tmpdir(), "october-permission-explain-"));
	directories.push(directory);
	vi.stubEnv("OCTOBER_CODING_AGENT_DIR", directory);
	if (mode) writeFileSync(join(directory, "settings.json"), JSON.stringify({ permissionMode: mode }));
	return join(directory, "settings.json");
}

type Setup = {
	project?: OctoberPermissionMode;
	trusted?: boolean;
	interactive?: boolean;
	host?: OctoberPermissionMode;
	controller?: OctoberPermissionController;
	confirm?: (title: string, message: string) => Promise<boolean>;
};

async function session(setup: Setup = {}) {
	const controller = setup.controller ?? createOctoberPermissionController();
	const harness = await createHarness({
		tools: [tool("read"), tool("write"), tool("bash")],
		extensionFactories: [
			(pi: ExtensionAPI) => registerOctoberPermissions(pi, controller, setup.host ? { mode: setup.host } : {}),
		],
	});
	harnesses.push(harness);
	if (setup.project) {
		mkdirSync(join(harness.tempDir, ".october"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, ".october", "settings.json"),
			JSON.stringify({ permissionMode: setup.project }),
		);
	}
	if (setup.trusted !== undefined) harness.settingsManager.setProjectTrusted(setup.trusted);
	const notify = vi.fn();
	const confirm = vi.fn(setup.confirm ?? (async () => true));
	const ui = { notify, confirm, setStatus: () => {}, setWidget: () => {} } as unknown as ExtensionUIContext;
	await harness.session.bindExtensions(setup.interactive ? { uiContext: ui } : {});
	const explain = async (): Promise<string> => {
		const runner = harness.session.extensionRunner;
		notify.mockClear();
		const context = runner.createCommandContext();
		// A headless session has no UI to notify; capture the text through the same formatter instead.
		const captured = setup.interactive
			? context
			: new Proxy(context, {
					get: (target, key) => (key === "ui" ? { ...target.ui, notify } : Reflect.get(target, key, target)),
				});
		await runner.getCommand("permissions")?.handler("", captured);
		return String(notify.mock.calls.at(-1)?.[0] ?? "");
	};
	return { harness, controller, confirm, explain };
}

function lastToolText(harness: Harness): string {
	const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
	return result?.role === "toolResult"
		? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		: "";
}

async function call(harness: Harness, name: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return lastToolText(harness);
}

describe("permission mode source", () => {
	const fakePi = (flag?: string) => ({ getFlag: () => flag }) as unknown as ExtensionAPI;

	it("follows flag, environment, global settings, default", () => {
		globalSettings("accept-edits");
		process.env.OCTOBER_PERMISSION_MODE = "ask";
		expect(resolveOctoberPermissionModeWithSource(fakePi("bypass"))).toEqual({ mode: "bypass", source: "flag" });
		expect(resolveOctoberPermissionModeWithSource(fakePi())).toEqual({ mode: "ask", source: "environment" });
		delete process.env.OCTOBER_PERMISSION_MODE;
		expect(resolveOctoberPermissionModeWithSource(fakePi())).toEqual({
			mode: "accept-edits",
			source: "global settings",
		});
		globalSettings(undefined);
		expect(resolveOctoberPermissionModeWithSource(fakePi("nonsense"))).toEqual({ mode: "bypass", source: "default" });
	});

	it("reports a host-supplied mode as the host's", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const { explain } = await session({ host: "accept-edits", interactive: true });
		const text = await explain();
		expect(text).toContain("Selected: accept-edits from the host application, locked for this session");
		expect(text).toContain("bash and other tools: ask, permission mode accept-edits (from the host application)");
	});
});

describe("/permissions explanation", () => {
	// issue #48: inspection must not freeze policy before startup or the first tool call.
	it.each([true, false])("keeps pre-start inspection read-only (bind=%s)", async (bind) => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const harness = await createHarness({
			tools: [tool("bash")],
			extensionFactories: [registerOctoberPermissions],
		});
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		mkdirSync(join(harness.tempDir, ".october"), { recursive: true });
		const settingsPath = join(harness.tempDir, ".october", "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ permissionMode: "bypass" }));

		const notify = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }), "tui");
		await harness.session.prompt("/permissions");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("not locked yet"), "info");

		writeFileSync(settingsPath, JSON.stringify({ permissionMode: "ask" }));
		harness.session.extensionRunner.setUIContext();
		if (bind) await harness.session.bindExtensions({});
		expect(await call(harness, "bash")).toContain(
			"blocked by permission mode ask in non-interactive mode (from trusted project settings)",
		);
	});

	it("shows a trusted project tightening the session and names it in denials", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const { harness, explain } = await session({ project: "ask", trusted: true });
		const text = await explain();
		expect(text).toContain("Permission mode: ask");
		expect(text).toContain("Selected: bypass from OCTOBER_PERMISSION_MODE");
		expect(text).toContain("Project: trusted, permissionMode ask tightened the session");
		expect(await call(harness, "bash")).toContain(
			"blocked by permission mode ask in non-interactive mode (from trusted project settings)",
		);
	});

	it("explains that untrusted or looser project settings have no effect", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "accept-edits";
		const untrusted = await session({ project: "ask", trusted: false });
		expect(await untrusted.explain()).toContain("Project: untrusted, so its settings are ignored");
		const looser = await session({ project: "bypass", trusted: true });
		const text = await looser.explain();
		expect(text).toContain("Project: trusted, permissionMode bypass is not stricter, so it has no effect");
		expect(text).toContain("Permission mode: accept-edits");
	});

	it("explains both delegation ceilings, and decisions follow the ceiling as it changes", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const { controller, explain, harness } = await session({ interactive: true });
		controller.setTemporaryCeiling("read-only");
		let text = await explain();
		expect(text).toContain("Delegation ceiling: read-only");
		expect(text).toContain(
			"edit, write: block, blocked by the read-only ceiling on the active October Bus delegation",
		);
		expect(text).toContain("read, grep, find, ls: allow");
		expect(await call(harness, "write")).toContain("read-only ceiling");

		controller.setTemporaryCeiling("accept-edits");
		text = await explain();
		expect(text).toContain("Permission mode: accept-edits");
		expect(text).toContain("(from the accept-edits ceiling on the active October Bus delegation)");

		controller.setTemporaryCeiling("inherit");
		text = await explain();
		expect(text).toContain("Delegation ceiling: inherit (adds no restriction)");
		expect(text).toContain("Permission mode: bypass");

		controller.setTemporaryCeiling(undefined);
		expect(await explain()).toContain("Permission mode: bypass");
	});

	// issue #48: a stricter trusted project is the source even while an accept-edits ceiling is active.
	it("names trusted project settings, not the delegation, when the project is stricter than the ceiling", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		const headless = await session({ project: "ask", trusted: true });
		headless.controller.setTemporaryCeiling("accept-edits");
		const text = await headless.explain();
		expect(text).toContain("Permission mode: ask");
		expect(text).toContain(
			"bash and other tools: block, blocked by permission mode ask in non-interactive mode (from trusted project settings)",
		);
		expect(text).not.toContain("from the accept-edits ceiling");
		expect(await call(headless.harness, "bash")).toContain(
			"blocked by permission mode ask in non-interactive mode (from trusted project settings)",
		);

		const interactive = await session({
			project: "ask",
			trusted: true,
			interactive: true,
			confirm: async () => false,
		});
		interactive.controller.setTemporaryCeiling("accept-edits");
		expect(await call(interactive.harness, "bash")).toContain("denied by user");
		const [, message] = interactive.confirm.mock.calls[0] ?? [];
		expect(message).toContain("permission mode ask (from trusted project settings) asks before command tools");
	});

	it("keeps explaining the locked policy after settings are edited", async () => {
		const settingsPath = globalSettings("accept-edits");
		const { harness, explain } = await session({ project: "accept-edits", trusted: true });
		const before = await explain();
		writeFileSync(settingsPath, JSON.stringify({ permissionMode: "bypass" }));
		writeFileSync(join(harness.tempDir, ".october", "settings.json"), JSON.stringify({ permissionMode: "bypass" }));
		process.env.OCTOBER_PERMISSION_MODE = "bypass";
		expect(await explain()).toBe(before);
		expect(before).toContain("Selected: accept-edits from global settings, locked for this session");
		expect(await call(harness, "bash")).toContain("blocked by permission mode accept-edits");
	});

	it("explains non-interactive blocking and keeps project trust, permission and shell runner apart", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "ask";
		const text = await (await session()).explain();
		expect(text).toContain("Session: non-interactive, so tools that would ask are blocked");
		expect(text).toContain("bash and other tools: block, blocked by permission mode ask in non-interactive mode");
		expect(text).toContain("nobody can approve it");
		expect(text).toContain("Project trust only decides which project files October loads; it is not a sandbox.");
		expect(text).toContain(
			"Where an allowed command runs is set by the shellRunner setting, which is this machine unless configured otherwise.",
		);
	});

	it("puts the same decision in the approval prompt", async () => {
		process.env.OCTOBER_PERMISSION_MODE = "ask";
		const { harness, confirm } = await session({ interactive: true, confirm: async () => false });
		expect(await call(harness, "bash")).toContain("denied by user");
		const [title, message] = confirm.mock.calls[0] ?? [];
		expect(title).toBe("Allow bash?");
		expect(message).toContain("permission mode ask (from OCTOBER_PERMISSION_MODE) asks before command tools");
	});
});

describe("decideToolPermission", () => {
	const policy = (overrides: Partial<OctoberPermissionPolicy> = {}): OctoberPermissionPolicy => ({
		locked: true,
		selected: { mode: "accept-edits", source: "flag" },
		project: { trusted: true, setting: null, tightened: false },
		delegationCeiling: null,
		effectiveMode: "accept-edits",
		...overrides,
	});

	it("matches the mode table for every tool class and session type", () => {
		const outcomes = (mode: OctoberPermissionMode, interactive: boolean) =>
			Object.values(
				explainOctoberPermissions(policy({ selected: { mode, source: "flag" }, effectiveMode: mode }), interactive)
					.tools,
			).map((decision) => decision.outcome);
		expect(outcomes("ask", true)).toEqual(["allow", "ask", "ask"]);
		expect(outcomes("ask", false)).toEqual(["allow", "block", "block"]);
		expect(outcomes("accept-edits", true)).toEqual(["allow", "allow", "ask"]);
		expect(outcomes("bypass", false)).toEqual(["allow", "allow", "allow"]);
	});

	it("never changes the policy it explains", () => {
		const value = policy({ delegationCeiling: "read-only" });
		const copy = structuredClone(value);
		decideToolPermission(value, "command", true);
		formatOctoberPermissionExplanation(explainOctoberPermissions(value, false));
		expect(value).toEqual(copy);
	});
});
