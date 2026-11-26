/**
 * CLI body loaded after the Node version preflight in cli.ts.
 */
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { launchOctoberTeam } from "./october-team-launcher.ts";

const args = process.argv.slice(2);
let teamExitCode: number | undefined;
try {
	teamExitCode = await launchOctoberTeam(args);
} catch (error) {
	console.error(`october --team: ${error instanceof Error ? error.message : String(error)}`);
	teamExitCode = 1;
}

if (teamExitCode === undefined) {
	// doctor configures the HTTP dispatcher in its own guarded probe setup, so a malformed proxy
	// environment is reported instead of aborting startup.
	setupCli({ http: args[0] !== "doctor" });
	// Awaited so the entry point owns main()'s whole output lifecycle. main() failures stay outside
	// the --team error boundary above.
	await main(args);
} else {
	process.exitCode = teamExitCode;
}
