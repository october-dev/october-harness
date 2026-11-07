// october doctor (#50)
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DoctorCheck, type DoctorReport, redactSecrets, runDoctor, runDoctorCommand } from "../src/cli/doctor.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const tempDirs: string[] = [];
const servers: Server[] = [];

interface FixtureHome {
	home: string;
	agentDir: string;
	project: string;
	/** Empty PATH directory; tests add executables to it. */
	bin: string;
	env: NodeJS.ProcessEnv;
}

function createFixtureHome(): FixtureHome {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "october-doctor-")));
	tempDirs.push(root);
	const home = join(root, "home");
	const agentDir = join(home, ".october", "agent");
	const project = join(root, "project");
	const bin = join(root, "bin");
	for (const dir of [agentDir, project, bin]) mkdirSync(dir, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	return { home, agentDir, project, bin, env: { HOME: home, PATH: bin } };
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

/** A models.json provider whose credentials come from an environment variable the tests control. */
function writeTestProvider(agentDir: string, baseUrl = "http://127.0.0.1:9/v1"): void {
	writeJson(join(agentDir, "models.json"), {
		providers: {
			"doctor-test": {
				baseUrl,
				api: "openai-completions",
				apiKey: "$OCTOBER_DOCTOR_TEST_KEY",
				models: [{ id: "test-model" }],
			},
		},
	});
	writeJson(join(agentDir, "settings.json"), { defaultProvider: "doctor-test", defaultModel: "test-model" });
}

function check(report: DoctorReport, id: string): DoctorCheck {
	const found = report.checks.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing check ${id}: ${report.checks.map((entry) => entry.id).join(", ")}`);
	return found;
}

function doctor(fixture: FixtureHome, options: { probe?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
	return runDoctor({
		agentDir: fixture.agentDir,
		cwd: fixture.project,
		env: { ...fixture.env, ...options.env },
		probe: options.probe,
		timeoutMs: options.timeoutMs,
	});
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

beforeEach(() => {
	vi.stubEnv("OCTOBER_DOCTOR_TEST_KEY", undefined);
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolveClose) => server.close(resolveClose));
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("october doctor", () => {
	it("passes a clean installation without writing to the fixture home", async () => {
		const fixture = createFixtureHome();

		const report = await doctor(fixture);

		expect(report).toMatchObject({ schemaVersion: 1, ok: true, probe: false });
		expect(report.checks.map((entry) => entry.id)).toEqual([
			"executable",
			"runtime",
			"assets",
			"config.settings",
			"config.models",
			"config.auth",
			"models.default",
			"models.enabled",
			"bus.env",
			"bus.binary",
			"bus.scopes",
		]);
		for (const id of ["executable", "runtime", "assets", "config.settings"]) {
			expect(check(report, id).status).toBe("pass");
		}
		for (const id of ["config.models", "config.auth", "models.enabled", "bus.env", "bus.scopes"]) {
			expect(check(report, id).status).toBe("skip");
		}
		expect(readdirSync(fixture.agentDir)).toEqual([]);
	});

	it("reports malformed configuration files", async () => {
		const fixture = createFixtureHome();
		writeJson(join(fixture.agentDir, "settings.json"), "{not json");
		writeJson(join(fixture.agentDir, "models.json"), { providers: { broken: { models: "nope" } } });
		writeJson(join(fixture.agentDir, "auth.json"), { openai: { type: "unknown" } });

		const report = await doctor(fixture);

		expect(report.ok).toBe(false);
		expect(check(report, "config.settings")).toMatchObject({ status: "fail" });
		expect(check(report, "config.settings").summary).toContain("~/.october/agent/settings.json");
		expect(check(report, "config.models")).toMatchObject({ status: "fail" });
		expect(check(report, "config.models").summary).toContain("Invalid models.json schema");
		expect(check(report, "config.auth")).toMatchObject({ status: "fail" });
		for (const id of ["config.settings", "config.models", "config.auth"]) {
			expect(check(report, id).remediation).toBeTruthy();
		}
	});

	it("reports missing packaged assets", async () => {
		const fixture = createFixtureHome();
		vi.stubEnv("PI_PACKAGE_DIR", fixture.bin);

		const result = check(await doctor(fixture), "assets");

		expect(result.status).toBe("fail");
		expect(result.summary).toContain("dark theme");
		expect(result.remediation).toContain("PI_PACKAGE_DIR");
	});

	it("reports a default model that is missing or has no credentials", async () => {
		const fixture = createFixtureHome();
		writeTestProvider(fixture.agentDir);

		const unavailable = check(await doctor(fixture), "models.default");
		expect(unavailable).toMatchObject({ status: "fail" });
		expect(unavailable.summary).toContain("doctor-test/test-model has no credentials");
		expect(unavailable.remediation).toContain("login doctor-test");

		vi.stubEnv("OCTOBER_DOCTOR_TEST_KEY", "doctor-test-key-value");
		expect(check(await doctor(fixture), "models.default").status).toBe("pass");

		writeJson(join(fixture.agentDir, "settings.json"), {
			defaultProvider: "doctor-test",
			defaultModel: "missing-model",
			enabledModels: ["no-such-model-pattern"],
		});
		const report = await doctor(fixture);
		expect(check(report, "models.default")).toMatchObject({ status: "fail" });
		expect(check(report, "models.default").summary).toContain("not in the model catalog");
		expect(check(report, "models.enabled")).toMatchObject({ status: "warn" });
	});

	it("reports incomplete October Bus settings", async () => {
		const fixture = createFixtureHome();

		const session = check(await doctor(fixture, { env: { OCTOBER_BUS_AGENT_ID: "agent-1" } }), "bus.env");
		expect(session.status).toBe("fail");
		expect(session.summary).toContain("OCTOBER_BUS_MCP_URL");
		expect(session.summary).not.toContain("OCTOBER_BUS_AGENT_ID");

		const desktop = check(await doctor(fixture, { env: { OCTOBER_BUS_PORT: "4100" } }), "bus.env");
		expect(desktop.status).toBe("fail");
		expect(desktop.summary).toContain("OCTOBER_BUS_CANVAS");

		const joining = check(await doctor(fixture, { env: { OCTOBER_BUS_ADDRESS: "https://bus.example" } }), "bus.env");
		expect(joining.status).toBe("fail");
		expect(joining.summary).toContain("OCTOBER_BUS_SCOPE_TOKEN");

		const binary = check(
			await doctor(fixture, { env: { OCTOBER_BUS_BINARY: join(fixture.bin, "missing") } }),
			"bus.binary",
		);
		expect(binary.status).toBe("fail");
	});

	it.skipIf(process.platform === "win32")("reports a team scope store readable by others", async () => {
		const fixture = createFixtureHome();
		const path = join(fixture.agentDir, "team-scopes.json");
		writeJson(path, { version: 1, scopes: { "scope:a": { scopeId: "a", scopeToken: "scope-token-secret" } } });
		chmodSync(path, 0o644);

		const result = check(await doctor(fixture), "bus.scopes");

		expect(result.status).toBe("fail");
		expect(result.remediation).toContain("chmod 600");
		chmodSync(path, 0o600);
		expect(check(await doctor(fixture), "bus.scopes")).toMatchObject({
			status: "pass",
			summary: "1 saved team scope",
		});
	});

	it("redacts credentials from every reported value", async () => {
		const fixture = createFixtureHome();
		writeJson(
			join(fixture.agentDir, "auth.json"),
			'{"openai": {"type": "api_key", "key": sk-auth-secret-0123456789}}',
		);
		writeJson(join(fixture.agentDir, "models.json"), '{"providers": {"x": {"apiKey": models-secret-0123456789}}}');
		const env = {
			OCTOBER_BUS_ADDRESS: "https://bus-user:bus-password-secret@bus.example/",
			OCTOBER_BUS_SCOPE_TOKEN: "scope-token-secret-0123456789",
		};

		const report = await doctor(fixture, { env });
		const output = JSON.stringify(report);

		expect(check(report, "config.auth").status).toBe("fail");
		expect(check(report, "config.models").status).toBe("fail");
		expect(check(report, "bus.env")).toMatchObject({ status: "pass" });
		for (const secret of ["sk-auth-secret", "models-secret", "bus-password-secret", "scope-token-secret"]) {
			expect(output).not.toContain(secret);
		}
		expect(redactSecrets("token value-0123456789 and Bearer abc.def", ["value-0123456789"])).toBe(
			"token <redacted> and Bearer <redacted>",
		);
	});

	it("probes the default provider only when requested, within the timeout", async () => {
		const fixture = createFixtureHome();
		let requests = 0;
		const answering = await listen((_request, response) => {
			requests++;
			response.statusCode = 401;
			response.end();
		});
		writeTestProvider(fixture.agentDir, answering);

		const local = await doctor(fixture);
		expect(local.checks.some((entry) => entry.id.startsWith("probe."))).toBe(false);
		expect(requests).toBe(0);

		const probed = await doctor(fixture, { probe: true, timeoutMs: 2_000 });
		expect(check(probed, "probe.provider")).toMatchObject({ status: "pass" });
		expect(check(probed, "probe.provider").summary).toContain("HTTP 401");
		expect(requests).toBe(1);

		const silent = await listen(() => {});
		writeTestProvider(fixture.agentDir, silent);
		const started = Date.now();
		const timedOut = check(await doctor(fixture, { probe: true, timeoutMs: 200 }), "probe.provider");
		expect(timedOut.status).toBe("fail");
		expect(timedOut.summary).toContain("no response within 200 ms");
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")("summarizes the October Bus doctor when probing", async () => {
		const fixture = createFixtureHome();
		const bus = join(fixture.bin, "october-bus");
		writeFileSync(
			bus,
			`#!/bin/sh\n[ "$1" = doctor ] || exit 2\necho '{"healthy":true,"protocolVersion":"0.1","runtimeVersion":"0.1.0-rc.4","address":"127.0.0.1:4100","pid":1}'\n`,
		);
		chmodSync(bus, 0o755);

		const report = await doctor(fixture, { probe: true });

		expect(check(report, "bus.binary")).toMatchObject({ status: "pass" });
		expect(check(report, "bus.doctor")).toMatchObject({
			status: "pass",
			details: { healthy: true, protocolVersion: "0.1", runtimeVersion: "0.1.0-rc.4", address: "127.0.0.1:4100" },
		});

		writeFileSync(bus, `#!/bin/sh\necho '{"healthy":false,"protocolVersion":"0.1"}'\n`);
		expect(check(await doctor(fixture, { probe: true }), "bus.doctor")).toMatchObject({ status: "fail" });
	});

	it("rejects unknown options and out-of-range timeouts", async () => {
		const fixture = createFixtureHome();
		const errors: string[] = [];
		const options = {
			agentDir: fixture.agentDir,
			cwd: fixture.project,
			env: fixture.env,
			error: (line: string) => errors.push(line),
			log: () => {},
		};

		expect(await runDoctorCommand(["--bogus"], options)).toBe(1);
		expect(await runDoctorCommand(["--timeout", "0"], options)).toBe(1);
		expect(await runDoctorCommand(["--timeout=60001"], options)).toBe(1);
		expect(errors).toHaveLength(3);
	});

	it("prints a JSON report from the CLI and exits 1 on failure", async () => {
		const fixture = createFixtureHome();
		writeJson(join(fixture.agentDir, "settings.json"), "{not json");

		const result = await new Promise<{ code: number | null; stdout: string }>((resolveRun, reject) => {
			let stdout = "";
			const child = spawn(process.execPath, ["--import", sourceResolverPath, cliPath, "doctor", "--json"], {
				cwd: fixture.project,
				env: {
					...fixture.env,
					PATH: fixture.bin,
					[ENV_AGENT_DIR]: fixture.agentDir,
					PI_OFFLINE: "1",
					NO_COLOR: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => resolveRun({ code, stdout }));
		});

		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout) as DoctorReport;
		expect(report.schemaVersion).toBe(1);
		expect(check(report, "config.settings").status).toBe("fail");
		expect(readdirSync(fixture.agentDir)).toEqual(["settings.json"]);
	});
});
