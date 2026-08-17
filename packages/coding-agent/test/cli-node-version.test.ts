import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertSupportedNodeVersion,
	formatUnsupportedNodeMessage,
	isSupportedNodeVersion,
	MIN_NODE_VERSION,
} from "../src/cli-node-version.ts";
import { EACCES_USER_PREFIX_GUIDANCE, formatPackageManagerPermissionError } from "../src/config.ts";

describe("Node version preflight", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts Node 22.19+ and rejects older versions", () => {
		expect(isSupportedNodeVersion("22.19.0")).toBe(true);
		expect(isSupportedNodeVersion("22.20.1")).toBe(true);
		expect(isSupportedNodeVersion("23.0.0")).toBe(true);
		expect(isSupportedNodeVersion("22.18.0")).toBe(false);
		expect(isSupportedNodeVersion("20.19.5")).toBe(false);
		expect(MIN_NODE_VERSION).toBe("22.19.0");
		expect(formatUnsupportedNodeMessage("20.19.5")).toContain("october requires Node.js >= 22.19.0");
		expect(formatUnsupportedNodeMessage("20.19.5")).toContain("this is 20.19.5");
	});

	it("prints one sentence and exits 1 on Node 20", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		assertSupportedNodeVersion("20.11.0");
		expect(error).toHaveBeenCalledWith(
			"october requires Node.js >= 22.19.0 (this is 20.11.0). Install a current Node from https://nodejs.org or use the October installer.",
		);
		expect(exit).toHaveBeenCalledWith(1);
	});
});

describe("EACCES guidance", () => {
	it("replaces raw npm EACCES traces with installer / user-prefix guidance", () => {
		expect(formatPackageManagerPermissionError("npm ERR! code EACCES\nnpm ERR! syscall mkdir")).toBe(
			EACCES_USER_PREFIX_GUIDANCE,
		);
		expect(formatPackageManagerPermissionError("exited with code 23")).toBe("exited with code 23");
	});
});
