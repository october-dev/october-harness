import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const PAID_ID = "openrouter/deepseek/deepseek-v4";
// Partially matches PAID_ID; the live gateway lists it, and fuzzy resolution once picked it instead.
const NEAR_MISS_ID = "openrouter/deepseek/deepseek-v4.1-flash:batch";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolveClose) => {
					server.close(() => resolveClose());
					server.closeAllConnections();
				}),
		),
	);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Gateway {
	baseUrl: string;
	chatModels: string[];
}

/** Loopback October gateway: `/v1/models` answers `catalogue` (or `modelsStatus`), chat streams "ok". */
async function startGateway(catalogue: string[], modelsStatus = 200): Promise<Gateway> {
	const chatModels: string[] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			if (request.url === "/v1/models") {
				if (modelsStatus !== 200) {
					response.writeHead(modelsStatus).end();
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: catalogue.map((id) => ({ id })) }));
				return;
			}
			if (request.url === "/v1/chat/completions") {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
				chatModels.push(body.model);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`data: ${JSON.stringify({
						id: "fixture",
						object: "chat.completion.chunk",
						created: 0,
						model: body.model,
						choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
					})}\n\ndata: [DONE]\n\n`,
				);
				return;
			}
			response.writeHead(404).end();
		})();
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, chatModels };
}

const jsonArgs = ["-p", "hi", "--mode", "json", "--provider", "october", "--model", PAID_ID];

async function runOctoberCli(
	gateway: Gateway,
	args: string[] = jsonArgs,
): Promise<{ stdout: string; stderr: string; code: number | null; records: Record<string, unknown>[] }> {
	const root = mkdtempSync(join(tmpdir(), "october-json-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// Skip the first-run default package install; this test must not touch npm.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ octoberDefaultPackagesVersion: 999 }));

	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("OCTOBER_") && key !== "PI_OFFLINE") env[key] = value;
	}
	Object.assign(env, {
		[ENV_AGENT_DIR]: agentDir,
		OCTOBER_INFERENCE_BASE_URL: gateway.baseUrl,
		OCTOBER_INFERENCE_TOKEN: "oct_inf_fixture",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	});
	const child = spawn(process.execPath, ["--import", sourceResolverPath, cliPath, ...args], {
		cwd: projectDir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const [code] = (await once(child, "close")) as [number | null];
	const records = stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	return { stdout, stderr, code, records };
}

describe("October --mode json startup", () => {
	it("discovers gateway OpenRouter routes on a fresh October-only profile before listing models", async () => {
		const gateway = await startGateway([PAID_ID]);
		const result = await runOctoberCli(gateway, ["--list-models", PAID_ID]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^october\s+openrouter\/deepseek\/deepseek-v4\s+.*October account via OpenRouter$/m,
		);
		expect(gateway.chatModels).toEqual([]);
	}, 60_000);

	it("resolves a gateway-served OpenRouter id without a warning and sends it verbatim", async () => {
		const gateway = await startGateway(["october/Qwen/Qwen3.6-35B-A3B-FP8", NEAR_MISS_ID, PAID_ID]);
		const result = await runOctoberCli(gateway);

		expect(result.code, result.stderr).toBe(0);
		expect(gateway.chatModels).toEqual([PAID_ID]);
		expect(result.records.filter((record) => record.type === "diagnostic")).toEqual([]);
		expect(result.stderr).not.toMatch(/not found/i);
	}, 60_000);

	it("fails with model_not_found instead of substituting a similar id the live catalogue offers", async () => {
		const gateway = await startGateway(["october/Qwen/Qwen3.6-35B-A3B-FP8", NEAR_MISS_ID]);
		const result = await runOctoberCli(gateway);

		expect(result.code).toBe(1);
		expect(gateway.chatModels).toEqual([]);
		const diagnostics = result.records.filter((record) => record.type === "diagnostic");
		expect(diagnostics).toEqual([
			{
				type: "diagnostic",
				level: "error",
				code: "model_not_found",
				message: `Model "${PAID_ID}" is not offered by October (model_not_found). Use --list-models to see available models.`,
			},
		]);
		expect(diagnostics[0]).not.toHaveProperty("stopReason");
		expect(result.stderr).toBe("");
	}, 60_000);

	it("keeps the requested id and reports the warning as a stdout record when the catalogue is unreachable", async () => {
		const gateway = await startGateway([], 503);
		const result = await runOctoberCli(gateway);

		expect(result.code, result.stderr).toBe(0);
		expect(gateway.chatModels).toEqual([PAID_ID]);
		const warning = result.records.find((record) => record.type === "diagnostic");
		expect(warning).toMatchObject({ type: "diagnostic", level: "warning", code: "model_unverified" });
		expect(warning?.message).toContain(`"${PAID_ID}" as given`);
		expect(warning).not.toHaveProperty("stopReason");
		expect(result.stderr).toBe("");
	}, 60_000);

	it("reports a new --session-id as a stdout record instead of stderr text", async () => {
		const gateway = await startGateway([PAID_ID]);
		const result = await runOctoberCli(gateway, [
			...jsonArgs,
			"--session-id",
			"0199a1b2-c3d4-7e5f-8a6b-9c0d1e2f3a4b",
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(result.records).toContainEqual(expect.objectContaining({ type: "diagnostic", code: "session_created" }));
		expect(result.stderr).not.toContain("No project session found");
	}, 60_000);
});
