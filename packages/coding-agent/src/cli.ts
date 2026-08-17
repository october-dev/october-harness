#!/usr/bin/env node
/**
 * CLI entry. The Node version check MUST run before undici (or any other
 * modern-Node import) loads — Node 20 dies with `markAsUncloneable`.
 * Dynamic import of cli-run.ts is required for that ordering.
 */
import { assertSupportedNodeVersion } from "./cli-node-version.ts";

assertSupportedNodeVersion();

await import("./cli-run.ts");
