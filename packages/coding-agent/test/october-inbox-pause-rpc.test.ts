import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { OctoberPublicBusEnv } from "../src/extensions/october/bus/env.ts";
import type { OctoberMcpClient } from "../src/extensions/october/bus/mcp-client.ts";
import { registerOctoberPublicBus } from "../src/extensions/october/bus/public.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const PUBLIC_ENV: OctoberPublicBusEnv = {
	transport: "public",
	address: "http://127.0.0.1:4765",
	mcpUrl: "http://127.0.0.1:4765/mcp",
	agentId: "planner",
	executionId: "exec-1",
	agentToken: "fixture-secret-token",
};

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

async function send(line: Record<string, unknown>): Promise<void> {
	rpcIo.lineHandler?.(JSON.stringify(line));
	await vi.waitFor(() => {
		expect(parseOutputLines().some((record) => record.id === line.id && record.type === "response")).toBe(true);
	});
}

describe("RPC team inbox dispatch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("pauses and resumes through typed commands without a model call", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) =>
					registerOctoberPublicBus(pi, PUBLIC_ENV, {
						callTool: async (name: string) => {
							if (name === "list_peers") {
								return {
									ok: true as const,
									value: {
										content: [{ type: "text", text: '{"peers":[]}' }],
										isError: false,
										structuredContent: { peers: [] },
									},
								};
							}
							if (name === "list_tasks") {
								return {
									ok: true as const,
									value: {
										content: [{ type: "text", text: '{"tasks":[]}' }],
										isError: false,
										structuredContent: { tasks: [] },
									},
								};
							}
							if (name === "check_inbox") return new Promise(() => {});
							return { ok: false as const, error: name };
						},
					} as unknown as OctoberMcpClient),
			],
		});
		harnesses.push(harness);
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		await send({ id: "get-1", type: "get_team_inbox" });
		await send({ id: "bad", type: "set_team_inbox", paused: "yes" });
		await send({ id: "pause", type: "set_team_inbox", paused: true });
		await send({ id: "get-2", type: "get_team_inbox" });
		await send({ id: "resume", type: "set_team_inbox", paused: false });

		const responses = parseOutputLines().filter((record) => record.type === "response");
		expect(responses).toContainEqual({
			id: "get-1",
			type: "response",
			command: "get_team_inbox",
			success: true,
			data: { available: true, paused: false, pending: 0, active: false },
		});
		expect(responses).toContainEqual({
			id: "bad",
			type: "response",
			command: "set_team_inbox",
			success: false,
			error: "paused must be a boolean",
		});
		expect(responses).toContainEqual({
			id: "pause",
			type: "response",
			command: "set_team_inbox",
			success: true,
			data: { available: true, paused: true, pending: 0, active: false },
		});
		expect(responses).toContainEqual({
			id: "get-2",
			type: "response",
			command: "get_team_inbox",
			success: true,
			data: { available: true, paused: true, pending: 0, active: false },
		});
		expect(responses).toContainEqual({
			id: "resume",
			type: "response",
			command: "set_team_inbox",
			success: true,
			data: { available: true, paused: false, pending: 0, active: false },
		});
		expect(harness.session.messages).toEqual([]);
	});

	it("rejects set_team_inbox when automatic delivery is not active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await send({ id: "missing", type: "set_team_inbox", paused: true });
		expect(parseOutputLines()).toContainEqual({
			id: "missing",
			type: "response",
			command: "set_team_inbox",
			success: false,
			error: "October Bus automatic inbox dispatch is not active in this session",
		});
	});
});
