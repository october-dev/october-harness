#!/usr/bin/env node
/**
 * CLI entry. `--version`/`-v` is handled here with Node builtins only so
 * Desktop's version gate stays exit-0 even on Node < 22.19 (undici would
 * crash). Every other argv still hits the Node-too-old preflight before
 * cli-run / undici load — Node 20 dies with `markAsUncloneable` otherwise.
 */
import { argvRequestsVersion, assertSupportedNodeVersion, printCliVersion } from "./cli-node-version.ts";

if (argvRequestsVersion(process.argv.slice(2))) {
	printCliVersion();
	process.exit(0);
}

assertSupportedNodeVersion();

await import("./cli-run.ts");
