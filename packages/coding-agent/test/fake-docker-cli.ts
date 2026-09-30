/**
 * Fake `docker` CLI for Docker shell runner tests. It records every invocation and simulates
 * `context inspect`, `run`, `rm` and `ps` against a state directory. `run` executes the command
 * with bash on this machine, using only the env file as the environment, to stand in for a container.
 *
 * State files (all optional): endpoint (default context), contexts.json, run-behavior, rm-behavior, ps-fail,
 * ps.json. `context inspect` follows the Docker CLI's context resolution order.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAKE_DOCKER_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const os = require("os");
const state = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
const read = (name, fallback) => {
	try {
		return fs.readFileSync(path.join(state, name), "utf8");
	} catch {
		return fallback;
	}
};
const entry = { executable: process.argv[1], argv: args, env: process.env, cwd: process.cwd() };
const log = () => fs.appendFileSync(path.join(state, "log.jsonl"), JSON.stringify(entry) + "\n");
const fail = (message, code) => {
	process.stderr.write(message + "\n");
	process.exit(code);
};
let i = 0;
let host;
let config;
while (i < args.length && args[i].startsWith("--")) {
	if (args[i] === "--host") host = args[i + 1];
	else if (args[i] === "--config") config = args[i + 1];
	i += 2;
}
const sub = args[i];
entry.sub = sub;
const rest = args.slice(i + 1);
const containers = path.join(state, "containers");
fs.mkdirSync(containers, { recursive: true });

if (sub === "context") {
	log();
	// Mirrors resolveContextName in docker/cli cli/command/cli.go: a non-empty DOCKER_HOST selects
	// the default context (backward-compatibility fallback), then DOCKER_CONTEXT, then the config's
	// currentContext. Docker's reference page lists DOCKER_CONTEXT first, but the CLI code does not.
	const contexts = JSON.parse(read("contexts.json", "{}"));
	// Only DOCKER_CONFIG is read, never ~/.docker, so tests cannot depend on the user's real config.
	let currentContext;
	try {
		const config = path.join(process.env.DOCKER_CONFIG, "config.json");
		currentContext = JSON.parse(fs.readFileSync(config, "utf8")).currentContext;
	} catch {}
	const contextName = process.env.DOCKER_HOST ? "default" : process.env.DOCKER_CONTEXT || currentContext || "default";
	const endpoint =
		contextName === "default"
			? process.env.DOCKER_HOST || read("endpoint", "unix:///fake/docker.sock").trim()
			: contexts[contextName];
	if (!endpoint) fail("context \"" + contextName + "\" does not exist", 1);
	process.stdout.write(endpoint + "\n");
	process.exit(0);
}

if (sub === "ps") {
	log();
	if (read("ps-fail", null) !== null) fail("Cannot connect to the Docker daemon at " + host + ". Is the docker daemon running?", 1);
	const filters = [];
	let format = "";
	for (let j = 0; j < rest.length; j++) {
		if (rest[j] === "--filter") filters.push(rest[++j].replace(/^label=/, ""));
		else if (rest[j] === "--format") format = rest[++j];
	}
	for (const c of JSON.parse(read("ps.json", "[]"))) {
		const matches = filters.every((f) => {
			const eq = f.indexOf("=");
			return eq < 0 ? f in c.labels : c.labels[f.slice(0, eq)] === f.slice(eq + 1);
		});
		if (!matches) continue;
		const line = format
			.replace(/\{\{json \.ID\}\}/g, JSON.stringify(c.id))
			.replace(/\{\{json \(\.Label "([^"]+)"\)\}\}/g, (_m, key) => JSON.stringify(c.labels[key] ?? ""));
		process.stdout.write(line + "\n");
	}
	process.exit(0);
}

if (sub === "rm") {
	log();
	const names = rest.filter((a) => !a.startsWith("-"));
	const behavior = read("rm-behavior", "").trim();
	if (behavior === "fail") fail("Cannot connect to the Docker daemon at " + host + ". Is the docker daemon running?", 1);
	if (behavior === "in-progress") fail("Error response from daemon: removal of container " + names[0] + " is already in progress", 1);
	let missing = false;
	for (const name of names) {
		const file = path.join(containers, name);
		if (fs.existsSync(file)) {
			fs.rmSync(file);
			process.stdout.write(name + "\n");
		} else {
			process.stderr.write("Error response from daemon: No such container: " + name + "\n");
			missing = true;
		}
	}
	process.exit(missing ? 1 : 0);
}

if (sub === "run") {
	const opts = {};
	const valued = new Set(["--name", "--label", "--user", "--mount", "-w", "--env-file", "--entrypoint"]);
	let interactive = false;
	let j = 0;
	while (j < rest.length) {
		const a = rest[j];
		if (valued.has(a)) {
			(opts[a] = opts[a] || []).push(rest[j + 1]);
			j += 2;
		} else if (a === "-i") {
			interactive = true;
			j++;
		} else if (a.startsWith("-")) j++;
		else break;
	}
	const command = rest[j + 2];
	const envFile = opts["--env-file"][0];
	const privateDir = path.dirname(envFile);
	const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
	const envContent = fs.readFileSync(envFile, "utf8");
	entry.run = {
		envFile: envContent,
		config: fs.readFileSync(path.join(config, "config.json"), "utf8"),
		modes: {
			dir: mode(privateDir),
			envFile: mode(envFile),
			configDir: mode(config),
			configFile: mode(path.join(config, "config.json")),
		},
		interactive,
	};
	log();
	const name = opts["--name"][0];
	const file = path.join(containers, name);
	const behavior = read("run-behavior", "").trim();
	if (behavior === "missing-image") fail("docker: Error response from daemon: No such image: " + rest[j] + ".", 125);
	if (behavior === "late-create") {
		const script = "setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(file) + ", ''), 400)";
		cp.spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" }).unref();
	} else {
		fs.writeFileSync(file, "");
	}
	if (behavior === "lock-private-dir") {
		fs.mkdirSync(path.join(privateDir, "locked"));
		fs.writeFileSync(path.join(privateDir, "locked", "file"), "");
		fs.chmodSync(path.join(privateDir, "locked"), 0o500);
	}
	const env = {};
	for (const line of envContent.split("\n")) {
		if (!line) continue;
		const eq = line.indexOf("=");
		env[line.slice(0, eq)] = line.slice(eq + 1);
	}
	if (env.PATH === undefined) env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
	const child = cp.spawn("/bin/bash", ["-c", command], {
		cwd: opts["-w"][0],
		env,
		stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"],
	});
	child.on("exit", (code, signal) => {
		try {
			fs.rmSync(file);
		} catch {}
		process.exit(code ?? 128 + (os.constants.signals[signal] || 0));
	});
} else if (sub !== "context" && sub !== "ps" && sub !== "rm") {
	fail("fake docker: unsupported command " + sub, 1);
}
`;

export interface FakeDockerCall {
	executable: string;
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	sub: string;
	run?: {
		envFile: string;
		config: string;
		modes: { dir: string; envFile: string; configDir: string; configFile: string };
		interactive: boolean;
	};
}

export interface FakeDocker {
	binDir: string;
	stateDir: string;
	executable: string;
	calls(sub?: string): FakeDockerCall[];
	set(name: string, content: string): void;
	containerExists(name: string): boolean;
}

export function installFakeDocker(root: string, binName = "bin"): FakeDocker {
	const binDir = join(root, binName);
	const stateDir = join(root, "docker-state");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(join(stateDir, "containers"), { recursive: true });
	const executable = join(binDir, "docker");
	writeFileSync(executable, FAKE_DOCKER_SOURCE);
	chmodSync(executable, 0o755);
	return {
		binDir,
		stateDir,
		executable,
		calls(sub) {
			const logPath = join(stateDir, "log.jsonl");
			if (!existsSync(logPath)) return [];
			const calls = readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeDockerCall);
			return sub ? calls.filter((call) => call.sub === sub) : calls;
		},
		set(name, content) {
			writeFileSync(join(stateDir, name), content);
		},
		containerExists(name) {
			return existsSync(join(stateDir, "containers", name));
		},
	};
}
