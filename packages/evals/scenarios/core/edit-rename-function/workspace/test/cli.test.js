import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "../src/cli.js";

test("parses --key=value flags", () => {
	assert.deepEqual(parseCliArgs(["--mode=fast", "--retries=2"]), { mode: "fast", retries: "2" });
});
