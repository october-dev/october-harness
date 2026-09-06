/**
 * CLI body loaded after the Node version preflight in cli.ts.
 */
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { launchOctoberTeam } from "./october-team-launcher.ts";

try {
	const args = process.argv.slice(2);
	const teamExitCode = await launchOctoberTeam(args);
	if (teamExitCode === undefined) {
		setupCli();
		main(args);
	} else {
		process.exitCode = teamExitCode;
	}
} catch (error) {
	console.error(`october --team: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
