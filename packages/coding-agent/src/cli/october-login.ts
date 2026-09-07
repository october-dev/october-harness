import chalk from "chalk";
import { APP_NAME, getAuthPath } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { logoutOctober } from "../extensions/october/auth.ts";
import { printOctoberDeviceCode, runOctoberDeviceCodeLogin } from "../extensions/october/device-code.ts";
import { loginOctoberWithStore, recoverOctoberTokenFile } from "../extensions/october/token-lifecycle.ts";

export function isOctoberLoginCommand(args: string[]): boolean {
	return args[0] === "login" && (args[1] === undefined || args[1] === "october" || args[1].startsWith("-"));
}

export function isOctoberLogoutCommand(args: string[]): boolean {
	return args[0] === "logout" && (args[1] === undefined || args[1] === "october" || args[1].startsWith("-"));
}

export function printOctoberLoginHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} login [october] [--no-browser]
  ${APP_NAME} logout [october]
  ${APP_NAME} logout --recovery-file <path>

Open october.dev, sign in to your October account, and approve the code shown in your terminal.
Use --no-browser to open the printed link yourself (for example, over SSH).
Logout revokes the CLI token before removing the stored credential.
Failed cleanup retains credentials and a private recovery journal for retry.
`);
}

export async function handleOctoberLoginCommand(args: string[]): Promise<boolean> {
	if (
		(isOctoberLoginCommand(args) || isOctoberLogoutCommand(args)) &&
		(args.includes("-h") || args.includes("--help"))
	) {
		printOctoberLoginHelp();
		return true;
	}
	if (isOctoberLogoutCommand(args)) {
		try {
			const recoveryIndex = args.indexOf("--recovery-file");
			if (recoveryIndex !== -1) {
				const path = args[recoveryIndex + 1];
				if (!path || path.startsWith("-")) throw new Error("--recovery-file requires a file path.");
				await recoverOctoberTokenFile(path);
				console.log(chalk.green("Recovered October tokens revoked. Current login unchanged."));
				return true;
			}
			const removed = await logoutOctober(getAuthPath());
			if (!removed) {
				console.error(chalk.yellow("No stored October credential or pending token to remove."));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green("Logged out of October."));
		} catch (error) {
			console.error(chalk.red(error instanceof Error ? error.message : "October logout failed."));
			process.exitCode = 1;
		}
		return true;
	}
	if (!isOctoberLoginCommand(args)) {
		return false;
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	try {
		await loginOctoberWithStore(
			AuthStorage.create(getAuthPath()),
			async () => ({
				type: "api_key",
				key: await runOctoberDeviceCodeLogin(
					{ onDeviceCode: printOctoberDeviceCode, signal: controller.signal },
					{ openBrowser: !args.includes("--no-browser") },
				),
			}),
			{ signal: controller.signal },
		);
		console.log(chalk.green("Signed in to October. You can use --provider october."));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", cancel);
	}
	return true;
}
