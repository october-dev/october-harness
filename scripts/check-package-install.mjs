#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

function smokeTestExtensionTestingKit(directory) {
	const entry = join(directory, "coding-agent-testing-smoke.mjs");
	writeFileSync(
		entry,
		`import assert from "node:assert/strict";
import { Type } from "typebox";
import { createExtensionTestHarness, fauxAssistantMessage, fauxToolCall } from "${codingAgentName}/testing";

let executions = 0;
const harness = await createExtensionTestHarness({
  extensions: [(pi) => pi.registerTool({
    name: "installed_smoke",
    label: "Installed smoke",
    description: "Checks the installed public testing API",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, params) {
      executions++;
      return { content: [{ type: "text", text: params.value }], details: {} };
    },
  })],
  responses: [
    fauxAssistantMessage(fauxToolCall("installed_smoke", { value: "packed result" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ],
});
try {
  await harness.prompt("run the installed smoke tool");
  assert.equal(executions, 1);
  const result = harness.session.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") assert.equal(result.content[0]?.text, "packed result");
} finally {
  await harness.dispose();
}
`,
	);
	try {
		execFileSync(process.execPath, [entry], { cwd: directory, stdio: "inherit", timeout: 60_000 });
	} finally {
		rmSync(entry, { force: true });
	}
}

const root = mkdtempSync(join(tmpdir(), "pi-package-install-"));
try {
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot: process.cwd() });
	for (const pkg of artifactSet.packages) {
		const directory = join(root, "consumers", packageConsumerDirectoryName(pkg.name));
		installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
		smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
		if (pkg.name === codingAgentName) {
			smokeTestCodingAgent(directory);
			smokeTestExtensionTestingKit(directory);
		}
	}
	console.log(`Verified ${artifactSet.packages.length} isolated package consumers.`);
} finally {
	rmSync(root, { force: true, recursive: true });
}
