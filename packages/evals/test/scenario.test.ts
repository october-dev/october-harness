import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@october-dev/october";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverScenarios, loadScenario, writeRecordedScenario } from "../src/scenario.ts";
import { buildScenarioReport, formatScenarioMarkdown } from "../src/scenario-report.ts";
import { runScenario } from "../src/scenario-runner.ts";

const bundled = resolve(import.meta.dirname, "../scenarios");

describe("scenario evals", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-scenario-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function write(relativePath: string, content: string | object): void {
		const path = join(tempDir, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
	}

	const renameScenario = {
		formatVersion: 1,
		id: "test/rename",
		prompt: "Rename old to new in a.txt.",
		tools: ["edit"],
		faux: [
			{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] } } },
			{ text: "Done." },
		],
		expect: [{ file: "a.txt", contains: "new" }, { toolCalls: { name: "edit", min: 1, errors: 0 } }],
	};

	it("passes every bundled scenario with the faux model", async () => {
		const directories = await discoverScenarios(bundled);
		expect(directories.length).toBeGreaterThanOrEqual(2);
		for (const directory of directories) {
			const result = await runScenario(await loadScenario(directory));
			expect(result, result.id).toMatchObject({ passed: true, score: 1, errors: [] });
		}
	});

	it("fails checks when the run leaves the wrong end state", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [
				{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "old", newText: "wrong" }] } } },
				{ text: "Done." },
			],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(false);
		expect(result.score).toBe(0.5);
		expect(result.checks[0]).toMatchObject({ check: "file a.txt", passed: false, detail: 'missing "new"' });
	});

	it("counts a failing tool call as an error", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [
				{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "absent", newText: "x" }] } } },
				{ text: "Done." },
			],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.metrics).toMatchObject({ toolCalls: 1, toolErrors: 1 });
		expect(result.checks[1]).toMatchObject({ passed: false, detail: "1 errors, expected 0" });
	});

	it("reports a faux script the run never finished as a run error", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [{ text: "Stopping early." }, ...renameScenario.faux],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(false);
		expect(result.errors).toEqual(["2 faux step(s) were never requested; the run ended early."]);
	});

	it("runs in a copy and leaves the fixture untouched", async () => {
		write("s/scenario.json", renameScenario);
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(true);
		expect(readFileSync(join(tempDir, "s/workspace/a.txt"), "utf8")).toBe("old\n");
	});

	async function standInModel(steps: Parameters<FauxProviderHandle["setResponses"]>[0]) {
		const standIn = fauxProvider({
			api: "stand-in",
			provider: "stand-in",
			models: [{ id: "priced", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
		});
		standIn.setResponses(steps);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("stand-in", async () => ({ type: "api_key", key: "test-only" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(standIn.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		return { model: { provider: "stand-in", id: "priced" }, modelRuntime };
	}

	it("runs a model instead of the faux script and records a replayable transcript", async () => {
		// The scenario's own script is wrong, so a pass proves the selected model ran instead.
		write("s/scenario.json", { ...renameScenario, faux: [{ text: "Doing nothing." }] });
		write("s/workspace/a.txt", "old\n");
		const scenario = await loadScenario(join(tempDir, "s"));
		const options = await standInModel([
			fauxAssistantMessage(
				[
					fauxText("Renaming now."),
					fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Renamed."),
		]);

		const result = await runScenario(scenario, options);

		expect(result).toMatchObject({ mode: "model", model: "stand-in/priced", passed: true, errors: [] });
		expect(result.metrics.costUsd).toBe(0);
		expect(result.transcript).toEqual([
			{
				text: "Renaming now.",
				toolCalls: [{ name: "edit", args: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] } }],
			},
			{ text: "Renamed." },
		]);

		const recorded = await writeRecordedScenario(scenario, result.transcript, join(tempDir, "recorded"));
		expect(recorded).toBe(join(tempDir, "recorded", "test", "rename"));
		const replay = await runScenario(await loadScenario(recorded));
		expect(replay).toMatchObject({ mode: "faux", passed: true, errors: [] });
		expect(replay.metrics.costUsd).toBeNull();
	});

	it("rejects a model that is not configured", async () => {
		write("s/scenario.json", renameScenario);
		const { modelRuntime } = await standInModel([]);

		await expect(
			runScenario(await loadScenario(join(tempDir, "s")), {
				model: { provider: "stand-in", id: "missing" },
				modelRuntime,
			}),
		).rejects.toThrow("Scenario model not found: stand-in/missing");
	});

	const loadBundled = (id: string) => loadScenario(join(bundled, ...id.split("/")));

	it("fails the permission scenario when the gate is bypassed", async () => {
		const scenario = await loadBundled("core/permission-denial");

		const result = await runScenario({ ...scenario, permissionMode: "bypass" });

		expect(result.passed).toBe(false);
		expect(result.checks.find((check) => check.check === "file marker.txt is absent")?.passed).toBe(false);
		expect(process.env.OCTOBER_PERMISSION_MODE).toBeUndefined();
	});

	it("fails the Bus scenario when the reply is correlated to the wrong request", async () => {
		const scenario = await loadBundled("core/bus-response-correlation");
		const faux = scenario.faux.map((step) =>
			"toolCall" in step && step.toolCall.name.endsWith("message_peer")
				? { toolCall: { ...step.toolCall, args: { ...step.toolCall.args, responseTo: "msg-41" } } }
				: step,
		);

		const result = await runScenario({ ...scenario, faux });

		expect(result.passed).toBe(false);
		expect(result.checks[0]).toMatchObject({
			check: "Bus call message_peer",
			passed: false,
			detail: "0 matching of 1 message_peer call(s), expected 1",
		});
	});

	it("fails the context-pressure scenario without compaction", async () => {
		const { compaction: _compaction, ...scenario } = await loadBundled("core/context-pressure");

		const result = await runScenario(scenario);

		expect(result.passed).toBe(false);
		expect(result.checks[0]).toMatchObject({ check: "compactions", passed: false });
	});

	it("records the compaction summary so a compacting run replays", async () => {
		const scenario = await loadBundled("core/context-pressure");
		const result = await runScenario(scenario);
		expect(result.transcript).toHaveLength(3);

		const recorded = await writeRecordedScenario(scenario, result.transcript, join(tempDir, "recorded"));
		const replay = await runScenario(await loadScenario(recorded));

		expect(replay).toMatchObject({ passed: true, errors: [] });
	});

	it("hides host credentials from tools and restores them afterwards", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-scenario-test-secret";
		try {
			write("s/scenario.json", {
				formatVersion: 1,
				id: "test/no-credentials",
				prompt: "Print the key.",
				tools: ["bash"],
				faux: [
					{ toolCall: { name: "bash", args: { command: 'echo "key=$ANTHROPIC_API_KEY" > env.txt' } } },
					{ text: "Done." },
				],
				expect: [{ file: "env.txt", contains: "key=", notContains: "sk-scenario-test-secret" }],
			});

			const result = await runScenario(await loadScenario(join(tempDir, "s")));

			expect(result).toMatchObject({ passed: true, errors: [] });
			expect(process.env.ANTHROPIC_API_KEY).toBe("sk-scenario-test-secret");
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});

	it("skips dependencies and hidden directories when discovering scenarios", async () => {
		write("pack/real/scenario.json", renameScenario);
		write("pack/node_modules/dep/scenario.json", renameScenario);
		write("pack/.eval/old/scenario.json", renameScenario);

		expect(await discoverScenarios(join(tempDir, "pack"))).toEqual([join(tempDir, "pack/real")]);
	});

	it("checks files whose names start with two dots but rejects escapes", async () => {
		write("s/scenario.json", {
			...renameScenario,
			expect: [{ file: "..notes", contains: "kept" }],
		});
		write("s/workspace/a.txt", "old\n");
		write("s/workspace/..notes", "kept\n");
		const passing = await runScenario(await loadScenario(join(tempDir, "s")));
		expect(passing.checks[0]).toMatchObject({ passed: true });

		write("s/scenario.json", { ...renameScenario, expect: [{ file: "../escape.txt", exists: true }] });
		await expect(runScenario(await loadScenario(join(tempDir, "s")))).rejects.toThrow(
			"Check path escapes the workspace",
		);
	});

	it("rejects an invalid scenario with every problem path", async () => {
		write("s/scenario.json", { ...renameScenario, formatVersion: 2, sandbox: true, expect: [] });

		await expect(loadScenario(join(tempDir, "s"))).rejects.toThrow(/\/formatVersion[\s\S]*\/expect/);
	});

	it("summarizes results as Markdown with failures listed", async () => {
		write("s/scenario.json", { ...renameScenario, expect: [{ file: "a.txt", contains: "absent" }] });
		write("s/workspace/a.txt", "old\n");
		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		const markdown = formatScenarioMarkdown(buildScenarioReport([result], new Date("2026-01-01T00:00:00Z")));

		expect(markdown).toContain("0/1 scenarios passed.");
		expect(markdown).toContain("| test/rename | FAIL | 0.00 |");
		expect(markdown).toContain('- test/rename: file a.txt: missing "absent"');
	});
});
