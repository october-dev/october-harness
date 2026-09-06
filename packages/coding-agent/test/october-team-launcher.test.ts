import { describe, expect, it } from "vitest";
import {
	defaultTeamAgentId,
	defaultTeamScopeId,
	parseTeamLaunchArgs,
	resolveBusReleaseAsset,
} from "../src/october-team-launcher.ts";

describe("October team launcher", () => {
	it("strips team-only flags and preserves normal October arguments", () => {
		expect(
			parseTeamLaunchArgs([
				"--team",
				"--team-scope=checkout",
				"--team-id",
				"reviewer",
				"--team-name",
				"Reviewer",
				"--team-connect-to",
				"planner",
				"--team-connect-to=builder",
				"--model",
				"openai/gpt-6-astra",
			]),
		).toEqual({
			requested: true,
			scope: "checkout",
			agentId: "reviewer",
			displayName: "Reviewer",
			connectTo: ["planner", "builder"],
			childArgs: ["--model", "openai/gpt-6-astra"],
		});
	});

	it("does not intercept an ordinary launch", () => {
		expect(parseTeamLaunchArgs(["--model", "october/Kimi-K2.7-Code"])).toEqual({
			requested: false,
			connectTo: [],
			childArgs: ["--model", "october/Kimi-K2.7-Code"],
		});
	});

	it("does not parse team flags after the option terminator", () => {
		expect(parseTeamLaunchArgs(["--model", "october/Kimi-K2.7-Code", "--", "--team", "--team-id=prompt"])).toEqual({
			requested: false,
			connectTo: [],
			childArgs: ["--model", "october/Kimi-K2.7-Code", "--", "--team", "--team-id=prompt"],
		});
	});

	it("rejects missing team flag values", () => {
		expect(() => parseTeamLaunchArgs(["--team", "--team-id"])).toThrow("--team-id requires a value");
		expect(() => parseTeamLaunchArgs(["--team-scope="])).toThrow("--team-scope requires a value");
	});

	it("maps every supported release target to a pinned checksum", () => {
		for (const [platform, architecture, suffix] of [
			["darwin", "arm64", "darwin_arm64.tar.gz"],
			["darwin", "x64", "darwin_amd64.tar.gz"],
			["linux", "arm64", "linux_arm64.tar.gz"],
			["linux", "x64", "linux_amd64.tar.gz"],
			["win32", "arm64", "windows_arm64.zip"],
			["win32", "x64", "windows_amd64.zip"],
		] as const) {
			const asset = resolveBusReleaseAsset(platform, architecture);
			expect(asset.name).toContain(suffix);
			expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(asset.executable).toBe(platform === "win32" ? "october-bus.exe" : "october-bus");
		}
		expect(() => resolveBusReleaseAsset("aix", "ppc64")).toThrow("does not publish");
	});

	it("derives stable project scope and terminal agent identities", () => {
		expect(defaultTeamScopeId("/work/Checkout App")).toMatch(/^checkout-app-[a-f0-9]{10}$/);
		expect(defaultTeamScopeId("/work/Checkout App")).toBe(defaultTeamScopeId("/work/Checkout App"));
		expect(defaultTeamAgentId("/work/Checkout App", 412)).toBe(defaultTeamAgentId("/work/Checkout App", 412));
		expect(defaultTeamAgentId("/work/Checkout App", 412)).toMatch(/^checkout-app-[a-f0-9]{8}$/);
	});
});
