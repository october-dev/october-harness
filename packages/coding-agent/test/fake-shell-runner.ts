/**
 * In-memory shell runner that follows the BashOperations contract without starting processes.
 * It understands the small set of bash commands used by the runner tests.
 */

import { writeFileSync } from "node:fs";
import type { BashOperations } from "../src/core/tools/bash.ts";

export interface FakeShellCall {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
	timeout: number | undefined;
	hasStdin: boolean;
}

export interface FakeShellRunner {
	operations: BashOperations;
	calls: FakeShellCall[];
}

function waitForCancel(signal: AbortSignal | undefined, timeout: number | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer =
			timeout === undefined ? undefined : setTimeout(() => reject(new Error(`timeout:${timeout}`)), timeout * 1000);
		signal?.addEventListener(
			"abort",
			() => {
				if (timer) clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

export function createFakeShellRunner(): FakeShellRunner {
	const calls: FakeShellCall[] = [];
	const operations: BashOperations = {
		exec: async (command, cwd, { onData, onStderr, signal, timeout, env, stdin }) => {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}
			if (signal?.aborted) throw new Error("aborted");
			// Input can fail while the runner prepares; record it instead of crashing the process.
			let inputError: Error | undefined = stdin?.errored ?? undefined;
			const onInputError = (error: Error) => {
				inputError ??= error;
			};
			stdin?.on("error", onInputError);
			try {
				// Asynchronous preparation, like a runner checking its working directory.
				await new Promise((resolve) => setImmediate(resolve));
				if (signal?.aborted) throw new Error("aborted");
				if (inputError) throw new Error(`Failed to stream stdin to bash: ${inputError.message}`);
				return await run();
			} finally {
				stdin?.removeListener("error", onInputError);
			}

			async function run(): Promise<{ exitCode: number | null }> {
				calls.push({ command, cwd, env, timeout, hasStdin: stdin !== undefined });

				let settled = false;
				const out = (text: string) => {
					if (!settled) onData(Buffer.from(text));
				};
				const err = (text: string) => {
					if (!settled) (onStderr ?? onData)(Buffer.from(text));
				};
				try {
					const touch = /^touch (.+)$/.exec(command);
					if (touch) {
						writeFileSync(touch[1], "");
						return { exitCode: 0 };
					}
					const exit = /^exit (\d+)$/.exec(command);
					if (exit) return { exitCode: Number(exit[1]) };
					if (command === "kill -TERM $$") return { exitCode: 128 + 15 };
					if (command === "printf out; printf err >&2") {
						out("out");
						err("err");
						return { exitCode: 0 };
					}
					if (command === 'printf "%s|%s" "$PWD" "$CONTRACT_VAR"') {
						out(`${cwd}|${env?.CONTRACT_VAR ?? ""}`);
						return { exitCode: 0 };
					}
					if (command === "cat") {
						if (!stdin) return { exitCode: 0 };
						const chunks: Buffer[] = [];
						await Promise.race([
							new Promise<void>((resolve, reject) => {
								const onChunk = (chunk: Buffer | string) => chunks.push(Buffer.from(chunk));
								const detach = () => {
									stdin.removeListener("data", onChunk);
									stdin.removeListener("end", onEnd);
									stdin.removeListener("error", onError);
								};
								const onEnd = () => {
									detach();
									resolve();
								};
								const onError = (error: Error) => {
									detach();
									reject(new Error(`Failed to stream stdin to bash: ${error.message}`));
								};
								stdin.on("data", onChunk);
								stdin.once("end", onEnd);
								stdin.once("error", onError);
							}),
							waitForCancel(signal, timeout),
						]);
						out(Buffer.concat(chunks).toString());
						return { exitCode: 0 };
					}
					if (command === "printf a; sleep 10") {
						out("a");
						return await waitForCancel(signal, timeout);
					}
					if (command === "sleep 10") return await waitForCancel(signal, timeout);
					err(`fake runner: unsupported command ${command}\n`);
					return { exitCode: 127 };
				} finally {
					settled = true;
				}
			}
		},
	};
	return { operations, calls };
}
