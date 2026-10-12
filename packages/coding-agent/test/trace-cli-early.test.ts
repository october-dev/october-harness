import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OctoberLogin from "../src/cli/october-login.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type * as BuiltInExtensions from "../src/extensions/index.ts";
import { main } from "../src/main.ts";
import type * as PackageManagerCli from "../src/package-manager-cli.ts";

// Regression: october-dev/october-harness#9

const bootstrap = vi.hoisted(() => ({
	createBuiltInExtensions: vi.fn(),
	handleOctoberLoginCommand: vi.fn(),
	cleanupManagedInstall: vi.fn(),
	handlePackageCommand: vi.fn(),
}));

vi.mock("../src/extensions/index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof BuiltInExtensions>();
	bootstrap.createBuiltInExtensions.mockImplementation(actual.createBuiltInExtensions);
	return { ...actual, createBuiltInExtensions: bootstrap.createBuiltInExtensions };
});
vi.mock("../src/cli/october-login.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof OctoberLogin>();
	bootstrap.handleOctoberLoginCommand.mockImplementation(actual.handleOctoberLoginCommand);
	return { ...actual, handleOctoberLoginCommand: bootstrap.handleOctoberLoginCommand };
});
vi.mock("../src/package-manager-cli.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof PackageManagerCli>();
	bootstrap.cleanupManagedInstall.mockImplementation(() => {});
	bootstrap.handlePackageCommand.mockImplementation(actual.handlePackageCommand);
	return {
		...actual,
		cleanupManagedInstall: bootstrap.cleanupManagedInstall,
		handlePackageCommand: bootstrap.handlePackageCommand,
	};
});

describe("trace flag validation before startup", () => {
	let dir = "";
	let errors: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-trace-early-"));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv("PI_OFFLINE", "1");
		errors = [];
		process.exitCode = undefined;
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		vi.spyOn(SettingsManager, "create");
		for (const spy of Object.values(bootstrap)) spy.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	function expectNoBootstrap(): void {
		expect(SettingsManager.create).not.toHaveBeenCalled();
		for (const spy of Object.values(bootstrap)) expect(spy).not.toHaveBeenCalled();
	}

	it.each([
		{ args: ["--replay-trace"], message: "--replay-trace requires a trace file path" },
		{ args: ["--trace"], message: "--trace requires a trace file path" },
		{ args: ["--trace", "TRACE", "--export", "session.jsonl"], message: "--trace cannot be combined with --export" },
		{ args: ["--trace", "TRACE", "--import", "portable.jsonl"], message: "--trace cannot be combined with --import" },
		{
			args: ["--replay-trace", "TRACE", "--export", "x"],
			message: "--replay-trace cannot be combined with --export",
		},
	])("rejects $args before any startup side effect", async ({ args, message }) => {
		const tracePath = join(dir, "run.trace.jsonl");
		await main(args.map((arg) => (arg === "TRACE" ? tracePath : arg)));

		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain(message);
		expectNoBootstrap();
		expect(existsSync(tracePath)).toBe(false);
	});

	it("reaches startup for other invocations, so the spies observe bootstrap", async () => {
		await expect(main(["--version"])).rejects.toThrow("process.exit");
		expect(bootstrap.handleOctoberLoginCommand).toHaveBeenCalled();
		expect(bootstrap.createBuiltInExtensions).toHaveBeenCalled();
	});
});
