import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";

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
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
});

/** In-process RPC mode over a real AgentSessionRuntime backed by the faux provider. */
async function startRpc() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-context-rpc-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	let started = false;
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
		pi.on("session_start", () => {
			started = true;
		});
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			resourceLoaderOptions: {
				extensionFactories: [extension],
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
	const runtime: AgentSessionRuntime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
	});
	cleanups.push(() => runtime.dispose());
	void runRpcMode(runtime);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	await vi.waitFor(() => expect(started).toBe(true));

	async function sendSnapshotCommand(command: Extract<RpcCommand, { type: "get_context_snapshot" }>) {
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
		if (
			!response ||
			response.type !== "response" ||
			!response.success ||
			response.command !== "get_context_snapshot"
		) {
			throw new Error("get_context_snapshot did not return a successful response");
		}
		return response.data;
	}

	return { runtime, faux, sendSnapshotCommand };
}

describe("RPC context snapshot inspection", () => {
	it("returns null before the first model request", async () => {
		const { runtime, sendSnapshotCommand } = await startRpc();
		expect(runtime.session.getContextSnapshot()).toBeUndefined();

		expect(await sendSnapshotCommand({ id: "c0", type: "get_context_snapshot" })).toBeNull();
	});

	it("returns metadata by default and content only when requested, without another model request", async () => {
		const { runtime, faux, sendSnapshotCommand } = await startRpc();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await runtime.session.prompt("private question");
		const providerCalls = faux.state.callCount;

		const metadata = await sendSnapshotCommand({ id: "c1", type: "get_context_snapshot" });
		expect(metadata).toEqual(runtime.session.getContextSnapshot());
		expect(JSON.stringify(metadata)).not.toContain("private question");

		const revealed = await sendSnapshotCommand({ id: "c2", type: "get_context_snapshot", includeContent: true });
		expect(revealed).toEqual(runtime.session.getContextSnapshot({ includeContent: true }));
		expect(JSON.stringify(revealed)).toContain("private question");

		expect(await sendSnapshotCommand({ id: "c3", type: "get_context_snapshot", requestId: "999" })).toBeNull();
		expect(faux.state.callCount).toBe(providerCalls);
	});
});
