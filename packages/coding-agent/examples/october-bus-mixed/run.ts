import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const RELEASE = "0.1.0-rc.4";
const PROTOCOL = "0.1";
const INSTALL =
	"Install the checksum-verified v0.1.0-rc.4 archive as described in packages/coding-agent/examples/october-bus/README.md, then pass --bus /path/to/october-bus.";
type Role = "planner" | "reviewer";

interface OwnedProcess {
	child: ChildProcess;
	label: string;
	closed: boolean;
	stdout: string;
	stderr: string;
	error?: Error;
}

interface Evidence {
	requestIds: string[];
	responseIds: string[];
	acknowledgedMessageIds: string[];
	checks: string[];
}

function object(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value), "Expected a Bus/IPC object");
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	assert(typeof value === "string" && value.length > 0, "Expected a nonempty Bus/IPC string");
	return value;
}

function strings(value: unknown): string[] {
	assert(Array.isArray(value) && value.every((entry) => typeof entry === "string"), "Expected an IPC string array");
	return value;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		signal?.throwIfAborted();
		assert(Date.now() < deadline, `Timed out after ${timeoutMs}ms`);
		await delay(25);
	}
	signal?.throwIfAborted();
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { bus: { type: "string" }, help: { type: "boolean" } }, strict: true });
	if (values.help) {
		console.log("Usage: tsx packages/coding-agent/examples/october-bus-mixed/run.ts [--bus PATH]");
		console.log(INSTALL);
		return;
	}
	const selected = values.bus ?? process.env.OCTOBER_BUS_BINARY ?? "october-bus";
	const binary = /[/\\]/.test(selected) ? resolve(selected) : selected;
	const root = mkdtempSync(join(tmpdir(), "october-bus-mixed-"));
	const owned: OwnedProcess[] = [];
	const secrets: string[] = [];
	const workflow = new AbortController();
	let stopping = false;
	const timeout = setTimeout(() => workflow.abort(new Error("Mixed-harness workflow exceeded 45 seconds")), 45_000);
	const interrupt = (): void => workflow.abort(new Error("Interrupted by SIGINT"));
	const terminate = (): void => workflow.abort(new Error("Interrupted by SIGTERM"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	// Allow only platform settings. No inherited Bus, model, proxy, or Node-loader credentials/configuration.
	const platformEnv: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) {
		if (process.env[key]) platformEnv[key] = process.env[key];
	}
	const daemonEnv = {
		...platformEnv,
		OCTOBER_BUS_DATA_DIR: join(root, "data"),
		OCTOBER_BUS_RUNTIME_DIR: join(root, "run"),
	};
	const redact = (value: string): string =>
		secrets.reduce((output, secret) => output.replaceAll(secret, "[redacted]"), value);
	const launch = (
		label: string,
		command: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		persistent = false,
		ipc = false,
	): OwnedProcess => {
		const child = spawn(command, args, {
			cwd: root,
			env,
			stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
		});
		const entry: OwnedProcess = { child, label, closed: false, stdout: "", stderr: "" };
		owned.push(entry);
		child.stdout?.on("data", (chunk: Buffer) => {
			entry.stdout = (entry.stdout + chunk.toString()).slice(-16_384);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			entry.stderr = (entry.stderr + chunk.toString()).slice(-16_384);
		});
		child.on("error", (error) => {
			entry.error = error;
			if (persistent && !stopping) workflow.abort(new Error(`${label} could not start: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			entry.closed = true;
			if (persistent && !stopping)
				workflow.abort(new Error(`${label} exited unexpectedly (${signal ?? code}): ${redact(entry.stderr)}`));
		});
		return entry;
	};
	const command = async (args: string[]): Promise<string> => {
		const entry = launch(`bus ${args[0]}`, binary, args, daemonEnv);
		await waitFor(() => entry.closed, 5000, workflow.signal);
		if (entry.error) throw entry.error;
		assert.equal(entry.child.exitCode, 0, `${entry.label} failed: ${redact(entry.stderr)}`);
		return entry.stdout;
	};
	let failed: unknown;
	try {
		let version: string;
		try {
			version = (await command(["version"])).trim();
		} catch {
			throw new Error(`Cannot run the pinned October Bus binary. ${INSTALL}`);
		}
		assert.equal(version, `october-bus ${RELEASE} (protocol ${PROTOCOL})`, `Wrong October Bus release. ${INSTALL}`);
		console.log(`bus: ${version}`);
		const daemon = launch("daemon", binary, ["start"], daemonEnv, true);
		const runPath = join(root, "run", "bus.json");
		await waitFor(() => existsSync(runPath), 10_000, workflow.signal);
		const run = object(JSON.parse(readFileSync(runPath, "utf8")));
		const address = text(run.address);
		const adminToken = text(run.adminToken);
		secrets.push(adminToken);
		const url = new URL(address);
		assert(
			url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === address,
			"Isolated Bus must use a loopback HTTP origin",
		);
		assert.equal(run.pid, daemon.child.pid, "Runfile must belong to the daemon we started");
		console.log(`daemon: pid=${daemon.child.pid} address=${address}`);
		const api = async (route: string, token: string, input: unknown): Promise<Record<string, unknown>> => {
			const response = await fetch(`${address}${route}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(input),
				redirect: "error",
				signal: AbortSignal.any([workflow.signal, AbortSignal.timeout(5000)]),
			});
			assert(response.ok, `Bus ${route}: HTTP ${response.status}`);
			return object(object(await response.json()).result);
		};
		const scopeToken = text((await api("/v1/scopes", adminToken, { id: "mixed-harness-example" })).scopeToken);
		secrets.push(scopeToken);
		// The parent owns identity: it registers both executions and links them. It never relays messages.
		const registrations = new Map<Role, Record<string, unknown>>();
		for (const role of ["planner", "reviewer"] as const) {
			const registration = await api("/v1/agents", scopeToken, {
				id: role,
				displayName: role === "planner" ? "October Harness planner" : "Minimal reviewer client",
				connectTo: role === "reviewer" ? ["planner"] : [],
				leaseMs: 300_000,
			});
			secrets.push(text(registration.agentToken));
			registrations.set(role, registration);
		}
		const busEnv = (role: Role): NodeJS.ProcessEnv => {
			const registration = registrations.get(role)!;
			return {
				OCTOBER_BUS_ADDRESS: address,
				OCTOBER_BUS_AGENT_ID: text(registration.agentId),
				OCTOBER_BUS_EXECUTION_ID: text(registration.executionId),
				OCTOBER_BUS_AGENT_TOKEN: text(registration.agentToken),
			};
		};
		const plannerDir = join(root, "planner");
		mkdirSync(plannerDir);
		const children: Record<Role, { process: OwnedProcess; ready: boolean; evidence?: Evidence }> = {
			planner: {
				ready: false,
				process: launch(
					"planner",
					process.execPath,
					["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./harness-worker.ts", import.meta.url))],
					{
						...platformEnv,
						...busEnv("planner"),
						OCTOBER_BUS_MCP_URL: `${address}/mcp`,
						OCTOBER_CODING_AGENT_DIR: plannerDir,
						PI_OFFLINE: "1",
						AWS_EC2_METADATA_DISABLED: "true",
					},
					true,
					true,
				),
			},
			// Plain node: the reviewer has no build step, loader, or harness dependency.
			reviewer: {
				ready: false,
				process: launch(
					"reviewer",
					process.execPath,
					[fileURLToPath(new URL("./minimal-client.ts", import.meta.url))],
					{ ...platformEnv, ...busEnv("reviewer"), EXAMPLE_EXPECTED_REQUESTS: "2" },
					true,
					true,
				),
			},
		};
		for (const role of ["planner", "reviewer"] as const) {
			const worker = children[role];
			worker.process.child.on("message", (value: unknown) => {
				try {
					const message = object(value);
					assert.equal(message.role, role);
					assert.equal(message.pid, worker.process.child.pid);
					if (message.type === "ready") {
						assert(!worker.ready, "Duplicate readiness");
						worker.ready = true;
						console.log(`${role}: pid=${worker.process.child.pid} ready`);
						return;
					}
					assert(message.type === "complete" && worker.ready && !worker.evidence, "Unexpected evidence");
					if (role === "planner") assert.equal(message.settledTurns, 3);
					worker.evidence = {
						requestIds: strings(message.requestIds),
						responseIds: strings(message.responseIds),
						acknowledgedMessageIds: strings(message.acknowledgedMessageIds),
						checks: strings(message.checks),
					};
				} catch (error) {
					workflow.abort(error);
				}
			});
		}
		await waitFor(() => children.planner.ready && children.reviewer.ready, 15_000, workflow.signal);
		console.log("planner: prompting once; reply turns must come from Bus delivery");
		children.planner.process.child.send({ type: "start" });
		await waitFor(() => Boolean(children.planner.evidence && children.reviewer.evidence), 30_000, workflow.signal);
		const planner = children.planner.evidence!;
		const reviewer = children.reviewer.evidence!;
		// Both sides must agree on every ID even though neither saw the other's process.
		assert.equal(planner.requestIds.length, 2);
		assert.deepEqual(reviewer.requestIds, planner.requestIds, "Reviewer received exactly the planner's requests");
		assert.deepEqual(planner.responseIds, reviewer.responseIds, "Planner received exactly the reviewer's responses");
		assert.deepEqual(reviewer.acknowledgedMessageIds, planner.requestIds);
		for (const id of planner.responseIds) assert(planner.acknowledgedMessageIds.includes(id), `Unacknowledged ${id}`);
		for (const [role, evidence] of Object.entries(children))
			console.log(`evidence ${role}: ${JSON.stringify(evidence.evidence)}`);
	} catch (error) {
		failed = error;
	} finally {
		stopping = true;
		clearTimeout(timeout);
		// Reverse startup order; never invoke a global bus stop or signal an unowned PID.
		for (const entry of [...owned].reverse()) {
			if (entry.closed) continue;
			try {
				if (entry.child.connected) entry.child.send({ type: "shutdown" });
				else entry.child.kill("SIGTERM");
				try {
					await waitFor(() => entry.closed, 3000);
				} catch {
					entry.child.kill("SIGKILL");
					await waitFor(() => entry.closed, 5000);
					failed ??= new Error(`${entry.label} required forced termination`);
				}
			} catch (error) {
				failed ??= error;
			}
		}
		for (const entry of owned) {
			if (entry.closed && entry.child.exitCode !== 0) {
				failed ??= new Error(`${entry.label} exited with ${entry.child.signalCode ?? entry.child.exitCode}`);
			}
		}
		if (workflow.signal.aborted) failed ??= workflow.signal.reason;
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		if (owned.every((entry) => entry.closed)) {
			rmSync(root, { recursive: true, force: true });
			console.log(`cleanup: all owned processes exited; removed ${root}`);
		} else {
			failed ??= new Error(`Cleanup incomplete; retained ${root}`);
		}
	}
	if (failed) {
		for (const entry of owned)
			if (entry.stderr.trim()) console.error(`${entry.label} stderr: ${redact(entry.stderr.trim())}`);
		throw new Error(redact(failed instanceof Error ? failed.message : String(failed)));
	}
	console.log("PASS: discovery, delegation, correlation, success and error responses verified across two harnesses");
}

main().catch((error: unknown) => {
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
