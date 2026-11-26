import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, SessionStartEvent } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { serializePortableSession } from "../src/core/session-portable.ts";
import {
	createOctoberPermissionController,
	registerOctoberPermissions,
} from "../src/extensions/october/permissions.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { buildPortableFixture } from "./fixtures/portable-session-fixture.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	vi.unstubAllEnvs();
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** In-process RPC mode over a real AgentSessionRuntime whose extension records session_start events. */
async function startRpc(
	buildSession?: (sessionManager: SessionManager) => void,
	additionalExtensions: Array<(pi: ExtensionAPI) => void> = [],
) {
	const cwd = createTempDir("pi-portable-rpc-");
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const sessionStarts: SessionStartEvent[] = [];
	const extension = (pi: ExtensionAPI) => {
		pi.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		});
		pi.on("session_start", (event) => void sessionStarts.push(event));
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			resourceLoaderOptions: {
				extensionFactories: [extension, ...additionalExtensions],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	buildSession?.(sessionManager);
	const runtime: AgentSessionRuntime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: cwd,
		sessionManager,
	});
	cleanups.push(() => runtime.dispose());
	void runRpcMode(runtime);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	await vi.waitFor(() => expect(sessionStarts).toHaveLength(1));

	async function send(command: RpcCommand): Promise<RpcResponse> {
		rpcIo.lineHandler!(JSON.stringify(command));
		let response: RpcResponse | undefined;
		await vi.waitFor(() => {
			response = rpcIo.outputLines
				.flatMap((line) => line.split("\n"))
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as RpcResponse)
				.find((record) => record.type === "response" && record.id === command.id);
			expect(response).toBeDefined();
		});
		return response!;
	}

	return { runtime, send, cwd, sessionStarts };
}

function writePortableFixture(): { path: string; source: SessionManager } {
	const source = SessionManager.inMemory(createTempDir("pi-portable-rpc-source-"));
	buildPortableFixture(source, join(createTempDir("pi-portable-rpc-bash-"), "bash.log"));
	const path = join(createTempDir("pi-portable-rpc-file-"), "portable.jsonl");
	writeFileSync(path, serializePortableSession(source).jsonl);
	return { path, source };
}

describe("RPC permission inspection", () => {
	// Regression test for #48.
	it("returns null when the permission gate is not loaded", async () => {
		const { runtime, send } = await startRpc();
		expect(runtime.session.getPermissionInfo()).toBeUndefined();

		const response = await send({ id: "p0", type: "get_permissions" });
		if (response.type !== "response" || !response.success || response.command !== "get_permissions") {
			throw new Error("get_permissions did not return a successful response");
		}
		expect(response.data).toBeNull();
	});

	// Regression test for #48.
	it("returns the SDK explanation and reports delegation ceilings dynamically", async () => {
		const controller = createOctoberPermissionController();
		const { runtime, send } = await startRpc(undefined, [
			(pi) => registerOctoberPermissions(pi, controller, { mode: "bypass" }),
		]);

		const initial = await send({ id: "p1", type: "get_permissions" });
		if (initial.type !== "response" || !initial.success || initial.command !== "get_permissions") {
			throw new Error("get_permissions did not return a successful response");
		}
		expect(initial.data).toEqual(runtime.session.getPermissionInfo());
		expect(initial.data).toMatchObject({
			locked: true,
			selected: { mode: "bypass" },
			delegationCeiling: null,
			tools: { command: { outcome: "allow" } },
		});

		controller.setTemporaryCeiling("read-only");
		const delegated = await send({ id: "p2", type: "get_permissions" });
		if (delegated.type !== "response" || !delegated.success || delegated.command !== "get_permissions") {
			throw new Error("get_permissions did not return a successful response");
		}
		expect(delegated.data).toEqual(runtime.session.getPermissionInfo());
		expect(delegated.data).toMatchObject({
			delegationCeiling: "read-only",
			tools: { command: { outcome: "block" } },
		});
	});

	// Regression test for #48.
	it("keeps SDK and RPC inspection on the locked settings snapshot", async () => {
		const settingsDirectory = createTempDir("pi-permissions-rpc-settings-");
		const settingsPath = join(settingsDirectory, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ permissionMode: "accept-edits" }));
		vi.stubEnv("OCTOBER_CODING_AGENT_DIR", settingsDirectory);
		const { runtime, send } = await startRpc(undefined, [(pi) => registerOctoberPermissions(pi)]);
		const lockedInfo = runtime.session.getPermissionInfo();
		expect(lockedInfo).toMatchObject({
			selected: { mode: "accept-edits", source: "global settings" },
			effectiveMode: "accept-edits",
		});

		writeFileSync(settingsPath, JSON.stringify({ permissionMode: "bypass" }));
		vi.stubEnv("OCTOBER_PERMISSION_MODE", "bypass");

		const response = await send({ id: "p5", type: "get_permissions" });
		if (response.type !== "response" || !response.success || response.command !== "get_permissions") {
			throw new Error("get_permissions did not return a successful response");
		}
		expect(runtime.session.getPermissionInfo()).toEqual(lockedInfo);
		expect(response.data).toEqual(lockedInfo);
		expect(response.data).toMatchObject({
			interactive: true,
			tools: {
				command: {
					outcome: "ask",
					reason: "permission mode accept-edits (from global settings) asks before command tools",
				},
			},
		});
	});
});

describe("RPC portable sessions", () => {
	// Regression test for #2.
	it("exports the same file and diagnostics as the SDK codec", async () => {
		const { runtime, send, cwd } = await startRpc((sessionManager) =>
			buildPortableFixture(sessionManager, join(createTempDir("pi-portable-rpc-bash-"), "bash.log")),
		);
		const outputPath = join(cwd, "out", "portable.jsonl");

		const response = await send({ id: "e1", type: "export_jsonl", outputPath });

		const expected = serializePortableSession(runtime.session.sessionManager);
		expect(response).toEqual({
			id: "e1",
			type: "response",
			command: "export_jsonl",
			success: true,
			data: { path: outputPath, diagnostics: expected.diagnostics },
		});
		expect(readFileSync(outputPath, "utf8")).toBe(expected.jsonl);
	});

	// Regression test for #2.
	it("imports through the runtime, binds the new session once, and serves it", async () => {
		const portable = writePortableFixture();
		const { runtime, send, cwd, sessionStarts } = await startRpc();
		const previousSessionFile = runtime.session.sessionFile;

		const response = await send({ id: "i1", type: "import_jsonl", inputPath: portable.path });

		expect(response).toEqual({
			id: "i1",
			type: "response",
			command: "import_jsonl",
			success: true,
			data: { cancelled: false },
		});
		// One bind per session: startup, then the imported session.
		expect(sessionStarts).toEqual([
			{ type: "session_start", reason: "startup" },
			{ type: "session_start", reason: "resume", previousSessionFile },
		]);
		const state = await send({ id: "s1", type: "get_state" });
		expect(state).toMatchObject({
			command: "get_state",
			success: true,
			data: {
				sessionId: portable.source.getSessionId(),
				sessionName: "Portable fixture",
				sessionFile: runtime.session.sessionFile,
			},
		});
		expect(runtime.session.sessionManager.getCwd()).toBe(cwd);
		const messages = await send({ id: "m1", type: "get_messages" });
		expect(messages).toEqual({
			id: "m1",
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: JSON.parse(JSON.stringify(runtime.session.messages)) },
		});
		expect(runtime.session.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"custom",
			"branchSummary",
		]);
		expect(sessionStarts).toHaveLength(2);
	});

	// Regression test for #2.
	it("returns line and path errors for native and invalid files without switching", async () => {
		const { runtime, send, sessionStarts } = await startRpc();
		const dir = createTempDir("pi-portable-rpc-invalid-");
		const nativePath = join(dir, "native.jsonl");
		writeFileSync(
			nativePath,
			`${JSON.stringify({ type: "session", version: 3, id: "native", timestamp: "t", cwd: dir })}\n`,
		);
		const invalidPath = join(dir, "invalid.jsonl");
		const lines = readFileSync(writePortableFixture().path, "utf8").trim().split("\n");
		const record = JSON.parse(lines[1]) as Record<string, unknown>;
		record.extra = true;
		lines[1] = JSON.stringify(record);
		writeFileSync(invalidPath, `${lines.join("\n")}\n`);
		const originalSession = runtime.session;

		const nativeResponse = await send({ id: "n1", type: "import_jsonl", inputPath: nativePath });
		expect(nativeResponse).toEqual({
			id: "n1",
			type: "response",
			command: "import_jsonl",
			success: false,
			error: `Invalid portable session ${nativePath} (line 1): not a portable session; open native session files with --session / switch_session`,
		});

		const invalidResponse = await send({ id: "n2", type: "import_jsonl", inputPath: invalidPath });
		expect(invalidResponse).toEqual({
			id: "n2",
			type: "response",
			command: "import_jsonl",
			success: false,
			error: `Invalid portable session ${invalidPath} (line 2, $.extra): unexpected field`,
		});
		expect(runtime.session).toBe(originalSession);
		expect(sessionStarts).toHaveLength(1);
	});
});
