import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printAuthCommandHelp } from "../src/cli/auth-command.ts";
import { APP_NAME, CONFIG_DIR_NAME, PACKAGE_NAME } from "../src/config.ts";
import { getProviderLoginHelp } from "../src/core/auth-guidance.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");

describe("October package branding", () => {
	it.each([{ selectedTools: [] }, { selectedTools: ["read", "bash", "edit", "write"] }])(
		"separates runtime identity from Pi ancestry and project context with tools $selectedTools",
		({ selectedTools }) => {
			const prompt = buildSystemPrompt({
				cwd: "/projects/moirai",
				selectedTools,
				contextFiles: [
					{
						path: "/projects/moirai/AGENTS.md",
						content: "Moirai moves sessions between Pi, Codex, and Claude Code.",
					},
				],
			});
			expect(prompt).toContain("running in October Harness, October's coding agent");
			expect(prompt).toContain("Pi is the upstream project, not the name of this running harness");
			expect(prompt).toContain("I'm October Harness, October's coding agent, built on upstream Pi.");
			expect(prompt).toContain("No file reads or shell commands are needed to identify the harness");
			expect(prompt).toContain("The harness, the underlying model/provider, and the current project are distinct");
			expect(prompt).toContain("they do not determine this runtime's identity");
			expect(prompt).toContain("Do not infer the model/provider name from the harness name");
			expect(prompt).toContain("October Harness documentation (including inherited Pi features");
			expect(prompt).not.toContain("Pi documentation (read only");
			expect(prompt).toContain("Moirai moves sessions between Pi, Codex, and Claude Code.");
			expect(prompt.indexOf("Harness identity:")).toBeLessThan(prompt.indexOf("<project_context>"));
		},
	);

	it("preserves explicit custom system prompt replacement", () => {
		const prompt = buildSystemPrompt({
			cwd: "/projects/custom",
			customPrompt: "Custom application assistant.",
			appendSystemPrompt: "Additional application instructions.",
			contextFiles: [{ path: "/projects/custom/AGENTS.md", content: "Project instructions." }],
		});
		expect(prompt).toContain("Custom application assistant.");
		expect(prompt).toContain("Additional application instructions.");
		expect(prompt).toContain("Project instructions.");
		expect(prompt).not.toContain("Harness identity:");
	});

	it("owns package metadata and runtime identity", () => {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			name: string;
			homepage?: string;
			bugs?: { url?: string };
			repository?: { url?: string; directory?: string };
			files?: string[];
		};
		expect(pkg.name).toBe("@october-dev/october");
		expect(pkg.homepage).toBe("https://www.october.dev");
		expect(pkg.bugs?.url).toBe("https://github.com/october-dev/october-harness/issues");
		expect(pkg.repository?.url).toBe("git+https://github.com/october-dev/october-harness.git");
		expect(pkg.repository?.directory).toBe("packages/coding-agent");
		expect(pkg.files).toEqual([
			"dist",
			"!dist/client",
			"!dist/experimental",
			"!dist/cli/experimental",
			"docs",
			"CHANGELOG.md",
			"npm-shrinkwrap.json",
		]);
		expect(pkg.files).not.toContain("examples");
		const tsconfig = JSON.parse(readFileSync(join(dirname(packageJsonPath), "tsconfig.build.json"), "utf-8")) as {
			compilerOptions?: { inlineSources?: boolean };
		};
		expect(tsconfig.compilerOptions?.inlineSources).toBe(false);
		expect(PACKAGE_NAME).toBe("@october-dev/october");
		expect(APP_NAME).toBe("october");
		expect(CONFIG_DIR_NAME).toBe(".october");
	});

	it("points auth help and no-key guidance at October, not Pi", () => {
		expect(getProviderLoginHelp()).toContain("october login");
		expect(getProviderLoginHelp()).toContain("providers.md");
		expect(getProviderLoginHelp()).not.toContain("pi.dev");

		const lines: string[] = [];
		const log = console.log;
		console.log = (message?: unknown) => {
			lines.push(String(message ?? ""));
		};
		try {
			printAuthCommandHelp();
		} finally {
			console.log = log;
		}
		const help = lines.join("\n");
		expect(help).toContain("october auth print-api-key");
		expect(help).not.toMatch(/\bpi auth\b/);
	});
});
