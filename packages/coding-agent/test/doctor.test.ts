// october doctor (#50)
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DoctorCheck, type DoctorReport, redactSecrets, runDoctor, runDoctorCommand } from "../src/cli/doctor.ts";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../src/config.ts";
import { getDesktopOctoberCredential, resetDesktopOctoberState } from "../src/extensions/october/auth.ts";
import { OCTOBER_DEFAULT_MODEL_ID } from "../src/extensions/october/provider.ts";

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

async function listenPort(handler: Parameters<typeof createServer>[1]): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	return (server.address() as AddressInfo).port;
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
	return `http://127.0.0.1:${await listenPort(handler)}/v1`;
}

/**
 * Records every entry created, changed, or removed in `dirs` while `run` executes, including entries
 * that exist only briefly, such as lock directories. Marker files written before and after `run`
 * prove the watchers are live and that all earlier events were delivered. Works for any user, root included.
 */
async function recordFileChanges<T>(dirs: string[], run: () => Promise<T>): Promise<{ result: T; changes: string[] }> {
	const seen: string[] = [];
	const watchers = dirs.map((dir) =>
		watch(dir, (_event, name) => {
			seen.push(join(dir, String(name ?? "")));
		}),
	);
	const settle = async (marker: string) => {
		// A new watcher can miss its first events, so rewrite each marker until it is reported.
		const deadline = Date.now() + 10_000;
		for (;;) {
			const pending = dirs.filter((dir) => !seen.includes(join(dir, marker)));
			if (pending.length === 0) return;
			if (Date.now() > deadline) throw new Error(`fs.watch did not report ${marker} in ${pending.join(", ")}`);
			for (const dir of pending) writeFileSync(join(dir, marker), String(Date.now()));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	};
	try {
		await settle(".doctor-watch-start");
		const start = seen.length;
		const result = await run();
		await settle(".doctor-watch-end");
		const changes = seen.slice(start).filter((path) => !/\.doctor-watch-(start|end)$/.test(path));
		return { result, changes: [...new Set(changes)] };
	} finally {
		for (const watcher of watchers) watcher.close();
		for (const dir of dirs) {
			rmSync(join(dir, ".doctor-watch-start"), { force: true });
			rmSync(join(dir, ".doctor-watch-end"), { force: true });
		}
	}
}

/** Variables of the shared October authentication code; each test starts without them. */
const OCTOBER_AUTH_VARIABLES = [
	"OCTOBER_BUS_PORT",
	"OCTOBER_BUS_TOKEN",
	"OCTOBER_BUS_CANVAS",
	"OCTOBER_BUS_NODE",
	"OCTOBER_TOKEN_COMMAND",
	"OCTOBER_INFERENCE_TOKEN",
	"OCTOBER_INFERENCE_BASE_URL",
	"OCTOBER_SUPABASE_URL",
	"OCTOBER_SUPABASE_ANON_KEY",
	"OCTOBER_SUPABASE_ACCESS_TOKEN",
	"OCTOBER_SUPABASE_REFRESH_TOKEN",
	"OCTOBER_SUPABASE_EXPIRES_AT",
	"OCTOBER_SUPABASE_USER_ID",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
];

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

interface ManagedSessionFixture {
	env: NodeJS.ProcessEnv;
	/** Requests to the Desktop Bus token route. */
	busRequests: () => number;
	/** Created when OCTOBER_TOKEN_COMMAND runs. */
	tokenCommandMarker: string;
}

/**
 * Inject a managed October session into the real process.env, as October Desktop (`desktop`) or
 * another launching app that keeps the refresh token (`app`) would. The shared authentication code
 * reads process.env, so DoctorOptions.env alone would not isolate it.
 */
async function stubManagedSession(
	fixture: FixtureHome,
	options: { owner: "desktop" | "app"; expiresInMs: number; refresher?: boolean },
): Promise<ManagedSessionFixture> {
	let busRequests = 0;
	const tokenCommandMarker = join(fixture.home, "token-command-ran");
	const expiresAt = Math.floor((Date.now() + options.expiresInMs) / 1000);
	const env: NodeJS.ProcessEnv = {
		OCTOBER_SUPABASE_URL: "http://127.0.0.1:9",
		OCTOBER_SUPABASE_ANON_KEY: "doctor-anon-key-fixture",
		OCTOBER_SUPABASE_ACCESS_TOKEN: `${base64url({ alg: "none" })}.${base64url({ exp: expiresAt, sub: "user-1" })}.signature`,
		OCTOBER_SUPABASE_EXPIRES_AT: String(expiresAt),
	};
	if (options.owner === "desktop") {
		const port = await listenPort((_request, response) => {
			busRequests++;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ access_token: "refreshed-desktop-token", expires_at: expiresAt + 3600 }));
		});
		env.OCTOBER_BUS_PORT = String(port);
		env.OCTOBER_BUS_CANVAS = "canvas-1";
		env.OCTOBER_BUS_NODE = "node-1";
		if (options.refresher !== false) env.OCTOBER_BUS_TOKEN = "doctor-bus-token-fixture";
	} else if (options.refresher !== false) {
		const script = join(fixture.bin, "token-command");
		writeFileSync(
			script,
			`#!/bin/sh\ntouch "${tokenCommandMarker}"\necho '{"accessToken":"refreshed-app-token","expiresAt":${expiresAt + 3600}}'\n`,
		);
		chmodSync(script, 0o755);
		env.OCTOBER_TOKEN_COMMAND = script;
	}
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	writeJson(join(fixture.agentDir, "settings.json"), {
		defaultProvider: "october",
		defaultModel: OCTOBER_DEFAULT_MODEL_ID,
	});
	return { env, busRequests: () => busRequests, tokenCommandMarker };
}

/** Run doctor and assert it changed nothing: no refresh, token command, environment, state, or files. */
async function doctorWithoutSideEffects(
	fixture: FixtureHome,
	session: ManagedSessionFixture,
	options: { probe?: boolean } = {},
): Promise<DoctorReport> {
	const { result, changes } = await recordFileChanges([fixture.home, fixture.agentDir, fixture.bin], () =>
		doctor(fixture, { env: session.env, probe: options.probe }),
	);
	expect(changes).toEqual([]);
	expect(session.busRequests()).toBe(0);
	expect(existsSync(session.tokenCommandMarker)).toBe(false);
	expect(existsSync(join(fixture.agentDir, "october-debug.log"))).toBe(false);
	expect(process.env.OCTOBER_INFERENCE_TOKEN).toBeUndefined();
	expect(getDesktopOctoberCredential()).toBeUndefined();
	return result;
}

beforeEach(() => {
	vi.stubEnv("OCTOBER_DOCTOR_TEST_KEY", undefined);
	for (const name of OCTOBER_AUTH_VARIABLES) vi.stubEnv(name, undefined);
	resetDesktopOctoberState();
});

afterEach(async () => {
	resetDesktopOctoberState();
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
			"october.session",
			"models.default",
			"models.enabled",
			"bus.env",
			"bus.binary",
			"bus.scopes",
		]);
		for (const id of ["executable", "runtime", "assets", "config.settings"]) {
			expect(check(report, id).status).toBe("pass");
		}
		for (const id of ["config.models", "config.auth", "october.session", "models.enabled", "bus.env", "bus.scopes"]) {
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

	it("warns instead of failing for an October default missing from the offline catalog", async () => {
		const fixture = createFixtureHome();
		writeJson(join(fixture.agentDir, "settings.json"), {
			defaultProvider: "october",
			defaultModel: "october/gateway-only-model",
		});

		const unauthenticated = check(await doctor(fixture), "models.default");
		expect(unauthenticated.status).toBe("fail");
		expect(unauthenticated.summary).toContain("has no credentials");

		vi.stubEnv("OCTOBER_INFERENCE_TOKEN", "doctor-inference-token-fixture");
		const report = await doctor(fixture);
		const result = check(report, "models.default");
		expect(result.status).toBe("warn");
		expect(result.summary).toContain("october/gateway-only-model");
		expect(result.summary).toContain("unverified");
		expect(result.remediation).not.toContain("defaultModel");
		expect(result.remediation).not.toContain("settings.json");
		expect(report.ok).toBe(true);

		// Static catalogs still fail: an unknown provider, and a missing model of a configured provider.
		writeJson(join(fixture.agentDir, "settings.json"), { defaultProvider: "no-such-provider", defaultModel: "x" });
		expect(check(await doctor(fixture), "models.default")).toMatchObject({ status: "fail" });
		writeTestProvider(fixture.agentDir);
		writeJson(join(fixture.agentDir, "settings.json"), { defaultProvider: "doctor-test", defaultModel: "missing" });
		expect(check(await doctor(fixture), "models.default").summary).toContain("not in the model catalog");
	});

	describe.skipIf(process.platform === "win32")("managed October sessions", () => {
		const cases = [
			{ owner: "desktop", state: "valid", expiresInMs: 60 * 60_000, session: "pass", model: "pass" },
			{ owner: "desktop", state: "near expiry", expiresInMs: 3 * 60_000, session: "pass", model: "pass" },
			{ owner: "desktop", state: "expired", expiresInMs: -10 * 60_000, session: "warn", model: "warn" },
			{ owner: "app", state: "valid", expiresInMs: 60 * 60_000, session: "pass", model: "pass" },
			{ owner: "app", state: "near expiry", expiresInMs: 3 * 60_000, session: "pass", model: "pass" },
			{ owner: "app", state: "expired", expiresInMs: -10 * 60_000, session: "warn", model: "warn" },
		] as const;

		it.each(cases)("reads a $state $owner session without refreshing it", async (entry) => {
			const fixture = createFixtureHome();
			const session = await stubManagedSession(fixture, { owner: entry.owner, expiresInMs: entry.expiresInMs });

			const report = await doctorWithoutSideEffects(fixture, session);

			const owner = entry.owner === "desktop" ? "October Desktop" : "the launching app";
			expect(check(report, "october.session")).toMatchObject({ status: entry.session });
			expect(check(report, "october.session").summary).toContain(`Session from ${owner}`);
			// No auth.json and no OCTOBER_INFERENCE_TOKEN: the injected session alone is the credential.
			const model = check(report, "models.default");
			expect(model.status).toBe(entry.model);
			expect(model.summary).toContain(`session from ${owner}`);
			expect(model.summary).not.toContain("no credentials");
		});

		it("keeps the Desktop session authoritative over stored credentials", async () => {
			const fixture = createFixtureHome();
			writeJson(join(fixture.agentDir, "auth.json"), {
				october: { type: "api_key", key: "stored-october-key-fixture" },
			});

			const valid = await stubManagedSession(fixture, { owner: "desktop", expiresInMs: 60 * 60_000 });
			const used = check(await doctorWithoutSideEffects(fixture, valid), "models.default");
			expect(used.status).toBe("pass");
			expect(used.summary).toContain("session from October Desktop");

			// Desktop fails closed: an expired session it cannot refresh never falls back to the stored key.
			const expired = await stubManagedSession(fixture, {
				owner: "desktop",
				expiresInMs: -10 * 60_000,
				refresher: false,
			});
			vi.stubEnv("OCTOBER_BUS_TOKEN", undefined);
			const report = await doctorWithoutSideEffects(fixture, expired);
			expect(check(report, "october.session").status).toBe("fail");
			expect(check(report, "models.default")).toMatchObject({ status: "fail" });
			expect(check(report, "models.default").summary).toContain("expired");
		});

		it("reports when another app's expired session falls back to the stored credential", async () => {
			const fixture = createFixtureHome();
			writeJson(join(fixture.agentDir, "auth.json"), {
				october: { type: "api_key", key: "stored-october-key-fixture" },
			});
			const session = await stubManagedSession(fixture, {
				owner: "app",
				expiresInMs: -10 * 60_000,
				refresher: false,
			});

			const report = await doctorWithoutSideEffects(fixture, session);

			expect(check(report, "october.session").status).toBe("warn");
			const model = check(report, "models.default");
			expect(model.status).toBe("warn");
			expect(model.summary).toContain("use this credential instead");
		});

		it("reports a Desktop launch without a session", async () => {
			const fixture = createFixtureHome();
			const session = await stubManagedSession(fixture, { owner: "desktop", expiresInMs: 60 * 60_000 });
			vi.stubEnv("OCTOBER_SUPABASE_ACCESS_TOKEN", undefined);

			const report = await doctorWithoutSideEffects(fixture, session);

			expect(check(report, "october.session").status).toBe("warn");
			expect(check(report, "models.default").status).toBe("fail");
			expect(check(report, "models.default").summary).toContain("provided no session");
		});
	});

	it("reads existing settings without creating lock files", async () => {
		const fixture = createFixtureHome();
		const projectConfig = join(fixture.project, ".october");
		mkdirSync(projectConfig);
		writeJson(join(fixture.agentDir, "settings.json"), {
			defaultProvider: "doctor-test",
			defaultModel: "test-model",
		});
		writeJson(join(projectConfig, "settings.json"), { defaultModel: "project-model" });

		const { result, changes } = await recordFileChanges(
			[fixture.home, fixture.agentDir, fixture.project, projectConfig],
			() => doctor(fixture),
		);

		expect(check(result, "config.settings")).toMatchObject({ status: "pass" });
		expect(changes).toEqual([]);

		// A lock held by a running session neither blocks doctor nor reads as broken JSON.
		mkdirSync(join(fixture.agentDir, "settings.json.lock"));
		writeJson(join(projectConfig, "settings.json"), "{not json");
		const report = await doctor(fixture);
		expect(check(report, "config.settings").status).toBe("fail");
		expect(check(report, "config.settings").summary).toContain(join(fixture.project, ".october", "settings.json"));
		expect(check(report, "config.settings").summary).not.toContain("agent/settings.json");
	});

	it.skipIf(process.platform === "win32")(
		"reports malformed proxy settings under --json --probe without aborting",
		async () => {
			const fixture = createFixtureHome();
			writeTestProvider(fixture.agentDir);
			const bus = join(fixture.bin, "october-bus");
			writeFileSync(bus, `#!/bin/sh\necho '{"healthy":true,"protocolVersion":"0.1"}'\n`);
			chmodSync(bus, 0o755);
			const run = async () => {
				const lines: string[] = [];
				const code = await runDoctorCommand(["--json", "--probe"], {
					agentDir: fixture.agentDir,
					cwd: fixture.project,
					env: fixture.env,
					log: (line) => lines.push(line),
					error: (line) => lines.push(line),
				});
				const output = lines.join("\n");
				return { code, output, report: JSON.parse(output) as DoctorReport };
			};
			const proxies: Array<{ setting?: unknown; environment?: string; summary: string }> = [
				{ setting: 42, summary: "httpProxy must be a string" },
				{ setting: "http://proxy-user:proxy-secret-0123@[not-a-host", summary: "not a valid URL" },
				{ environment: "http://env-user:env-proxy-secret-0123@[not-a-host", summary: "Could not set up" },
			];

			for (const proxy of proxies) {
				const settings: Record<string, unknown> = { defaultProvider: "doctor-test", defaultModel: "test-model" };
				if (proxy.setting !== undefined) settings.httpProxy = proxy.setting;
				writeJson(join(fixture.agentDir, "settings.json"), settings);
				vi.stubEnv("HTTPS_PROXY", proxy.environment);

				const { code, output, report } = await run();

				expect(code).toBe(1);
				expect(report).toMatchObject({ schemaVersion: 1, ok: false, probe: true });
				expect(check(report, "probe.proxy")).toMatchObject({ status: "fail" });
				expect(check(report, "probe.proxy").summary).toContain(proxy.summary);
				expect(check(report, "probe.provider").status).toBe("skip");
				expect(check(report, "bus.doctor").status).toBe("pass");
				expect(check(report, "models.default").status).toBe("fail");
				for (const secret of ["proxy-secret", "env-proxy-secret"]) expect(output).not.toContain(secret);
			}
		},
	);

	it.skipIf(process.platform === "win32")("reports PATH wrappers informationally", async () => {
		const fixture = createFixtureHome();
		const wrapper = join(fixture.bin, "october");
		writeFileSync(wrapper, '#!/bin/sh\nexec node /somewhere/else/cli.js "$@"\n');
		chmodSync(wrapper, 0o755);

		const shim = check(await doctor(fixture), "executable");
		expect(shim.status).toBe("pass");
		expect(shim.summary).toContain("wrapper or launcher");
		expect(shim.details?.pathExecutable).toBe(wrapper);

		// A PATH entry inside another copy of the package is a separate installation.
		const other = join(fixture.home, "other-install");
		mkdirSync(join(other, "dist"), { recursive: true });
		writeJson(join(other, "package.json"), { name: PACKAGE_NAME, version: "0.0.1-other" });
		writeFileSync(join(other, "dist", "cli.js"), "#!/usr/bin/env node\n");
		chmodSync(join(other, "dist", "cli.js"), 0o755);
		rmSync(wrapper);
		symlinkSync(join(other, "dist", "cli.js"), wrapper);

		const duplicate = check(await doctor(fixture), "executable");
		expect(duplicate.status).toBe("warn");
		expect(duplicate.summary).toContain("another installation (0.0.1-other)");
	});

	it("rejects a malformed October Bus join address", async () => {
		const fixture = createFixtureHome();
		for (const address of ["not-a-url", "ftp://bus.example"]) {
			const result = check(
				await doctor(fixture, { env: { OCTOBER_BUS_ADDRESS: address, OCTOBER_BUS_SCOPE_TOKEN: "scope-token" } }),
				"bus.env",
			);
			expect(result.status).toBe("fail");
			expect(result.remediation).toContain("OCTOBER_BUS_ADDRESS");
		}
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

		const result = await runCli(fixture, ["doctor", "--json"]);

		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout) as DoctorReport;
		expect(report.schemaVersion).toBe(1);
		expect(check(report, "config.settings").status).toBe("fail");
		expect(readdirSync(fixture.agentDir)).toEqual(["settings.json"]);
	});

	it.skipIf(process.platform === "win32")(
		"exits promptly from the CLI in a Desktop session, with and without probes",
		async () => {
			const fixture = createFixtureHome();
			// Inside the refresh window, so an implicit refresh would contact the Bus token route.
			const session = await stubManagedSession(fixture, { owner: "desktop", expiresInMs: 3 * 60_000 });
			let gatewayRequests = 0;
			const gateway = await listen((_request, response) => {
				gatewayRequests++;
				response.statusCode = 401;
				response.end();
			});
			const bus = join(fixture.bin, "october-bus");
			writeFileSync(bus, `#!/bin/sh\necho '{"healthy":true,"protocolVersion":"0.1"}'\n`);
			chmodSync(bus, 0o755);
			const env = { ...session.env, OCTOBER_INFERENCE_BASE_URL: gateway.replace(/\/v1$/, "") };

			for (const args of [
				["doctor", "--json"],
				["doctor", "--json", "--probe"],
			]) {
				const started = Date.now();
				const result = await runCli(fixture, args, env);
				expect(Date.now() - started).toBeLessThan(20_000);
				const report = JSON.parse(result.stdout) as DoctorReport;
				expect(check(report, "october.session").status).toBe("pass");
				expect(check(report, "models.default").status).toBe("pass");
				expect(result.code).toBe(0);
			}
			expect(session.busRequests()).toBe(0);
			// Only the unauthenticated provider probe reaches the gateway.
			expect(gatewayRequests).toBe(1);
			expect(readdirSync(fixture.agentDir)).toEqual(["settings.json"]);
		},
		60_000,
	);
});

function runCli(
	fixture: FixtureHome,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolveRun, reject) => {
		let stdout = "";
		const child = spawn(process.execPath, ["--import", sourceResolverPath, cliPath, ...args], {
			cwd: fixture.project,
			env: {
				...fixture.env,
				...env,
				PATH: fixture.bin,
				[ENV_AGENT_DIR]: fixture.agentDir,
				PI_OFFLINE: "1",
				NO_COLOR: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ code, stdout });
		});
	});
}
