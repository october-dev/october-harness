import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDispatch } from "../src/extensions/penharness/fleet.ts";
import {
	findActiveHunt,
	findHunt,
	isActive,
	isPaused,
	pauseLoop,
	readLedger,
	resumeLoop,
	scaffoldHunt,
	scopeLooksAuthorized,
	stopLoop,
	summarizeLedger,
} from "../src/extensions/penharness/hunt.ts";

function authorizeScope(huntDir: string): void {
	fs.writeFileSync(
		path.join(huntDir, "scope.md"),
		"# Scope\n\n## Authorized targets\n\n- app.example.com\n\n## Explicitly out of scope\n\n- other.example.com\n",
	);
}

const tempDirs: string[] = [];

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penharness-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("penharness hunt scaffolding", () => {
	it("creates the full hunt layout and engages the loop", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "Example.com");

		expect(huntDir).toBe(path.join(base, "hunts", "example-com"));
		for (const file of ["scope.md", "brief.md", "findings.md", "dead-ends.md", "notes.md"]) {
			expect(fs.existsSync(path.join(huntDir, file))).toBe(true);
		}
		for (const dir of ["findings.d", "chains", "evidence", "report"]) {
			expect(fs.statSync(path.join(huntDir, dir)).isDirectory()).toBe(true);
		}
		expect(fs.existsSync(path.join(huntDir, "findings.d", "index.jsonl"))).toBe(true);
		expect(isActive(huntDir)).toBe(true);
		expect(isPaused(huntDir)).toBe(false);
	});

	it("never clobbers an existing scope.md on re-scaffold", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");
		const authored = "# Scope — example.com\n\n## Authorized targets\n\n- app.example.com\n";
		fs.writeFileSync(path.join(huntDir, "scope.md"), authored);

		const again = scaffoldHunt(base, "example.com");
		expect(again).toBe(huntDir);
		expect(fs.readFileSync(path.join(huntDir, "scope.md"), "utf-8")).toBe(authored);
	});

	it("tracks loop markers through pause / resume / stop", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");

		pauseLoop(huntDir);
		expect(isPaused(huntDir)).toBe(true);
		expect(findActiveHunt(base)).toBeNull();

		resumeLoop(huntDir);
		expect(isPaused(huntDir)).toBe(false);
		expect(isActive(huntDir)).toBe(true);

		stopLoop(huntDir);
		expect(isActive(huntDir)).toBe(false);
		expect(findActiveHunt(base)).toBeNull();
	});
});

describe("penharness hunt discovery", () => {
	it("finds a hunt nested under hunts/ and resolves the active one", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");

		expect(findHunt(base)).toBe(huntDir);
		expect(findActiveHunt(base)).toBe(huntDir);
	});

	it("finds a hunt when cwd is the hunt directory itself", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");

		expect(findHunt(huntDir)).toBe(huntDir);
		expect(findActiveHunt(huntDir)).toBe(huntDir);
	});

	it("returns null when there is no hunt", () => {
		const base = makeWorkspace();
		expect(findHunt(base)).toBeNull();
		expect(findActiveHunt(base)).toBeNull();
	});
});

describe("penharness ledger", () => {
	it("parses findings.d/index.jsonl tolerantly and counts dead ends", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");
		const lines = [
			JSON.stringify({ id: "cve-1", status: "confirmed", sev: "high", title: "SSRF", where: "/symbolicate" }),
			"this is not json",
			JSON.stringify({ id: "authz-1", status: "dead", sev: "n/a", title: "no cross-tenant" }),
			"",
		];
		fs.writeFileSync(path.join(huntDir, "findings.d", "index.jsonl"), lines.join("\n"));
		fs.writeFileSync(
			path.join(huntDir, "dead-ends.md"),
			"# Dead ends\n\n- tried X, needs write scope\n- tried Y, 403\n",
		);

		const ledger = readLedger(huntDir);
		expect(ledger.entries).toHaveLength(2);
		expect(ledger.byStatus).toEqual({ confirmed: 1, dead: 1 });
		expect(ledger.bySev.high).toBe(1);
		expect(ledger.deadEnds).toBe(2);

		const summary = summarizeLedger(huntDir);
		expect(summary).toContain("SSRF");
		expect(summary).toContain("confirmed: 1");
	});

	it("scopeLooksAuthorized is false for the template and true once a target is filled in", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");
		expect(scopeLooksAuthorized(huntDir)).toBe(false);

		fs.writeFileSync(
			path.join(huntDir, "scope.md"),
			"# Scope\n\n## Authorized targets\n\n- app.example.com\n\n## Explicitly out of scope\n\n- other.example.com\n",
		);
		expect(scopeLooksAuthorized(huntDir)).toBe(true);
	});
});

describe("penharness dispatch gate", () => {
	it("refuses to dispatch when there is no hunt in cwd", () => {
		const base = makeWorkspace();
		expect(() => prepareDispatch(base, ["probe one thing"])).toThrow("/hunt");
	});

	it("stays inert: refuses to dispatch until scope.md is authorized", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");
		// Freshly scaffolded hunt: scope.md is the unfilled template, so no active probing is allowed.
		expect(() => prepareDispatch(huntDir, ["probe one thing"])).toThrow(/scope\.md/);

		authorizeScope(huntDir);
		expect(prepareDispatch(huntDir, ["probe one thing"]).hypotheses).toEqual(["probe one thing"]);
	});

	it("rejects an empty batch but imposes no upper cap on batch size", () => {
		const base = makeWorkspace();
		const huntDir = scaffoldHunt(base, "example.com");
		authorizeScope(huntDir);

		expect(() => prepareDispatch(huntDir, ["   ", ""])).toThrow("No hypotheses");

		// No caps or quotas: a batch far larger than the default guidance is accepted whole.
		const many = Array.from({ length: 250 }, (_, i) => `hypothesis ${i}`);
		expect(prepareDispatch(huntDir, many).hypotheses).toHaveLength(250);
	});
});
