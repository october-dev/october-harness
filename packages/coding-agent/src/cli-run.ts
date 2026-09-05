/**
 * CLI body loaded after the Node version preflight in cli.ts.
 */
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
