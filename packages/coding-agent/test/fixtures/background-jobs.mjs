// Short local processes for the background-jobs example tests. Usage: node background-jobs.mjs <mode> [args...]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);

function write(stream, data) {
	return new Promise((resolve) => stream.write(data, resolve));
}

function keepAlive() {
	setInterval(() => {}, 1 << 30);
}

function spawnDescendant(descendantMode, stdio) {
	return spawn(process.execPath, [self, descendantMode], { stdio });
}

switch (mode) {
	case "wait":
		await write(process.stdout, "ready\n");
		keepAlive();
		break;
	case "sleep":
		keepAlive();
		break;
	case "tick":
		setInterval(() => process.stdout.write("tick\n"), 50);
		break;
	case "exit":
		await write(process.stdout, `exiting with ${args[0]}\n`);
		process.exit(Number(args[0]));
		break;
	case "exit-after":
		await delay(Number(args[0]));
		process.exit(Number(args[1] ?? 0));
		break;
	case "marker":
		writeFileSync(args[0], "started\n");
		keepAlive();
		break;
	case "lines": {
		const count = Number(args[0]);
		let text = "";
		for (let line = 1; line <= count; line++) text += `line ${line}\n`;
		await write(process.stdout, text);
		break;
	}
	case "flood": {
		// Write about `bytes` in total, alternating streams, honouring backpressure.
		const total = Number(args[0]);
		const line = `${"x".repeat(1023)}\n`;
		for (let written = 0; written < total; written += line.length) {
			await write(written % 2048 === 0 ? process.stdout : process.stderr, line);
		}
		break;
	}
	case "big-line":
		await write(process.stdout, "y".repeat(Number(args[0])));
		break;
	case "split-utf8": {
		// U+1F600 is F0 9F 98 80 in UTF-8 and a surrogate pair in JavaScript.
		const emoji = Buffer.from("\u{1F600}");
		await write(process.stdout, emoji.subarray(0, 2));
		await delay(50);
		await write(process.stderr, "E");
		await delay(50);
		await write(process.stdout, Buffer.concat([emoji.subarray(2), Buffer.from("\n")]));
		break;
	}
	case "grandchild": {
		// The grandchild inherits the output pipes and stays in the job's process group.
		const child = spawnDescendant("sleep", ["ignore", "inherit", "inherit"]);
		await write(process.stdout, `pids ${process.pid} ${child.pid}\n`);
		keepAlive();
		break;
	}
	case "leader-exit-quiet": {
		// The grandchild holds no output pipe, so pipe closure says nothing about it.
		const child = spawnDescendant("sleep", "ignore");
		child.unref();
		await write(process.stdout, `pids ${process.pid} ${child.pid}\n`);
		process.exit(0);
		break;
	}
	case "leader-exit-active": {
		// The grandchild keeps writing to the inherited pipes after the leader exits.
		const child = spawnDescendant("tick", ["ignore", "inherit", "inherit"]);
		child.unref();
		await write(process.stdout, `pids ${process.pid} ${child.pid}\n`);
		await delay(120);
		process.exit(0);
		break;
	}
	case "linger":
		// Bounded lifetime so an escaped test process cannot outlive the test run for long.
		setTimeout(() => process.exit(0), 30_000);
		break;
	case "escape": {
		// The descendant leaves the job's process group but keeps its output pipes open.
		const child = spawn(process.execPath, [self, "linger"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
		await write(process.stdout, `pids ${process.pid} ${child.pid}\n`);
		keepAlive();
		break;
	}
	default:
		process.stderr.write(`unknown mode: ${mode}\n`);
		process.exit(64);
}
