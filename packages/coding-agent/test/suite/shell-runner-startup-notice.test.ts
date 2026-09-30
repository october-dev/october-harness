import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../src/core/agent-session-services.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

// issue #17: the shell runner policy must be on screen before any `!` command or session_start
// handler can start work, and a later status line must not replace it.

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(160)).join("\n");
}

type InitContext = Record<string, unknown> & { chatContainer: Container };

function createInitContext(
	shellRunnerNotice: AgentSessionRuntimeDiagnostic,
	events: string[],
	releaseSessionStart: Promise<void>,
): InitContext {
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const chatContainer = new Container();
	const snapshot = (label: string) => events.push(`${label}: ${render(chatContainer)}`);
	return {
		isInitialized: false,
		options: { shellRunnerNotice },
		version: "test",
		chatContainer,
		headerContainer: new Container(),
		documentContainer: new Container(),
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		widgetContainerAbove: new Container(),
		editorContainer: new Container(),
		widgetContainerBelow: new Container(),
		footerContainer: new Container(),
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		session: { scopedModels: [] },
		settingsManager: { getQuietStartup: () => true, getFullscreenScrollbar: () => "auto" },
		ui: {
			start: vi.fn(),
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			invalidate: vi.fn(),
			renderNow: vi.fn(() => snapshot("rendered")),
		},
		defaultEditor: { onAction: vi.fn() },
		editor: {},
		themeController: { applyFromSettings: vi.fn(async () => {}) },
		footerDataProvider: { onBranchChange: vi.fn() },
		registerSignalHandlers: vi.fn(),
		getChangelogForDisplay: vi.fn(),
		renderWidgets: vi.fn(),
		mountInteractiveTui: vi.fn(),
		showManagedToolStatus: vi.fn(),
		setupKeyHandlers: vi.fn(),
		setupEditorSubmitHandler: vi.fn(() => snapshot("submit enabled")),
		// A slow session_start: the window in which commands could otherwise run first.
		rebindCurrentSession: vi.fn(async () => {
			snapshot("session_start");
			await releaseSessionStart;
		}),
		renderInitialMessages: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		showStatus: prototype.showStatus,
		showWarning: prototype.showWarning,
	};
}

describe("shell runner notice during interactive startup", () => {
	beforeAll(() => initTheme("dark"));

	it.each<[string, AgentSessionRuntimeDiagnostic]>([
		["docker", { type: "info", message: "Shell runner: docker (image shell:test). Mounts: /w (read-write)." }],
		["invalid", { type: "warning", message: "Shell runner: blocked. Global settings file x cannot be used." }],
	])("renders the %s notice before submission and session_start, and keeps it", async (_kind, notice) => {
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		const events: string[] = [];
		let release!: () => void;
		const releaseSessionStart = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = createInitContext(notice, events, releaseSessionStart);
		try {
			const init = (InteractiveMode.prototype as unknown as { init(this: InitContext): Promise<void> }).init;
			const initialized = init.call(context);
			await vi.waitFor(() => expect(events.some((event) => event.startsWith("session_start"))).toBe(true));

			const firstMessage = notice.message.slice(0, 40);
			expect(events[0].startsWith("rendered")).toBe(true);
			for (const event of events) expect(event).toContain(firstMessage);
			expect(events.map((event) => event.split(":")[0])).toEqual(["rendered", "submit enabled", "session_start"]);

			release();
			await initialized;
			(
				InteractiveMode.prototype as unknown as { showStatus(this: InitContext, message: string): void }
			).showStatus.call(context, "Later status");
			expect(render(context.chatContainer)).toContain(firstMessage);
			expect(render(context.chatContainer)).toContain("Later status");
		} finally {
			release();
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
		}
	});
});
